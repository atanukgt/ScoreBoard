import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'scoreboard.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  short_name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#1d4ed8',
  crest_path TEXT
);
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  ord INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  sport TEXT NOT NULL CHECK (sport IN ('football','cricket')),
  title TEXT,
  home_team_id INTEGER,
  away_team_id INTEGER,
  scheduled_at INTEGER,
  config TEXT NOT NULL,
  control_token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'live',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  at INTEGER NOT NULL,
  UNIQUE(match_id, seq)
);
CREATE TABLE IF NOT EXISTS tournaments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sport TEXT NOT NULL CHECK (sport IN ('football','cricket')),
  format TEXT NOT NULL DEFAULT 'league',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed')),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tournament_teams (
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  PRIMARY KEY (tournament_id, team_id)
);
CREATE TABLE IF NOT EXISTS tournament_matches (
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  round INTEGER NOT NULL DEFAULT 1,
  group_name TEXT,
  UNIQUE(match_id)
);
CREATE TABLE IF NOT EXISTS sponsors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  image_path TEXT NOT NULL,
  link TEXT,
  position TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL DEFAULT 8,
  active INTEGER NOT NULL DEFAULT 1,
  width INTEGER,
  height INTEGER,
  created_at INTEGER NOT NULL
);
`);

// ---- idempotent migrations for pre-existing DBs ----
// SQLite can't ADD CHECK constraints in ALTER, so we only ADD COLUMN here.
function tryAlter(sql) {
  try { db.exec(sql); } catch (e) { /* column already exists */ }
}
tryAlter(`ALTER TABLE tournaments ADD COLUMN format TEXT NOT NULL DEFAULT 'league'`);
tryAlter(`ALTER TABLE matches ADD COLUMN scheduled_at INTEGER`);
tryAlter(`ALTER TABLE sponsors ADD COLUMN width INTEGER`);
tryAlter(`ALTER TABLE sponsors ADD COLUMN height INTEGER`);

// ---- sponsor positions + recommended render sizes ----
// Used by both server (validation, fallback sizes) and clients (overlay slot
// positions). New positions can be added here without changing the DB schema
// (they all use the same width/height columns).
export const SPONSOR_POSITIONS = new Set([
  'top-left', 'top-right',
  'bottom-left', 'bottom-right',
  'top-banner', 'center-banner',
  'left-banner', 'right-banner',
]);
export const POSITION_DIMS = {
  'top-left':      { w: 360, h: 140 },
  'top-right':     { w: 360, h: 140 },
  'bottom-left':   { w: 360, h: 140 },
  'bottom-right':  { w: 360, h: 140 },
  'top-banner':    { w: 720, h: 100 },
  'center-banner': { w: 720, h: 160 },
  // Vertical sidebars — sized for a 1920×1080 canvas (skyscraper feel).
  'left-banner':   { w: 200, h: 540 },
  'right-banner':  { w: 200, h: 540 },
};
export function positionDefaults(position) {
  return POSITION_DIMS[position] || { w: 360, h: 140 };
}
export function clampDim(n, fallback) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v) || v <= 0) return fallback;
  // Sanity bounds — anything bigger than a 1920×1080 canvas is almost certainly a typo.
  return Math.max(40, Math.min(1920, v));
}

// ---- teams ----
export const teams = {
  list: () => db.prepare('SELECT * FROM teams ORDER BY name').all(),
  get: (id) => db.prepare('SELECT * FROM teams WHERE id = ?').get(id),
  create: ({ name, short_name, color }) =>
    db.prepare('INSERT INTO teams (name, short_name, color) VALUES (?, ?, ?)')
      .run(name, short_name, color || '#1d4ed8').lastInsertRowid,
  update: (id, { name, short_name, color }) =>
    db.prepare('UPDATE teams SET name = ?, short_name = ?, color = ? WHERE id = ?')
      .run(name, short_name, color, id),
  setCrest: (id, crest_path) =>
    db.prepare('UPDATE teams SET crest_path = ? WHERE id = ?').run(crest_path, id),
  remove: (id) => db.prepare('DELETE FROM teams WHERE id = ?').run(id),
};

// ---- players ----
export const players = {
  forTeam: (teamId) =>
    db.prepare('SELECT * FROM players WHERE team_id = ? ORDER BY ord').all(teamId),
  replaceForTeam: db.transaction((teamId, names) => {
    db.prepare('DELETE FROM players WHERE team_id = ?').run(teamId);
    const ins = db.prepare('INSERT INTO players (team_id, name, ord) VALUES (?, ?, ?)');
    names.forEach((name, i) => ins.run(teamId, name, i));
  }),
};

// ---- matches ----
export const matches = {
  list: () => db.prepare('SELECT * FROM matches ORDER BY created_at DESC').all(),
  get: (id) => db.prepare('SELECT * FROM matches WHERE id = ?').get(id),
  create: ({ sport, title, home_team_id, away_team_id, scheduled_at, config }) => {
    const id = crypto.randomBytes(4).toString('hex');
    const token = crypto.randomBytes(16).toString('hex');
    db.prepare(`INSERT INTO matches (id, sport, title, home_team_id, away_team_id, scheduled_at, config, control_token, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)`)
      .run(id, sport, title || null, home_team_id || null, away_team_id || null,
           scheduled_at || null, JSON.stringify(config), token, Date.now());
    return id;
  },
  setStatus: (id, status) =>
    db.prepare('UPDATE matches SET status = ? WHERE id = ?').run(status, id),
  setSchedule: (id, scheduled_at) =>
    db.prepare('UPDATE matches SET scheduled_at = ? WHERE id = ?').run(scheduled_at, id),
  updateConfig: (id, config) =>
    db.prepare('UPDATE matches SET config = ? WHERE id = ?').run(JSON.stringify(config), id),
  remove: (id) => db.prepare('DELETE FROM matches WHERE id = ?').run(id),
};

// ---- events (append-only log per match) ----
export const events = {
  forMatch: (matchId) =>
    db.prepare('SELECT seq, type, payload, at FROM events WHERE match_id = ? ORDER BY seq').all(matchId),
  append: (matchId, seq, type, payload, at) =>
    db.prepare('INSERT INTO events (match_id, seq, type, payload, at) VALUES (?, ?, ?, ?, ?)')
      .run(matchId, seq, type, JSON.stringify(payload || {}), at),
  deleteLast: (matchId) => {
    const row = db.prepare('SELECT seq FROM events WHERE match_id = ? ORDER BY seq DESC LIMIT 1').get(matchId);
    if (!row) return null;
    db.prepare('DELETE FROM events WHERE match_id = ? AND seq = ?').run(matchId, row.seq);
    return row.seq;
  },
};

// ---- tournaments ----
export const tournaments = {
  list: () => db.prepare('SELECT * FROM tournaments ORDER BY created_at DESC').all(),
  get: (id) => db.prepare('SELECT * FROM tournaments WHERE id = ?').get(id),
  create: ({ name, sport, format }) =>
    db.prepare('INSERT INTO tournaments (name, sport, format, status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(name, sport, format === 'single' ? 'single' : 'league', 'active', Date.now()).lastInsertRowid,
  setStatus: (id, status) =>
    db.prepare('UPDATE tournaments SET status = ? WHERE id = ?').run(status, id),
  remove: (id) => db.prepare('DELETE FROM tournaments WHERE id = ?').run(id),
};

export const tournamentTeams = {
  forTournament: (tId) =>
    db.prepare('SELECT team_id FROM tournament_teams WHERE tournament_id = ?').all(tId).map((r) => r.team_id),
  add: db.transaction((tId, teamId) => {
    db.prepare('INSERT OR IGNORE INTO tournament_teams (tournament_id, team_id) VALUES (?, ?)').run(tId, teamId);
  }),
  addMany: db.transaction((tId, teamIds) => {
    const ins = db.prepare('INSERT OR IGNORE INTO tournament_teams (tournament_id, team_id) VALUES (?, ?)');
    for (const teamId of teamIds) ins.run(tId, teamId);
  }),
  remove: (tId, teamId) =>
    db.prepare('DELETE FROM tournament_teams WHERE tournament_id = ? AND team_id = ?').run(tId, teamId),
  removeAllForTournament: (tId) =>
    db.prepare('DELETE FROM tournament_teams WHERE tournament_id = ?').run(tId),
};

export const tournamentMatches = {
  forTournament: (tId) =>
    db.prepare('SELECT tournament_id, match_id, round, group_name FROM tournament_matches WHERE tournament_id = ? ORDER BY round, match_id')
      .all(tId),
  get: (matchId) =>
    db.prepare('SELECT tournament_id, match_id, round, group_name FROM tournament_matches WHERE match_id = ?').get(matchId),
  add: (tId, matchId, { round = 1, group_name = null } = {}) =>
    db.prepare('INSERT OR IGNORE INTO tournament_matches (tournament_id, match_id, round, group_name) VALUES (?, ?, ?, ?)')
      .run(tId, matchId, round, group_name),
  removeForMatch: (matchId) =>
    db.prepare('DELETE FROM tournament_matches WHERE match_id = ?').run(matchId),
  removeAllForTournament: (tId) =>
    db.prepare('DELETE FROM tournament_matches WHERE tournament_id = ?').run(tId),
};

// ---- sponsors ----
export const sponsors = {
  list: (filter = {}) => {
    if (filter.activeOnly) {
      return db.prepare('SELECT * FROM sponsors WHERE active = 1 ORDER BY created_at DESC').all();
    }
    return db.prepare('SELECT * FROM sponsors ORDER BY created_at DESC').all();
  },
  get: (id) => db.prepare('SELECT * FROM sponsors WHERE id = ?').get(id),
  create: ({ name, image_path, link = null, position, interval_seconds = 8, active = 1,
            width = null, height = null }) =>
    db.prepare(`INSERT INTO sponsors (name, image_path, link, position, interval_seconds, active, width, height, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(name, image_path, link, position,
         Math.max(1, Math.min(600, interval_seconds | 0 || 8)),
         active ? 1 : 0, width, height, Date.now()).lastInsertRowid,
  update: (id, patch) => {
    const fields = [];
    const values = [];
    for (const k of ['name', 'link', 'position', 'interval_seconds', 'active', 'image_path', 'width', 'height']) {
      if (k in patch) { fields.push(`${k} = ?`); values.push(patch[k]); }
    }
    if (!fields.length) return;
    values.push(id);
    db.prepare(`UPDATE sponsors SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  },
  remove: (id) => db.prepare('DELETE FROM sponsors WHERE id = ?').run(id),
};

export default db;
