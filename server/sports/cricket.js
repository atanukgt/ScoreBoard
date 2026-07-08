// Cricket ball-by-ball engine — pure reducer over an append-only event log.
//
// Config shape (snapshotted into the match at creation time):
// {
//   oversPerInnings: 20,
//   playersPerSide: 11,
//   teams: { home: { name, short, color, crest, players: [...] }, away: {...} },
//   toss: { winner: 'home'|'away', decision: 'bat'|'bowl' }
// }
//
// Ball event payload:
//   { runs, extra: null|'wd'|'nb'|'b'|'lb', wicket: null|{ kind, who: 'striker'|'nonStriker' } }
// `runs` is what the batsmen physically ran (bat runs for normal/nb, extra runs
// beyond the 1-run penalty for wd, byes for b/lb). Penalties are added here.

const BOWLER_CREDITED = new Set(['bowled', 'caught', 'lbw', 'stumped', 'hitwicket']);
export const WICKET_KINDS = ['bowled', 'caught', 'lbw', 'runout', 'stumped', 'hitwicket'];

export function battingTeamForInnings(config, inningsIdx) {
  const { winner, decision } = config.toss;
  const other = winner === 'home' ? 'away' : 'home';
  const first = decision === 'bat' ? winner : other;
  return inningsIdx === 0 ? first : (first === 'home' ? 'away' : 'home');
}

export function initialState(config) {
  return {
    sport: 'cricket',
    config,
    phase: 'setup', // setup -> live -> inningsBreak -> live -> finished
    currentInnings: 0,
    innings: [],
    target: null,
    result: null,
    flash: null, // { kind: '4'|'6'|'W'|'50'|'100', text, at } — overlay animation hook
  };
}

function newInnings(config, idx) {
  const batting = battingTeamForInnings(config, idx);
  return {
    battingTeam: batting,
    bowlingTeam: batting === 'home' ? 'away' : 'home',
    runs: 0,
    wickets: 0,
    balls: 0, // legal deliveries
    extras: { wd: 0, nb: 0, b: 0, lb: 0 },
    batsmen: [],  // { name, runs, balls, fours, sixes, out, outDesc }
    bowlers: [],  // { name, balls, maidens, runs, wickets }
    striker: null,
    nonStriker: null,
    bowler: null,
    prevBowler: null,
    overRunsAgainstBowler: 0,
    thisOver: [], // symbols for the current over, e.g. ['1','4','W','1wd']
    pendingBatsman: false,
    pendingBowler: false,
    fow: [], // { wicket, runs, over, batsman }
    closed: false,
  };
}

function addBatsman(inn, name) {
  inn.batsmen.push({ name, runs: 0, balls: 0, fours: 0, sixes: 0, out: false, outDesc: '' });
  return inn.batsmen.length - 1;
}

function findOrAddBowler(inn, name) {
  const i = inn.bowlers.findIndex((b) => b.name === name);
  if (i >= 0) return i;
  inn.bowlers.push({ name, balls: 0, maidens: 0, runs: 0, wickets: 0 });
  return inn.bowlers.length - 1;
}

export function overString(balls) {
  return `${Math.floor(balls / 6)}.${balls % 6}`;
}

function describeOut(kind, bowlerName, fielder) {
  switch (kind) {
    case 'bowled': return `b ${bowlerName}`;
    case 'caught': return fielder ? `c ${fielder} b ${bowlerName}` : `c & b ${bowlerName}`;
    case 'lbw': return `lbw b ${bowlerName}`;
    case 'stumped': return fielder ? `st ${fielder} b ${bowlerName}` : `st b ${bowlerName}`;
    case 'hitwicket': return `hit wicket b ${bowlerName}`;
    case 'runout': return fielder ? `run out (${fielder})` : 'run out';
    default: return kind;
  }
}

