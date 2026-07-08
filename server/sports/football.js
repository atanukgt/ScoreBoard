// Football scoreboard engine — pure reducer over an append-only event log.
// Every event carries `at` (server epoch ms) so the clock can be reconstructed
// deterministically when the log is replayed (e.g. after undo or a restart).

// Period keys and where the match clock starts for each (in minutes).
export const PERIODS = {
  PRE:  { label: 'Kick-off', base: 0,   running: false },
  '1H': { label: '1st Half', base: 0,   running: true },
  HT:   { label: 'Half Time', base: 45, running: false },
  '2H': { label: '2nd Half', base: 45,  running: true },
  FT:   { label: 'Full Time', base: 90, running: false },
  ET1:  { label: 'Extra Time 1', base: 90,  running: true },
  ETB:  { label: 'ET Break', base: 105, running: false },
  ET2:  { label: 'Extra Time 2', base: 105, running: true },
  AET:  { label: 'After Extra Time', base: 120, running: false },
  PENS: { label: 'Penalties', base: 120, running: false },
};

export function initialState(config) {
  return {
    sport: 'football',
    config,
    score: { home: 0, away: 0 },
    cards: { home: { y: 0, r: 0 }, away: { y: 0, r: 0 } },
    cardLog: [], // [{ team, color, name, minute, at }] — ordered history of every card issued
    scorers: [],
    period: 'PRE',
    // Clock: elapsedMs accumulated while paused; when running, add (now - startedAt).
    clock: { running: false, elapsedMs: 0, startedAt: null },
    stoppage: 0,
    shootout: null, // { home: ['G','X',...], away: [...] } G=scored X=missed
    lastGoal: null, // { team, name, minute, at } — overlay shows briefly
    lastCard: null, // { team, color, name, minute, at } — overlay banner shows briefly
  };
}

export function clockElapsedMs(state, now) {
  const c = state.clock;
  return c.elapsedMs + (c.running ? Math.max(0, now - c.startedAt) : 0);
}

export function displayMinute(state, now) {
  return Math.floor(clockElapsedMs(state, now) / 60000) + 1; // football convention: 1st minute is "1'"
}

export function reduce(state, event) {
  const s = structuredClone(state);
  const { type, payload = {}, at } = event;

  switch (type) {
    case 'goal': {
      requireTeam(payload.team);
      s.score[payload.team] += 1;
      const minute = displayMinute(s, at);
      const entry = { team: payload.team, name: payload.scorer || '', minute, at };
      s.scorers.push(entry);
      s.lastGoal = entry;
      return s;
    }
    case 'adjustScore': {
      requireTeam(payload.team);
      s.score[payload.team] = Math.max(0, s.score[payload.team] + (payload.delta | 0));
      if ((payload.delta | 0) < 0 && s.scorers.length) {
        // removing a goal also drops the most recent scorer entry for that team
        for (let i = s.scorers.length - 1; i >= 0; i--) {
          if (s.scorers[i].team === payload.team) { s.scorers.splice(i, 1); break; }
        }
        s.lastGoal = null;
      }
      return s;
    }
    case 'card': {
      requireTeam(payload.team);
      const kind = payload.color === 'r' ? 'r' : 'y';
      const delta = payload.delta | 0;
      s.cards[payload.team][kind] = Math.max(0, s.cards[payload.team][kind] + delta);
      if (delta > 0) {
        // Issuing a card — push to log and update lastCard.
        const entry = {
          team: payload.team,
          color: kind,
          name: payload.name || '',
          minute: displayMinute(s, at),
          at,
        };
        s.cardLog.push(entry);
        s.lastCard = entry;
      } else if (delta < 0) {
        // Removing a card — drop the most recent matching log entry so the
        // "recent cards" list mirrors the counter (and the overlay banner
        // re-derives correctly from the truncated log).
        for (let i = s.cardLog.length - 1; i >= 0; i--) {
          const e = s.cardLog[i];
          if (e.team === payload.team && e.color === kind) {
            s.cardLog.splice(i, 1);
            break;
          }
        }
        if (s.lastCard && s.lastCard.team === payload.team && s.lastCard.color === kind) {
          s.lastCard = s.cardLog[s.cardLog.length - 1] || null;
        }
      }
      return s;
    }
    case 'setPeriod': {
      const p = PERIODS[payload.period];
      if (!p) throw new Error(`unknown period ${payload.period}`);
      s.period = payload.period;
      s.clock = { running: false, elapsedMs: p.base * 60000, startedAt: null };
      s.stoppage = 0;
      if (payload.period === 'PENS' && !s.shootout) s.shootout = { home: [], away: [] };
      return s;
    }
    case 'startClock': {
      if (!s.clock.running) { s.clock.running = true; s.clock.startedAt = at; }
      return s;
    }
    case 'pauseClock': {
      if (s.clock.running) {
        s.clock.elapsedMs += Math.max(0, at - s.clock.startedAt);
        s.clock.running = false;
        s.clock.startedAt = null;
      }
      return s;
    }
    case 'setClock': { // manual correction, payload.minutes / payload.seconds
      const ms = ((payload.minutes | 0) * 60 + (payload.seconds | 0)) * 1000;
      s.clock.elapsedMs = ms;
      if (s.clock.running) s.clock.startedAt = at;
      return s;
    }
    case 'stoppage': {
      s.stoppage = Math.max(0, payload.minutes | 0);
      return s;
    }
    case 'shootoutKick': {
      requireTeam(payload.team);
      if (!s.shootout) s.shootout = { home: [], away: [] };
      s.shootout[payload.team].push(payload.scored ? 'G' : 'X');
      return s;
    }
    case 'clearLastGoal': {
      s.lastGoal = null;
      return s;
    }
    case 'clearLastCard': {
      s.lastCard = null;
      return s;
    }
    case 'reset':
      return initialState(s.config);
    default:
      throw new Error(`unknown football event: ${type}`);
  }
}

function requireTeam(team) {
  if (team !== 'home' && team !== 'away') throw new Error('team must be home|away');
}

export function replay(config, eventList) {
  let s = initialState(config);
  for (const e of eventList) s = reduce(s, e);
  return s;
}
