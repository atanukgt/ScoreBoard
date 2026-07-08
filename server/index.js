import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import { teams, players, matches, tournaments, tournamentTeams, tournamentMatches, sponsors, UPLOADS_DIR } from './db.js';
import { ADMIN_PASSWORD, makeSessionCookie, isAdminRequest, requireAdmin } from './auth.js';
import { setupSockets, invalidate } from './sockets.js';
import { computeStandings } from './tournament.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 3100;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });
setupSockets(io);

app.use(express.json({ limit: '3mb' }));
app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '1d' }));
app.use(express.static(PUBLIC_DIR));

// ---------- auth ----------
app.post('/api/login', (req, res) => {
  const pw = String(req.body?.password || '');
  const ok = pw.length === ADMIN_PASSWORD.length &&
    crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(ADMIN_PASSWORD));
  if (!ok) return res.status(401).json({ error: 'wrong password' });
  res.setHeader('Set-Cookie',
    `sb_admin=${makeSessionCookie()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${180 * 24 * 3600}`);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'sb_admin=; Path=/; HttpOnly; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => res.json({ admin: isAdminRequest(req) }));

// ---------- teams ----------
app.get('/api/teams', requireAdmin, (req, res) => {
  res.json(teams.list().map((t) => ({ ...t, players: players.forTeam(t.id).map((p) => p.name) })));
});
app.post('/api/teams', requireAdmin, (req, res) => {
  const { name, short_name, color } = req.body || {};
  if (!name || !short_name) return res.status(400).json({ error: 'name and short_name required' });
  const id = teams.create({ name, short_name: short_name.toUpperCase().slice(0, 4), color });
  res.json({ id });
});
app.put('/api/teams/:id', requireAdmin, (req, res) => {
  const t = teams.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const { name, short_name, color, players: names } = req.body || {};
  teams.update(t.id, {
    name: name ?? t.name,
    short_name: (short_name ?? t.short_name).toUpperCase().slice(0, 4),
    color: color ?? t.color,
  });
  if (Array.isArray(names)) {
    players.replaceForTeam(t.id, names.map((n) => String(n).trim()).filter(Boolean));
  }
  res.json({ ok: true });
});
app.delete('/api/teams/:id', requireAdmin, (req, res) => {
  teams.remove(req.params.id);
  res.json({ ok: true });
});

// Crest upload as data URL (PNG/JPEG/SVG/WebP, max ~2 MB)
app.post('/api/teams/:id/crest', requireAdmin, (req, res) => {
  const t = teams.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const m = /^data:image\/(png|jpeg|svg\+xml|webp);base64,(.+)$/.exec(req.body?.dataUrl || '');
  if (!m) return res.status(400).json({ error: 'expected image data URL (png/jpeg/svg/webp)' });
  const ext = { png: 'png', jpeg: 'jpg', 'svg+xml': 'svg', webp: 'webp' }[m[1]];
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 2 * 1024 * 1024) return res.status(400).json({ error: 'image too large (max 2 MB)' });
  const file = `crest-${t.id}-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, file), buf);
  if (t.crest_path) fs.rmSync(path.join(UPLOADS_DIR, t.crest_path), { force: true });
  teams.setCrest(t.id, file);
  res.json({ ok: true, crest_path: file });
});

// ---------- matches ----------
function teamSnapshot(teamId) {
  const t = teams.get(teamId);
  if (!t) throw new Error(`team ${teamId} not found`);
  return {
    name: t.name,
    short: t.short_name,
    color: t.color,
    crest: t.crest_path ? `/uploads/${t.crest_path}` : null,
    players: players.forTeam(t.id).map((p) => p.name),
  };
}

app.get('/api/matches', requireAdmin, (req, res) => {
  res.json(matches.list().map((m) => {
    const cfg = JSON.parse(m.config);
    return {
      id: m.id, sport: m.sport, title: m.title, status: m.status,
      created_at: m.created_at, scheduled_at: m.scheduled_at || null,
      control_token: m.control_token,
      home: cfg.teams.home.name, away: cfg.teams.away.name,
    };
  }));
});

app.post('/api/matches', requireAdmin, (req, res) => {
  const { sport, title, home_team_id, away_team_id, scheduled_at, options = {} } = req.body || {};
  if (!['football', 'cricket'].includes(sport)) return res.status(400).json({ error: 'sport must be football|cricket' });
  if (!home_team_id || !away_team_id) return res.status(400).json({ error: 'both teams required' });
  try {
    const config = {
      teams: { home: teamSnapshot(home_team_id), away: teamSnapshot(away_team_id) },
    };
    if (sport === 'cricket') {
      config.oversPerInnings = Math.max(1, Math.min(50, options.oversPerInnings | 0 || 20));
      config.playersPerSide = Math.max(2, Math.min(11, options.playersPerSide | 0 || 11));
      config.toss = {
        winner: options.tossWinner === 'away' ? 'away' : 'home',
        decision: options.tossDecision === 'bowl' ? 'bowl' : 'bat',
      };
    } else {
      config.halfMinutes = Math.max(1, Math.min(60, options.halfMinutes | 0 || 45));
    }
    // Accept scheduled_at as ISO string or epoch ms; clamp to integer ms.
    let sched = null;
    if (scheduled_at != null && scheduled_at !== '') {
      const n = typeof scheduled_at === 'string' ? Date.parse(scheduled_at) : Number(scheduled_at);
      if (Number.isFinite(n)) sched = n;
    }
    const id = matches.create({ sport, title, home_team_id, away_team_id, scheduled_at: sched, config });
    res.json({ id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/matches/:id', requireAdmin, (req, res) => {
  matches.remove(req.params.id);
  invalidate(req.params.id);
  res.json({ ok: true });
});

// Public match info for control/overlay pages (state itself flows over the socket)
app.get('/api/matches/:id/info', (req, res) => {
  const m = matches.get(req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  const cfg = JSON.parse(m.config);
  res.json({ id: m.id, sport: m.sport, title: m.title, status: m.status, config: cfg });
});

// ---------- tournaments ----------
function tournamentPayload(t) {
  const team_ids = tournamentTeams.forTournament(t.id);
  const tMatches = tournamentMatches.forTournament(t.id);
  return {
    ...t,
    team_ids,
    team_count: team_ids.length,
    match_count: tMatches.length,
    matches: tMatches,
  };
}

app.get('/api/tournaments', requireAdmin, (req, res) => {
  res.json(tournaments.list().map(tournamentPayload));
});
app.post('/api/tournaments', requireAdmin, (req, res) => {
  const { name, sport, format } = req.body || {};
  if (!name || !['football', 'cricket'].includes(sport)) {
    return res.status(400).json({ error: 'name and sport (football|cricket) required' });
  }
  const id = tournaments.create({
    name: String(name).trim(),
    sport,
    format: format === 'single' ? 'single' : 'league',
  });
  res.json({ id });
});
app.delete('/api/tournaments/:id', requireAdmin, (req, res) => {
  tournaments.remove(req.params.id);
  res.json({ ok: true });
});
app.put('/api/tournaments/:id', requireAdmin, (req, res) => {
  const t = tournaments.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const { status } = req.body || {};
  if (status && ['active', 'completed'].includes(status)) {
    tournaments.setStatus(t.id, status);
  }
  res.json(tournamentPayload(tournaments.get(t.id)));
});

app.post('/api/tournaments/:id/teams', requireAdmin, (req, res) => {
  const t = tournaments.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const team_ids = Array.isArray(req.body?.team_ids) ? req.body.team_ids : [];
  if (!team_ids.length) return res.status(400).json({ error: 'team_ids required' });
  const clean = [];
  for (const id of team_ids) {
    const tid = Number(id);
    if (!Number.isInteger(tid)) continue;
    if (!teams.get(tid)) continue;
    clean.push(tid);
  }
  if (!clean.length) return res.status(400).json({ error: 'no valid team ids' });
  tournamentTeams.addMany(t.id, clean);
  res.json(tournamentPayload(tournaments.get(t.id)));
});

app.delete('/api/tournaments/:id/teams/:teamId', requireAdmin, (req, res) => {
  const t = tournaments.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'tournament not found' });
  const tid = Number(req.params.teamId);
  if (!Number.isInteger(tid)) return res.status(400).json({ error: 'invalid team id' });
  tournamentTeams.remove(t.id, tid);
  res.json(tournamentPayload(tournaments.get(t.id)));
});

app.post('/api/tournaments/:id/matches', requireAdmin, (req, res) => {
  const t = tournaments.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const { match_id, round = 1, group_name = null } = req.body || {};
  if (!match_id) return res.status(400).json({ error: 'match_id required' });
  const m = matches.get(String(match_id));
  if (!m) return res.status(400).json({ error: 'match not found' });
  if (m.sport !== t.sport) return res.status(400).json({ error: `match sport (${m.sport}) != tournament sport (${t.sport})` });
  tournamentMatches.add(t.id, m.id, { round: round | 0 || 1, group_name: group_name || null });
  res.json(tournamentPayload(tournaments.get(t.id)));
});

app.get('/api/tournaments/:id/standings', (req, res) => {
  const t = tournaments.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  res.json(computeStandings(t.id));
});

// ---------- sponsors ----------
const SPONSOR_POSITIONS = new Set([
  'top-left', 'top-right', 'bottom-left', 'bottom-right', 'center-banner', 'top-banner',
]);

app.get('/api/sponsors', requireAdmin, (req, res) => {
  res.json(sponsors.list());
});
app.post('/api/sponsors', requireAdmin, (req, res) => {
  const { name, dataUrl, link = null, position, interval_seconds } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!position || !SPONSOR_POSITIONS.has(position)) {
    return res.status(400).json({ error: 'position must be one of ' + [...SPONSOR_POSITIONS].join('|') });
  }
  const m = /^data:image\/(png|jpeg|svg\+xml|webp|gif);base64,(.+)$/.exec(dataUrl || '');
  if (!m) return res.status(400).json({ error: 'expected image data URL (png/jpeg/svg/webp/gif)' });
  const ext = { png: 'png', jpeg: 'jpg', 'svg+xml': 'svg', webp: 'webp', gif: 'gif' }[m[1]];
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 2 * 1024 * 1024) return res.status(400).json({ error: 'image too large (max 2 MB)' });
  const file = `sponsor-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, file), buf);
  const id = sponsors.create({
    name: String(name).trim(),
    image_path: file,
    link: link ? String(link) : null,
    position,
    interval_seconds: interval_seconds | 0 || 8,
    active: 1,
  });
  res.json(sponsors.get(id));
});
app.put('/api/sponsors/:id', requireAdmin, (req, res) => {
  const s = sponsors.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const patch = {};
  const { name, link, position, interval_seconds, active, dataUrl } = req.body || {};
  if (typeof name === 'string') patch.name = name.trim();
  if (typeof link === 'string') patch.link = link.trim() || null;
  if (typeof position === 'string') {
    if (!SPONSOR_POSITIONS.has(position)) return res.status(400).json({ error: 'invalid position' });
    patch.position = position;
  }
  if (interval_seconds != null) patch.interval_seconds = Math.max(1, Math.min(600, interval_seconds | 0 || 8));
  if (active === 0 || active === 1 || active === true || active === false) {
    patch.active = active ? 1 : 0;
  }
  if (typeof dataUrl === 'string' && dataUrl) {
    const m = /^data:image\/(png|jpeg|svg\+xml|webp|gif);base64,(.+)$/.exec(dataUrl);
    if (!m) return res.status(400).json({ error: 'expected image data URL' });
    const ext = { png: 'png', jpeg: 'jpg', 'svg+xml': 'svg', webp: 'webp', gif: 'gif' }[m[1]];
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 2 * 1024 * 1024) return res.status(400).json({ error: 'image too large (max 2 MB)' });
    const file = `sponsor-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, file), buf);
    // best-effort: delete old image
    if (s.image_path) { try { fs.unlinkSync(path.join(UPLOADS_DIR, s.image_path)); } catch {} }
    patch.image_path = file;
  }
  sponsors.update(s.id, patch);
  res.json(sponsors.get(s.id));
});
app.delete('/api/sponsors/:id', requireAdmin, (req, res) => {
  const s = sponsors.get(req.params.id);
  if (!s) return res.json({ ok: true });
  if (s.image_path) { try { fs.unlinkSync(path.join(UPLOADS_DIR, s.image_path)); } catch {} }
  sponsors.remove(s.id);
  res.json({ ok: true });
});

// ---------- public read endpoints (used by overlays) ----------
app.get('/api/tournaments/:id/info', (req, res) => {
  const t = tournaments.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  res.json({
    id: t.id,
    name: t.name,
    sport: t.sport,
    status: t.status,
    created_at: t.created_at,
    team_count: tournamentTeams.forTournament(t.id).length,
    match_count: tournamentMatches.forTournament(t.id).length,
  });
});

// public sponsor listing (no auth) — used by sponsor overlay; respects ?active=1
app.get('/api/sponsors/public', (req, res) => {
  const activeOnly = req.query.active === '1' || req.query.active === 'true';
  res.json(sponsors.list(activeOnly ? { activeOnly: true } : {}));
});

// Public active-only sponsor list (for control page dropdown — no admin needed)
app.get('/api/sponsors/active', (req, res) => {
  res.json(sponsors.list({ activeOnly: true }));
});

// ---------- pages ----------
function servePage(dir) {
  return (req, res) => {
    const m = matches.get(req.params.id);
    if (!m) return res.status(404).send(notFoundPage(dir, req.params.id));
    res.sendFile(path.join(PUBLIC_DIR, dir, `${m.sport}.html`));
  };
}
function notFoundPage(dir, matchId) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const page = dir === 'control' ? 'control link' : 'overlay link';
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Match not found — Scoreboard Live</title>
<style>
  :root { --bg:#0f172a; --panel:#1e293b; --line:#334155; --text:#e2e8f0; --muted:#94a3b8; --accent:#38bdf8; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px;
         background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:32px;
          max-width:480px; width:100%; text-align:center; }
  h1 { margin:0 0 8px; font-size:22px; }
  p { color:var(--muted); margin:0 0 20px; line-height:1.5; font-size:14px; }
  code { background:rgba(0,0,0,.4); padding:2px 6px; border-radius:4px; font-size:12px; color:var(--accent); }
  .actions { display:flex; gap:10px; justify-content:center; flex-wrap:wrap; }
  a { background:var(--accent); color:#082f49; padding:10px 18px; border-radius:8px; text-decoration:none;
      font-weight:700; font-size:14px; }
  a.ghost { background:transparent; color:var(--accent); border:1px solid var(--accent); }
  .icon { font-size:42px; margin-bottom:8px; }
</style></head><body>
<div class="card">
  <div class="icon">🏏⚽</div>
  <h1>Match not found</h1>
  <p>The ${page} for <code>${esc(matchId)}</code> isn't valid — it may have been deleted, the URL is mistyped, or the match lives on a different server.</p>
  <div class="actions">
    <a href="/admin/">Go to admin</a>
    <a class="ghost" href="javascript:history.back()">Back</a>
  </div>
</div></body></html>`;
}
app.get('/control/:id', servePage('control'));
// Tournament & sponsor overlays — MUST be declared before /overlay/:id so
// /overlay/tournament/N doesn't get swallowed by the catch-all.
app.get('/overlay/tournament/:id', (req, res) => {
  const t = tournaments.get(req.params.id);
  if (!t) return res.status(404).send(notFoundPage('overlay', req.params.id));
  res.sendFile(path.join(PUBLIC_DIR, 'overlay', 'tournament.html'));
});
app.get('/overlay/sponsor', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'overlay', 'sponsor.html'));
});
app.get('/overlay/sponsor/:id', (req, res) => {
  // optional id param ignored — single global sponsor channel
  res.sendFile(path.join(PUBLIC_DIR, 'overlay', 'sponsor.html'));
});
app.get('/overlay/:id', servePage('overlay'));
app.get('/', (req, res) => res.redirect('/admin/'));

server.listen(PORT, () => {
  console.log(`Scoreboard Live running on http://localhost:${PORT}`);
});