export function reduce(state, event) {
  const s = structuredClone(state);
  const { type, payload = {}, at } = event;
  s.flash = null;

  switch (type) {
    case 'startInnings': {
      if (s.phase !== 'setup' && s.phase !== 'inningsBreak') {
        throw new Error(`cannot start innings in phase ${s.phase}`);
      }
      const idx = s.phase === 'setup' ? 0 : 1;
      const inn = newInnings(s.config, idx);
      inn.striker = addBatsman(inn, required(payload.striker, 'striker'));
      inn.nonStriker = addBatsman(inn, required(payload.nonStriker, 'nonStriker'));
      inn.bowler = findOrAddBowler(inn, required(payload.bowler, 'bowler'));
      s.innings[idx] = inn;
      s.currentInnings = idx;
      s.phase = 'live';
      return s;
    }

    case 'ball': {
      const inn = liveInnings(s);
      if (inn.pendingBatsman) throw new Error('waiting for new batsman');
      if (inn.pendingBowler) throw new Error('waiting for new bowler');

      const runs = Math.max(0, payload.runs | 0);
      const extra = payload.extra || null;
      const wicket = payload.wicket || null;
      const legal = extra !== 'wd' && extra !== 'nb';
      const striker = inn.batsmen[inn.striker];
      const bowler = inn.bowlers[inn.bowler];

      // --- runs & extras ---
      let charged = 0; // runs against the bowler this ball
      let symbol;
      if (!extra) {
        inn.runs += runs;
        striker.runs += runs;
        striker.balls += 1;
        if (runs === 4) striker.fours += 1;
        if (runs === 6) striker.sixes += 1;
        charged = runs;
        symbol = String(runs);
      } else if (extra === 'wd') {
        inn.runs += 1 + runs;
        inn.extras.wd += 1 + runs;
        charged = 1 + runs;
        symbol = runs ? `${runs}wd` : 'wd';
      } else if (extra === 'nb') {
        inn.runs += 1 + runs;
        inn.extras.nb += 1;
        striker.runs += runs;
        striker.balls += 1;
        if (runs === 4) striker.fours += 1;
        if (runs === 6) striker.sixes += 1;
        charged = 1 + runs;
        symbol = runs ? `${runs}nb` : 'nb';
      } else { // 'b' | 'lb'
        inn.runs += runs;
        inn.extras[extra] += runs;
        striker.balls += 1;
        charged = 0;
        symbol = `${runs}${extra}`;
      }
      bowler.runs += charged;
      inn.overRunsAgainstBowler += charged;
      if (legal) { inn.balls += 1; bowler.balls += 1; }

      if (!extra && runs === 4) s.flash = { kind: '4', text: 'FOUR!', at };
      if (!extra && runs === 6) s.flash = { kind: '6', text: 'SIX!', at };
      const before = striker.runs - runs;
      if (!extra && (before < 50 && striker.runs >= 50 && striker.runs < 100)) s.flash = { kind: '50', text: `FIFTY — ${striker.name}`, at };
      if (!extra && (before < 100 && striker.runs >= 100)) s.flash = { kind: '100', text: `HUNDRED — ${striker.name}`, at };

      // --- strike rotation for completed runs (before wicket bookkeeping;
      // the out batsman is identified by their pre-rotation end) ---
      const preStriker = inn.striker;
      const preNonStriker = inn.nonStriker;
      if (runs % 2 === 1) {
        [inn.striker, inn.nonStriker] = [inn.nonStriker, inn.striker];
      }

      // --- wicket ---
      if (wicket) {
        if (!WICKET_KINDS.includes(wicket.kind)) throw new Error(`unknown wicket kind ${wicket.kind}`);
        const who = wicket.kind === 'runout' ? (wicket.who || 'striker') : 'striker';
        const outIdx = who === 'striker' ? preStriker : preNonStriker;
        const outBatsman = inn.batsmen[outIdx];
        outBatsman.out = true;
        outBatsman.outDesc = describeOut(wicket.kind, bowler.name, wicket.fielder);
        if (BOWLER_CREDITED.has(wicket.kind)) bowler.wickets += 1;
        inn.wickets += 1;
        inn.fow.push({ wicket: inn.wickets, runs: inn.runs, over: overString(inn.balls), batsman: outBatsman.name });
        symbol = wicket.kind === 'runout' && runs ? `${runs}W` : 'W';
        s.flash = { kind: 'W', text: 'WICKET!', at };
        // vacate the slot the out batsman occupies (post-rotation position)
        if (inn.striker === outIdx) inn.striker = null;
        else if (inn.nonStriker === outIdx) inn.nonStriker = null;
        if (inn.wickets < s.config.playersPerSide - 1) inn.pendingBatsman = true;
      }

      inn.thisOver.push(symbol);

      // --- end of over ---
      const overDone = legal && inn.balls % 6 === 0;
      if (overDone) {
        if (inn.overRunsAgainstBowler === 0) bowler.maidens += 1;
        inn.overRunsAgainstBowler = 0;
        [inn.striker, inn.nonStriker] = [inn.nonStriker, inn.striker];
      }

      // --- innings end? ---
      const allOut = inn.wickets >= s.config.playersPerSide - 1;
      const oversDone = inn.balls >= s.config.oversPerInnings * 6;
      const chased = s.currentInnings === 1 && s.target != null && inn.runs >= s.target;
      if (allOut || oversDone || chased) {
        closeInnings(s, inn);
      } else if (overDone) {
        inn.pendingBowler = true;
        inn.thisOver = [];
      }
      return s;
    }

    case 'newBatsman': {
      const inn = liveInnings(s);
      if (!inn.pendingBatsman) throw new Error('no batsman needed');
      const idx = addBatsman(inn, required(payload.name, 'name'));
      if (inn.striker === null) inn.striker = idx;
      else inn.nonStriker = idx;
      if (typeof payload.onStrike === 'boolean') {
        const atStrike = inn.striker === idx;
        if (payload.onStrike !== atStrike) {
          [inn.striker, inn.nonStriker] = [inn.nonStriker, inn.striker];
        }
      }
      inn.pendingBatsman = false;
      return s;
    }

    case 'newBowler': {
      const inn = liveInnings(s);
      if (!inn.pendingBowler) throw new Error('no bowler change needed');
      const name = required(payload.name, 'name');
      if (inn.bowlers[inn.bowler]?.name === name) {
        throw new Error('a bowler cannot bowl two consecutive overs');
      }
      inn.prevBowler = inn.bowler;
      inn.bowler = findOrAddBowler(inn, name);
      inn.pendingBowler = false;
      return s;
    }

    case 'swapStrike': { // manual correction
      const inn = liveInnings(s);
      [inn.striker, inn.nonStriker] = [inn.nonStriker, inn.striker];
      return s;
    }

    case 'endInnings': { // manual close (declaration / abandoned chase)
      const inn = liveInnings(s);
      closeInnings(s, inn);
      return s;
    }

    case 'reset':
      return initialState(s.config);

    default:
      throw new Error(`unknown cricket event: ${type}`);
  }
}

