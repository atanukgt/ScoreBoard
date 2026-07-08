import { matches, events } from './db.js';
import * as football from './sports/football.js';
import * as cricket from './sports/cricket.js';

const engines = { football, cricket };

// In-memory cache: matchId -> { config, sport, state, seq }
const live = new Map();

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
  };
  live.set(matchId, entry);
  return entry;
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
    const { matchId, token } = socket.handshake.auth || {};
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
        io.to(`match:${matchId}`).emit('state', snapshot(fresh, true));
        ack?.({ ok: true });
      } catch (e) {
        ack?.({ ok: false, error: e.message });
      }
    });
  });
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
