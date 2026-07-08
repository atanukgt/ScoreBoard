// E2E smoke for the tournament + sponsor deliverable.
// - starts the server on a fresh DATA_DIR + random PORT
// - exercises: login → teams → tournament → matches → goal events → FT
//   → standings → sponsor upload + listing
// - exits 0 on success, 1 on any failure
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { setTimeout as wait } from 'timers/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-smoke-'));
const PORT = 3100 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;

function log(...a) { console.log('[smoke]', ...a); }
function fail(msg) { console.error('[smoke] FAIL:', msg); process.exit(1); }

function req(method, urlPath, { cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      method, hostname: '127.0.0.1', port: PORT, path: urlPath,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(buf); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: json ?? buf });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, DATA_DIR, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
server.stdout.on('data', (c) => { serverOut += c.toString(); process.stdout.write('[srv] ' + c); });
server.stderr.on('data', (c) => { serverOut += c.toString(); process.stderr.write('[srv!] ' + c); });

async function waitForReady() {
  for (let i = 0; i < 60; i++) {
    if (serverOut.includes('running on')) return;
    await wait(100);
  }
  fail('server did not become ready: ' + serverOut);
}

async function login() {
  const r = await req('POST', '/api/login', { body: { password: 'changeme' } });
  if (r.status !== 200) fail(`login status ${r.status}`);
  const setCookie = r.headers['set-cookie'] || [];
  const sb = setCookie.map((c) => c.split(';')[0]).find((c) => c.startsWith('sb_admin='));
  if (!sb) fail('no sb_admin cookie returned');
  return sb;
}

async function makeTeam(cookie, name, short, color) {
  const r = await req('POST', '/api/teams', { cookie, body: { name, short_name: short, color } });
  if (r.status !== 200) fail(`team create ${name}: ${r.status}`);
  return r.body.id;
}

