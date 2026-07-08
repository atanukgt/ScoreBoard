import { matches, events, sponsors } from './db.js';
import * as football from './sports/football.js';
import * as cricket from './sports/cricket.js';
import { isCompletedState } from './tournament.js';

const engines = { football, cricket };

// In-memory cache: matchId -> { config, sport, state, seq }
const live = new Map();

// In-memory featured-sponsor state. Operators in any control panel can fire
// `sponsor:feature` to highlight a sponsor on the overlay for N seconds.
// Stored as { sponsorId, until, sponsor: <row> } or null.
let featured = null;

function loadMatch(matchId) {
  if (live.has(matchId)) return live.get(matchId);
  const row = matches.get(matchId);
  if (!row) return null;
  const config = JSON.parse(row.config);
  const engine = engines[row.sport];
  const log = events.forMatch(matchId).map((e) => ({
    type: e.type, payload: JSON.parse(e.payload), at: e.at,
  }));
  const entry = {
    sport: row.sport,
    config,
    controlToken: row.control_token,
    state: engine.replay(config, log),
    seq: log.length,
    status: row.status,
  };
  live.set(matchId, entry);
  return entry;
}

// Keep matches.status in sync with the scored state:
// first ball flips 'scheduled' → 'live'; a completed state flips to 'finished'
// (and back to 'live' if the operator undoes past the end or extends the game).
function syncStatus(matchId, entry) {
  const want = isCompletedState(entry.sport, entry.state) ? 'finished' : 'live';
  if (entry.status !== want) {
    matches.setStatus(matchId, want);
    entry.status = want;
  }
}

function rebuild(matchId) {
  live.delete(matchId);
  return loadMatch(matchId);
}

export function invalidate(matchId) {
  live.delete(matchId);
}

export function setupSockets(io) {
  io.on('connection', (socket) => {
    const { matchId, token, role } = socket.handshake.auth || {};

    // Sponsor overlay: no matchId, joins the sponsor-overlay room only.
    if (role === 'sponsor-overlay') {
      socket.join('sponsor-overlay');
      if (featured && featured.until > Date.now()) {
        socket.emit('sponsor:feature', {
          sponsor: serializeSponsor(featured.sponsor),
          duration_seconds: Math.max(1, Math.ceil((featured.until - Date.now()) / 1000)),
          until: featured.until,
        });
      }
      return;
    }

    const entry = loadMatch(matchId);
    if (!entry) {
      socket.emit('err', { error: 'match not found' });
      return socket.disconnect(true);
    }
    const isControl = token && token === entry.controlToken;
    socket.join(`match:${matchId}`);
    socket.emit('state', snapshot(entry, isControl));

    socket.on('action', (msg, ack) => {
      if (!isControl) return ack?.({ ok: false, error: 'control token required' });
      try {
        const fresh = loadMatch(matchId);
        const engine = engines[fresh.sport];
        const event = { type: msg.type, payload: msg.payload || {}, at: Date.now() };
        const nextState = engine.reduce(fresh.state, event); // throws if invalid
        fresh.seq += 1;
        events.append(matchId, fresh.seq, event.type, event.payload, event.at);
        fresh.state = nextState;
        syncStatus(matchId, fresh);
        io.to(`match:${matchId}`).emit('state', snapshot(fresh, true));
        ack?.({ ok: true });
      } catch (e) {
        ack?.({ ok: false, error: e.message });
      }
    });

    socket.on('undo', (ack) => {
      if (!isControl) return ack?.({ ok: false, error: 'control token required' });
      try {
        const removed = events.deleteLast(matchId);
        if (removed === null) return ack?.({ ok: false, error: 'nothing to undo' });
        const fresh = rebuild(matchId);
        syncStatus(matchId, fresh);
        io.to(`match:${matchId}`).emit('state', snapshot(fresh, true));
        ack?.({ ok: true });
      } catch (e) {
        ack?.({ ok: false, error: e.message });
      }
    });

    // Operator triggers: highlight a sponsor on the global sponsor overlay for N seconds.
    // The overlay listens on the `sponsor-overlay` room. We also broadcast `sponsor:cleared`
    // when the feature window expires.
    socket.on('sponsor:feature', (msg, ack) => {
      if (!isControl) return ack?.({ ok: false, error: 'control token required' });
      const sponsorId = Number(msg?.sponsor_id);
      const duration = Math.max(2, Math.min(60, Number(msg?.duration_seconds) || 8));
      const row = Number.isInteger(sponsorId) ? sponsors.get(sponsorId) : null;
      if (!row || !row.active) return ack?.({ ok: false, error: 'sponsor not found or inactive' });
      const until = Date.now() + duration * 1000;
      featured = { sponsorId, until, sponsor: row };
      io.to('sponsor-overlay').emit('sponsor:feature', {
        sponsor: serializeSponsor(row),
        duration_seconds: duration,
        until,
      });
      ack?.({ ok: true, until });
      // Schedule a clear event so the overlay knows when to fall back to rotation.
      setTimeout(() => {
        if (featured && featured.until === until) {
          featured = null;
          io.to('sponsor-overlay').emit('sponsor:cleared');
        }
      }, duration * 1000);
    });

    socket.on('sponsor:clear', (ack) => {
      if (typeof ack !== 'function') ack = undefined; // tolerate stray payload args
      if (!isControl) return ack?.({ ok: false, error: 'control token required' });
      if (featured) {
        featured = null;
        io.to('sponsor-overlay').emit('sponsor:cleared');
      }
      ack?.({ ok: true });
    });
  });
}

// Sponsor overlay connects without a matchId/token but joins the broadcast room
// so it can receive `sponsor:feature` / `sponsor:cleared`. We expose a thin
// shim by allowing handshake { role: 'sponsor-overlay' } to also land here.
function serializeSponsor(row) {
  return {
    id: row.id,
    name: row.name,
    image_path: row.image_path,
    image_url: `/uploads/${row.image_path}`,
    link: row.link,
    position: row.position,
    interval_seconds: row.interval_seconds,
  };
}

function snapshot(entry, isControl) {
  return {
    sport: entry.sport,
    state: entry.state,
    seq: entry.seq,
    now: Date.now(), // lets overlay clocks sync to server time
    control: !!isControl,
  };
}
