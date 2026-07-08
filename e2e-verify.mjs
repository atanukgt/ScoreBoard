// e2e verification script for Scoreboard Live
// Usage:
//   FB_MATCH=... CR_MATCH=... node e2e-verify.mjs

import { io } from 'socket.io-client';
import { strict as assert } from 'node:assert';

const BASE = process.env.BASE || 'http://localhost:3100';
const FB_MATCH = process.env.FB_MATCH;
const CR_MATCH = process.env.CR_MATCH;

const log = (...a) => console.log('[e2e]', ...a);
const pass = (name) => log('  PASS', name);

function open(matchId, token) {
  return io(BASE, {
    transports: ['websocket'],
    auth: { matchId, token: token || '' },
    reconnection: false,
    forceNew: true,
  });
}

// Race-free client: every sendAndWait() registers the listener BEFORE the
// action is sent, so we never miss the broadcast.
function makeClient(matchId, token) {
  const sock = open(matchId, token);
  let latest = null;
  let rejectAll = null;

  function nextState(ms = 5000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        sock.off('state', onState);
        reject(new Error('next state timeout'));
      }, ms);
      const onState = (s) => { clearTimeout(t); sock.off('state', onState); resolve(s); };
      sock.on('state', onState);
    });
  }

  sock.on('state', (s) => { latest = s; });
  sock.on('err', (e) => { if (rejectAll) rejectAll(new Error('err: ' + JSON.stringify(e))); });

  function sendAction(type, payload = {}) {
    return new Promise((resolve, reject) => {
      sock.emit('action', { type, payload }, (ack) => {
        if (!ack || !ack.ok) return reject(new Error(ack?.error || 'no ack'));
        resolve(ack);
      });
    });
  }
  function sendUndo() {
    return new Promise((resolve, reject) => {
      sock.emit('undo', (ack) => {
        if (!ack || !ack.ok) return reject(new Error(ack?.error || 'no ack'));
        resolve(ack);
      });
    });
  }
  function sendActionAndWait(type, payload = {}) {
    const p = nextState();
    return sendAction(type, payload).then(() => p);
  }
  function sendUndoAndWait() {
    const p = nextState();
    return sendUndo().then(() => p);
  }

  return {
    socket: sock,
    get state() { return latest; },
    waitForInitial() {
      if (latest) return Promise.resolve(latest);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('initial state timeout')), 3000);
        const onState = (s) => { clearTimeout(t); sock.off('state', onState); resolve(s); };
        sock.on('state', onState);
      });
    },
    sendAction, sendUndo, sendActionAndWait, sendUndoAndWait, nextState,
    close() { sock.disconnect(); },
  };
}