function liveInnings(s) {
  if (s.phase !== 'live') throw new Error(`no live innings (phase ${s.phase})`);
  return s.innings[s.currentInnings];
}

function closeInnings(s, inn) {
  inn.closed = true;
  inn.pendingBatsman = false;
  inn.pendingBowler = false;
  if (s.currentInnings === 0) {
    s.phase = 'inningsBreak';
    s.target = inn.runs + 1;
  } else {
    s.phase = 'finished';
    s.result = computeResult(s);
  }
}

function computeResult(s) {
  const [first, second] = s.innings;
  const cfg = s.config;
  const teamName = (side) => cfg.teams[side].name;
  if (second.runs >= s.target) {
    const wktsLeft = (cfg.playersPerSide - 1) - second.wickets;
    return `${teamName(second.battingTeam)} won by ${wktsLeft} wicket${wktsLeft === 1 ? '' : 's'}`;
  }
  if (second.runs === s.target - 1) return 'Match tied';
  const margin = (s.target - 1) - second.runs;
  return `${teamName(first.battingTeam)} won by ${margin} run${margin === 1 ? '' : 's'}`;
}

function required(v, name) {
  if (!v || typeof v !== 'string') throw new Error(`${name} required`);
  return v.trim();
}

export function replay(config, eventList) {
  let s = initialState(config);
  for (const e of eventList) s = reduce(s, e);
  return s;
}