async function makeMatch(cookie, homeId, awayId) {
  const r = await req('POST', '/api/matches', {
    cookie, body: {
      sport: 'football', home_team_id: homeId, away_team_id: awayId,
      options: { halfMinutes: 5 },
    },
  });
  if (r.status !== 200) fail(`match create: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id;
}

(async () => {
  await waitForReady();

  // 1. login
  const cookie = await login();
  log('logged in');

  // 2. create 4 teams
  const t1 = await makeTeam(cookie, 'Alpha', 'ALP', '#f00');
  const t2 = await makeTeam(cookie, 'Bravo', 'BRV', '#00f');
  const t3 = await makeTeam(cookie, 'Charlie', 'CHA', '#0a0');
  const t4 = await makeTeam(cookie, 'Delta', 'DEL', '#ff0');
  log('4 teams:', t1, t2, t3, t4);

  // 3. create tournament
  const tRes = await req('POST', '/api/tournaments', { cookie, body: { name: 'Smoke League', sport: 'football' } });
  if (tRes.status !== 200) fail('tournament create');
  const tid = tRes.body.id;
  log('tournament', tid);

  // 4. add 4 teams
  const teamsRes = await req('POST', `/api/tournaments/${tid}/teams`, { cookie, body: { team_ids: [t1, t2, t3, t4] } });
  if (teamsRes.status !== 200) fail('add teams');
  log('added 4 teams to tournament');

  // 5. create 6 football matches round-robin
  const pairings = [[t1,t2],[t1,t3],[t1,t4],[t2,t3],[t2,t4],[t3,t4]];
  const matchIds = [];
  for (const [h, a] of pairings) {
    const mid = await makeMatch(cookie, h, a);
    matchIds.push(mid);
    const ar = await req('POST', `/api/tournaments/${tid}/matches`, {
      cookie, body: { match_id: mid, round: 1, group_name: null },
    });
    if (ar.status !== 200) fail(`attach match ${mid}`);
  }
  log('6 matches created and attached');

  // 6. get control_token + drive scores via socket.io-client
  const { io } = await import('socket.io-client');
  const listRes = await req('GET', '/api/matches', { cookie });
  const list = listRes.body;
  const idToToken = new Map(list.map((m) => [m.id, m.control_token]));

  // Scores for the 6 matches (mix of wins/draws/losses)
  // 1v2: 1-0 (home win), 1v3: 2-2 (draw), 1v4: 0-1 (away win),
  // 2v3: 3-0 (home win), 2v4: 1-1 (draw), 3v4: 0-2 (away win)
  const scores = [
    [1, 0], [2, 2], [0, 1], [3, 0], [1, 1], [0, 2],
  ];

  for (let i = 0; i < matchIds.length; i++) {
    const mid = matchIds[i];
    const tok = idToToken.get(mid);
    const [hg, ag] = scores[i];
    const sock = io(BASE, { auth: { matchId: mid, token: tok }, transports: ['websocket', 'polling'] });
    await new Promise((resolve, reject) => {
      sock.on('connect', resolve);
      sock.on('connect_error', reject);
      setTimeout(() => reject(new Error('socket connect timeout')), 5000);
    });
    // goal events
    const scoreTeam = (team, count) => {
      for (let j = 0; j < count; j++) {
        sock.emit('action', { type: 'goal', payload: { team } });
      }
    };
    scoreTeam('home', hg);
    scoreTeam('away', ag);
    // set FT
    sock.emit('action', { type: 'setPeriod', payload: { period: 'FT' } });
    await wait(300);
    sock.disconnect();
  }
  log('driven scores + FT on all 6 matches');

  // 7. standings
  const sRes = await req('GET', `/api/tournaments/${tid}/standings`);
  if (sRes.status !== 200) fail(`standings status ${sRes.status}`);
  if (!Array.isArray(sRes.body) || sRes.body.length !== 4) fail('standings not array of 4');
  for (const row of sRes.body) {
    if (typeof row.points !== 'number') fail(`row missing points: ${JSON.stringify(row)}`);
  }
  log('standings:', JSON.stringify(sRes.body.map((r) => `${r.name}=${r.points}`)));

  // 8. sponsor CRUD
  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
  const spRes = await req('POST', '/api/sponsors', {
    cookie, body: {
      name: 'Smoke Sponsor', dataUrl: tinyPng, link: 'https://example.com',
      position: 'top-right', interval_seconds: 6,
    },
  });
  if (spRes.status !== 200) fail(`sponsor create: ${spRes.status} ${JSON.stringify(spRes.body)}`);
  const sid = spRes.body.id;
  log('sponsor created', sid);

  const list2 = await req('GET', '/api/sponsors', { cookie });
  if (list2.status !== 200 || !list2.body.find((s) => s.id === sid)) fail('sponsor not listed');
  log('sponsor listed');

  const delRes = await req('DELETE', `/api/sponsors/${sid}`, { cookie });
  if (delRes.status !== 200) fail('sponsor delete');
  const list3 = await req('GET', '/api/sponsors', { cookie });
  if (list3.body.find((s) => s.id === sid)) fail('sponsor not removed');
  log('sponsor deleted');

  // 9. overlay pages reachable
  const ovT = await req('GET', `/overlay/tournament/${tid}`);
  if (ovT.status !== 200) fail(`overlay tournament ${ovT.status}`);
  if (!ovT.body.includes('Pos') || !ovT.body.includes('Team') || !ovT.body.includes('Pts')) {
    fail('overlay tournament missing column headers');
  }
  log('overlay/tournament HTML ok');

  const ovS = await req('GET', '/overlay/sponsor');
  if (ovS.status !== 200) fail(`overlay sponsor ${ovS.status}`);
  for (const pos of ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'top-banner', 'center-banner']) {
    if (!ovS.body.includes(`data-pos="${pos}"`)) fail(`overlay sponsor missing slot ${pos}`);
  }
  if (!ovS.body.includes('/api/sponsors/public')) fail('overlay sponsor missing fetch URL');
  log('overlay/sponsor HTML ok');

  // 10. cleanup
  server.kill('SIGINT');
  await wait(500);
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}

  log('SMOKE PASS');
  process.exit(0);
})().catch((e) => {
  console.error('[smoke] CRASH', e);
  server.kill('SIGINT');
  process.exit(1);
});