async function main() {
  log('FB_MATCH=', FB_MATCH, 'CR_MATCH=', CR_MATCH);
  if (!FB_MATCH || !CR_MATCH) throw new Error('set FB_MATCH and CR_MATCH env vars');

  // Parse cookie jar
  const fs = await import('fs');
  const cookieFile = fs.readFileSync('/tmp/sb-cookies.txt', 'utf8');
  const cookieHeader = cookieFile
    .split('\n')
    .filter(l => l && l.trim().length && !l.startsWith('# '))
    .map(l => {
      const stripped = l.startsWith('#HttpOnly_') ? l.slice('#HttpOnly_'.length) : l.replace(/^#/, '');
      const f = stripped.split('\t');
      if (f.length < 7) return null;
      return `${f[5]}=${f[6]}`;
    })
    .filter(Boolean).join('; ');
  const matchesAuth = await (await fetch(`${BASE}/api/matches`, { headers: { Cookie: cookieHeader } })).json();
  if (!Array.isArray(matchesAuth)) throw new Error('matches not array: ' + JSON.stringify(matchesAuth));
  const fbInfo = matchesAuth.find((m) => m.id === FB_MATCH);
  const crInfo = matchesAuth.find((m) => m.id === CR_MATCH);
  if (!fbInfo || !crInfo) throw new Error('matches not in admin list');
  const FB_TOKEN = fbInfo.control_token;
  const CR_TOKEN = crInfo.control_token;
  log('FB_TOKEN=', FB_TOKEN.slice(0, 8) + '…');
  log('CR_TOKEN=', CR_TOKEN.slice(0, 8) + '…');

  // ================================================================
  // 1. FOOTBALL
  // ================================================================
  log('--- Football end-to-end ---');
  const ovl = makeClient(FB_MATCH, '');
  const ctrl = makeClient(FB_MATCH, FB_TOKEN);
  const s0 = await ctrl.waitForInitial();
  assert.equal(s0.sport, 'football');
  assert.equal(s0.control, true);
  assert.equal(s0.state.period, 'PRE');
  assert.equal(s0.state.score.home, 0);
  assert.equal(s0.state.score.away, 0);
  pass('control initial state');

  const ovlS0 = await ovl.waitForInitial();
  assert.equal(ovlS0.control, false, 'overlay control=false');
  pass('overlay read-only');

  // 1b. Period + clock
  let s = await ctrl.sendActionAndWait('setPeriod', { period: '1H' });
  assert.equal(s.state.period, '1H');
  assert.equal(s.state.clock.elapsedMs, 0);
  assert.equal(s.state.clock.running, false);
  pass('setPeriod 1H');

  s = await ctrl.sendActionAndWait('startClock', {});
  assert.equal(s.state.clock.running, true);
  pass('startClock');

  // tick: setClock 0:00 — the clock keeps running, elapsed resets to 0 and starts again
  await new Promise((r) => setTimeout(r, 60));
  s = await ctrl.sendActionAndWait('setClock', { minutes: 0, seconds: 0 });
  assert.equal(s.state.clock.running, true, 'setClock does not stop the clock');
  assert.equal(s.state.clock.elapsedMs, 0, 'elapsed reset to 0');
  pass('setClock tick (clock still running, elapsed reset)');

  // 1c. Goals
  s = await ctrl.sendActionAndWait('goal', { team: 'home', scorer: 'Chhetri' });
  assert.equal(s.state.score.home, 1);
  assert.equal(s.state.scorers[0].name, 'Chhetri');
  await ovl.waitForInitial().then(() => null);
  // overlay should have received the broadcast (same room) — verify by waiting for the seq
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(ovl.state.state.score.home, 1, 'overlay saw home=1');
  pass('goal home via control, overlay receives');

  s = await ctrl.sendActionAndWait('goal', { team: 'away', scorer: 'Cahill' });
  assert.equal(s.state.score.away, 1);
  pass('goal away');

  // 1d. Card
  s = await ctrl.sendActionAndWait('card', { team: 'home', color: 'y', delta: 1 });
  assert.equal(s.state.cards.home.y, 1);
  pass('card yellow home');

  // 1e. Stoppage
  s = await ctrl.sendActionAndWait('stoppage', { minutes: 2 });
  assert.equal(s.state.stoppage, 2);
  pass('stoppage 2 min');

  // 1f. 2H — clock resets to 45:00 paused
  s = await ctrl.sendActionAndWait('setPeriod', { period: '2H' });
  assert.equal(s.state.period, '2H');
  assert.equal(s.state.clock.elapsedMs, 45 * 60 * 1000);
  assert.equal(s.state.clock.running, false);
  pass('setPeriod 2H resets clock');

  // 1g. setClock 75:00
  s = await ctrl.sendActionAndWait('setClock', { minutes: 75, seconds: 0 });
  assert.equal(s.state.clock.elapsedMs, 75 * 60 * 1000);
  pass('setClock 75:00');

  // 1h. adjustScore -1 away
  s = await ctrl.sendActionAndWait('adjustScore', { team: 'away', delta: -1 });
  assert.equal(s.state.score.away, 0);
  pass('adjustScore -1 away');

  // 1i. undo (seq goes down)
  const seqBefore = ctrl.state.seq;
  s = await ctrl.sendUndoAndWait();
  assert.equal(s.state.score.away, 1, 'undo: away=1 again');
  assert.ok(s.seq < seqBefore, 'undo decrements seq');
  pass('undo restores last event (seq goes down)');

  // 1j. Replay determinism: close + reopen control
  ctrl.close();
  const ctrl2 = makeClient(FB_MATCH, FB_TOKEN);
  const replayed = await ctrl2.waitForInitial();
  assert.equal(replayed.state.score.home, 1);
  assert.equal(replayed.state.score.away, 1);
  assert.equal(replayed.state.period, '2H');
  assert.equal(replayed.state.clock.elapsedMs, 75 * 60 * 1000);
  assert.equal(replayed.state.cards.home.y, 1);
  assert.equal(replayed.state.scorers.length, 2);
  pass('replay determinism (overlay refresh)');

  // 1k. PENS + shootout kicks
  s = await ctrl2.sendActionAndWait('setPeriod', { period: 'PENS' });
  assert.equal(s.state.period, 'PENS');
  s = await ctrl2.sendActionAndWait('shootoutKick', { team: 'home', scored: true });
  assert.equal(s.state.shootout.home[0], 'G');
  s = await ctrl2.sendActionAndWait('shootoutKick', { team: 'away', scored: false });
  assert.equal(s.state.shootout.away[0], 'X');
  pass('penalty shootout kicks');

  // 1l. unknown match id
  const ghost = open('00000000', '');
  const ghostErr = await new Promise((resolve) => {
    ghost.once('err', (e) => resolve({ err: e }));
    ghost.once('state', () => resolve({ state: true }));
    setTimeout(() => resolve({ timeout: true }), 2000);
  });
  ghost.disconnect();
  assert.ok(ghostErr.err, 'unknown match returns err');
  pass('unknown match id rejected');

  // 1m. wrong token = read-only + actions denied
  const wrong = makeClient(FB_MATCH, 'deadbeef');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(wrong.state.control, false, 'wrong token = overlay');
  let denied = false;
  let deniedMsg = '';
  try { await wrong.sendAction('goal', { team: 'home' }); }
  catch (e) { denied = true; deniedMsg = e.message; }
  assert.ok(denied, 'wrong-token actions are denied by server');
  assert.ok(/control token required/.test(deniedMsg), `expected control-token-required error, got: ${deniedMsg}`);
  // also verify state didn't change
  assert.equal(ctrl2.state.state.score.home, 1, 'score unchanged after wrong-token action');
  wrong.close();
  pass('wrong token: read-only + action rejected with explicit error');

  ctrl2.close();
  ovl.close();

  // ================================================================
  // 2. CRICKET — full lifecycle
  // ================================================================
  log('--- Cricket end-to-end ---');
  const cctrl = makeClient(CR_MATCH, CR_TOKEN);
  const covl  = makeClient(CR_MATCH, '');
  const cs0 = await cctrl.waitForInitial();
  assert.equal(cs0.sport, 'cricket');
  assert.equal(cs0.control, true);
  assert.equal(cs0.state.phase, 'setup');
  const cos0 = await covl.waitForInitial();
  assert.equal(cos0.control, false);
  pass('cricket initial state');

  // 2a. startInnings
  let cs = await cctrl.sendActionAndWait('startInnings', {
    striker: 'Rohit', nonStriker: 'Ishan', bowler: 'Deepak',
  });
  assert.equal(cs.state.phase, 'live');
  let inn0 = cs.state.innings[0];
  assert.equal(inn0.batsmen[inn0.striker].name, 'Rohit');
  assert.equal(inn0.batsmen[inn0.nonStriker].name, 'Ishan');
  assert.equal(inn0.bowlers[inn0.bowler].name, 'Deepak');
  pass('startInnings sets up openers + bowler');

  // 2b. balls: 0, 1, 4, 6, wd+2, nb+2, b3 (last is 6th legal — ends over)
  cs = await cctrl.sendActionAndWait('ball', { runs: 0 });
  assert.equal(cs.state.innings[0].runs, 0);
  assert.equal(cs.state.innings[0].balls, 1);
  assert.equal(cs.state.innings[0].thisOver[0], '0');
  pass('dot ball');

  cs = await cctrl.sendActionAndWait('ball', { runs: 1 });
  assert.equal(cs.state.innings[0].batsmen[cs.state.innings[0].striker].name, 'Ishan');
  pass('single rotates strike');

  cs = await cctrl.sendActionAndWait('ball', { runs: 4 });
  assert.equal(cs.state.flash && cs.state.flash.kind, '4');
  assert.equal(cs.state.innings[0].runs, 5, '0+1+4=5');
  pass('FOUR flash');

  cs = await cctrl.sendActionAndWait('ball', { runs: 6 });
  assert.equal(cs.state.flash && cs.state.flash.kind, '6');
  assert.equal(cs.state.innings[0].runs, 11, '5+6=11');
  pass('SIX flash');

  cs = await cctrl.sendActionAndWait('ball', { runs: 2, extra: 'wd' });
  assert.equal(cs.state.innings[0].runs, 14, '11+1+2=14');
  assert.equal(cs.state.innings[0].extras.wd, 3, '1 penalty + 2 extra');
  assert.equal(cs.state.innings[0].balls, 4, 'wide not legal');
  pass('wide +2');

  cs = await cctrl.sendActionAndWait('ball', { runs: 2, extra: 'nb' });
  assert.equal(cs.state.innings[0].runs, 17, '14+1+2=17');
  assert.equal(cs.state.innings[0].extras.nb, 1);
  assert.equal(cs.state.innings[0].balls, 4, 'no-ball not legal (still 4)');
  pass('no-ball +2');

  // 5th legal ball — a 0
  cs = await cctrl.sendActionAndWait('ball', { runs: 0 });
  assert.equal(cs.state.innings[0].balls, 5);

  // 6th legal ball — byes 3, ends the over
  cs = await cctrl.sendActionAndWait('ball', { runs: 3, extra: 'b' });
  assert.equal(cs.state.innings[0].extras.b, 3);
  assert.equal(cs.state.innings[0].balls, 6, '6th legal ball');
  assert.equal(cs.state.innings[0].pendingBowler, true);
  pass('byes legal, over ends, pendingBowler');

  // 2c. newBowler Tushar
  cs = await cctrl.sendActionAndWait('newBowler', { name: 'Tushar' });
  assert.equal(cs.state.innings[0].bowlers[cs.state.innings[0].bowler].name, 'Tushar');
  assert.equal(cs.state.innings[0].pendingBowler, false);
  pass('newBowler Tushar');

  // 2d. maiden over for Tushar — 6 dots
  for (let i = 0; i < 6; i++) cs = await cctrl.sendActionAndWait('ball', { runs: 0 });
  const tushar = cs.state.innings[0].bowlers.find((b) => b.name === 'Tushar');
  assert.equal(tushar.maidens, 1);
  assert.equal(cs.state.innings[0].pendingBowler, true, 'over done, pendingBowler set');
  pass('maiden over credited');

  // 2e. consecutive-over guard — try to set Tushar again
  let blocked = false;
  let blockedMsg = '';
  try { await cctrl.sendAction('newBowler', { name: 'Tushar' }); }
  catch (e) { blocked = true; blockedMsg = e.message; }
  assert.ok(blocked, 'consecutive-over guard fires');
  assert.ok(/consecutive/.test(blockedMsg), `expected consecutive error, got: ${blockedMsg}`);
  pass('consecutive-over guard');

  // 2f. New bowler, then a bowled wicket
  cs = await cctrl.sendActionAndWait('newBowler', { name: 'Pathirana' });
  cs = await cctrl.sendActionAndWait('ball', { runs: 0, wicket: { kind: 'bowled' } });
  assert.equal(cs.state.innings[0].wickets, 1);
  assert.equal(cs.state.flash && cs.state.flash.kind, 'W');
  const outBatsman = cs.state.innings[0].batsmen.find((b) => b.out && b.outDesc.startsWith('b Pathirana'));
  assert.ok(outBatsman, 'batsman out b Pathirana');
  assert.equal(cs.state.innings[0].pendingBatsman, true);
  assert.equal(cs.state.innings[0].bowlers.find((b) => b.name === 'Pathirana').wickets, 1);
  pass('bowled wicket, pendingBatsman, bowler credited');

  // 2g. newBatsman on strike
  cs = await cctrl.sendActionAndWait('newBatsman', { name: 'Surya', onStrike: true });
  assert.equal(cs.state.innings[0].batsmen[cs.state.innings[0].striker].name, 'Surya');
  assert.equal(cs.state.innings[0].pendingBatsman, false);
  pass('newBatsman Surya on strike');

  // 2h. run out — non-striker out, 2 runs completed
  cs = await cctrl.sendActionAndWait('ball', { runs: 2, wicket: { kind: 'runout', who: 'nonStriker', fielder: 'Dhoni' } });
  assert.equal(cs.state.innings[0].wickets, 2);
  assert.equal(cs.state.innings[0].bowlers.find((b) => b.name === 'Pathirana').wickets, 1,
    'Pathirana NOT credited for run-out');
  pass('run-out (non-striker): runs credited, bowler not credited');

  // 2i. undo the wicket
  cs = await cctrl.sendUndoAndWait();
  assert.equal(cs.state.innings[0].wickets, 1);
  pass('undo wicket');

  // 2j. Drive inn1 to close by overs (5 overs = 30 legal balls)
  // We have 12 legal balls done (over 1 = 6, over 2 = 6, no balls in over 3 yet).
  // Actually wait — over 3 (Tushar maiden) gave 6 more legal = 18.
  // Then over 4 (Pathirana) has bowled 1 legal (the wicket) = 19.
  // Need 11 more legal balls to reach 30.
  let safety = 200;
  while (cs.state.phase === 'live' && cs.state.innings[0].balls < 30 && safety-- > 0) {
    if (cs.state.innings[0].pendingBowler) {
      const cur = cs.state.innings[0].bowlers[cs.state.innings[0].bowler]?.name;
      const nextB = ['Chahar', 'Chahar2', 'Mukesh', 'Theekshana', 'Deepak', 'Tushar', 'Pathirana']
        .find((n) => n !== cur);
      cs = await cctrl.sendActionAndWait('newBowler', { name: nextB });
    } else {
      cs = await cctrl.sendActionAndWait('ball', { runs: 0 });
    }
  }
  assert.equal(cs.state.phase, 'inningsBreak', `phase=${cs.state.phase}`);
  assert.equal(cs.state.innings[0].balls, 30);
  assert.equal(typeof cs.state.target, 'number');
  pass('1st innings closed by overs, target set');

  // 2k. start 2nd innings
  cs = await cctrl.sendActionAndWait('startInnings', {
    striker: 'Gaikwad', nonStriker: 'Conway', bowler: 'Bumrah',
  });
  assert.equal(cs.state.phase, 'live');
  assert.equal(cs.state.innings[1].battingTeam, 'away', 'CSK chasing');
  pass('startInnings 2 (chase)');

  // 2l. Chase to win
  safety = 300;
  while (cs.state.phase === 'live' && safety-- > 0) {
    if (cs.state.innings[1].pendingBowler) {
      const cur = cs.state.innings[1].bowlers[cs.state.innings[1].bowler]?.name;
      const nextB = ['Bumrah', 'Boult', 'Richardson', 'Hardik', 'Krunal'].find((n) => n !== cur);
      cs = await cctrl.sendActionAndWait('newBowler', { name: nextB });
    } else if (cs.state.innings[1].pendingBatsman) {
      const used = new Set(cs.state.innings[1].batsmen.map((b) => b.name));
      const pool = ['Dhoni', 'Jadeja', 'Moeen', 'Rayudu', 'Deepak', 'Tushar', 'Mukesh', 'Pathirana', 'Theekshana'];
      const next = pool.find((n) => !used.has(n)) || pool[0];
      cs = await cctrl.sendActionAndWait('newBatsman', { name: next, onStrike: true });
    } else {
      const needed = cs.state.target - cs.state.innings[1].runs;
      const runs = Math.min(6, Math.max(1, needed));
      cs = await cctrl.sendActionAndWait('ball', { runs });
    }
  }
  assert.equal(cs.state.phase, 'finished', `phase=${cs.state.phase}`);
  assert.ok(cs.state.result && /won|tied/.test(cs.state.result), `result: ${cs.state.result}`);
  pass('chase complete: ' + cs.state.result);

  // 2m. undo after result
  cs = await cctrl.sendUndoAndWait();
  assert.notEqual(cs.state.phase, 'finished');
  pass('undo after result re-opens match');

  // 2n. replay determinism — close & reopen
  cctrl.close();
  const cctrl2 = makeClient(CR_MATCH, CR_TOKEN);
  const creplay = await cctrl2.waitForInitial();
  assert.equal(creplay.state.innings[0].balls, 30);
  assert.ok(creplay.state.innings[1]);
  pass('cricket replay determinism');

  cctrl2.close();
  covl.close();

  log('ALL TESTS PASSED');
  process.exit(0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
