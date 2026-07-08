// Tournament engine tests — drive `computeStandingsFromBundle` with synthetic
// match data so we exercise the full aggregation math (wins/draws/losses,
// points, GD ordering) without touching the live DB.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStandingsFromBundle, replayMatch, isMatchCompleted } from '../server/tournament.js';

function fbConfig(home, away) {
  return JSON.stringify({
    halfMinutes: 45,
    teams: {
      home: { name: home.name, short: home.short, color: home.color, crest: null, players: [] },
      away: { name: away.name, short: away.short, color: away.color, crest: null, players: [] },
    },
  });
}

// Build a synthetic completed football match between two team ids, with the
// given home/away score and a single FT period event so isMatchCompleted
// returns true.
function makeFootballMatch(id, homeId, awayId, homeTeam, awayTeam, homeGoals, awayGoals) {
  return {
    id,
    sport: 'football',
    home_team_id: homeId,
    away_team_id: awayId,
    config: fbConfig(homeTeam, awayTeam),
    _events: [
      { type: 'setPeriod', payload: { period: '1H' }, at: 0 },
      { type: 'startClock', payload: {}, at: 0 },
      ...Array.from({ length: homeGoals }, () => ({ type: 'goal', payload: { team: 'home' }, at: 1000 })),
      ...Array.from({ length: awayGoals }, () => ({ type: 'goal', payload: { team: 'away' }, at: 2000 })),
      { type: 'setPeriod', payload: { period: 'FT' }, at: 5000 },
    ],
  };
}

const TEAMS = [
  { id: 1, name: 'Lions',  short_name: 'LIO', color: '#f00', crest_path: null },
  { id: 2, name: 'Tigers', short_name: 'TIG', color: '#00f', crest_path: null },
  { id: 3, name: 'Eagles', short_name: 'EAG', color: '#0a0', crest_path: null },
  { id: 4, name: 'Wolves', short_name: 'WOL', color: '#ff0', crest_path: null },
];

test('isMatchCompleted flips true after FT, false before', () => {
  const m = makeFootballMatch('m1', 1, 2, TEAMS[0], TEAMS[1], 2, 1);
  assert.equal(isMatchCompleted(m), true);
  const ongoing = { ...m, _events: m._events.filter((e) => e.type !== 'setPeriod' || e.payload.period !== 'FT') };
  assert.equal(isMatchCompleted(ongoing), false);
});

test('computeStandings: 4 teams, 6 matches, mix of wins/draws/losses', () => {
  // Round-robin: 1v2, 1v3, 1v4, 2v3, 2v4, 3v4. Each match is "completed".
  // Results chosen so the table has wins, draws, losses and GD spreads.
  const matches = [
    makeFootballMatch('m1', 1, 2, TEAMS[0], TEAMS[1], 3, 0), // Lions  3-0 Tigers   → Lions W
    makeFootballMatch('m2', 1, 3, TEAMS[0], TEAMS[2], 2, 2), // Lions  2-2 Eagles   → draw
    makeFootballMatch('m3', 1, 4, TEAMS[0], TEAMS[3], 1, 0), // Lions  1-0 Wolves   → Lions W
    makeFootballMatch('m4', 2, 3, TEAMS[1], TEAMS[2], 1, 1), // Tigers 1-1 Eagles   → draw
    makeFootballMatch('m5', 2, 4, TEAMS[1], TEAMS[3], 2, 4), // Tigers 2-4 Wolves   → Wolves W
    makeFootballMatch('m6', 3, 4, TEAMS[2], TEAMS[3], 0, 1), // Eagles 0-1 Wolves   → Wolves W
  ];

  const standings = computeStandingsFromBundle({
    tournament: { sport: 'football' },
    teamRows: TEAMS,
    matchRows: matches,
  });

  // Hand-tallied per-team totals (P / W-D-L / GF-GA / GD / Pts):
  //   Lions  : 3 / 2-1-0 / 6-2  / +4 / 7
  //   Wolves : 3 / 2-0-1 / 5-3  / +2 / 6
  //   Eagles : 3 / 0-2-1 / 3-4  / -1 / 2
  //   Tigers : 3 / 0-1-2 / 3-8  / -5 / 1
  assert.equal(standings.length, 4);
  assert.equal(standings[0].name, 'Lions');
  assert.equal(standings[0].points, 7);
  assert.equal(standings[0].wins, 2);
  assert.equal(standings[0].draws, 1);
  assert.equal(standings[0].losses, 0);
  assert.equal(standings[0].played, 3);
  assert.equal(standings[0].gf, 6);
  assert.equal(standings[0].ga, 2);
  assert.equal(standings[0].gd, 4);

  assert.equal(standings[1].name, 'Wolves');
  assert.equal(standings[1].points, 6);
  assert.equal(standings[1].wins, 2);
  assert.equal(standings[1].losses, 1);
  assert.equal(standings[1].gd, 2);

  assert.equal(standings[2].name, 'Eagles');
  assert.equal(standings[2].points, 2);
  assert.equal(standings[2].draws, 2);
  assert.equal(standings[2].losses, 1);
  assert.equal(standings[2].gd, -1);

  assert.equal(standings[3].name, 'Tigers');
  assert.equal(standings[3].points, 1);
  assert.equal(standings[3].losses, 2);
  assert.equal(standings[3].gd, -5);
});

test('ordering: GD breaks a points tie', () => {
  // Both Lions and Tigers finish on 3 pts / 1W 0D 0L. GD tiebreaks.
  const matches = [
    makeFootballMatch('a', 1, 4, TEAMS[0], TEAMS[3], 4, 0), // Lions  4-0 Wolves → Lions W, GD=+4
    makeFootballMatch('b', 2, 4, TEAMS[1], TEAMS[3], 1, 0), // Tigers 1-0 Wolves → Tigers W, GD=+1
  ];
  const standings = computeStandingsFromBundle({
    tournament: { sport: 'football' },
    teamRows: TEAMS,
    matchRows: matches,
  });
  // Order: Lions (3 pts, GD+4) > Tigers (3 pts, GD+1) > Eagles (0) > Wolves (0)
  assert.equal(standings[0].name, 'Lions');
  assert.equal(standings[0].points, 3);
  assert.equal(standings[0].gd, 4);
  assert.equal(standings[1].name, 'Tigers');
  assert.equal(standings[1].points, 3);
  assert.equal(standings[1].gd, 1);
  // Eagles and Wolves both 0 pts; name tiebreak — "Eagles" < "Wolves"
  assert.equal(standings[2].name, 'Eagles');
  assert.equal(standings[3].name, 'Wolves');
});

test('ordering: equal points AND equal GD → higher GF wins (name tiebreak after)', () => {
  // Build four teams where 1v2 and 3v4 both draw with the same score pattern:
  //   1v2: 2-2  → both 1 pt, GD=0, GF=2
  //   3v4: 1-1  → both 1 pt, GD=0, GF=1
  // Then GF breaks: GF=2 teams outrank GF=1 teams. Within GF=2, name tiebreak.
  const matches = [
    makeFootballMatch('gf3', 1, 2, TEAMS[0], TEAMS[1], 2, 2),
    makeFootballMatch('gf4', 3, 4, TEAMS[2], TEAMS[3], 1, 1),
  ];
  const s = computeStandingsFromBundle({
    tournament: { sport: 'football' },
    teamRows: TEAMS,
    matchRows: matches,
  });
  // Top 2: GF=2 group (Lions 2 vs Tigers 2 — name tiebreak: Lions)
  // Next: GF=1 group (Eagles 1 vs Wolves 1 — name tiebreak: Eagles)
  assert.equal(s[0].gf, 2);
  assert.equal(s[0].name, 'Lions');
  assert.equal(s[1].gf, 2);
  assert.equal(s[1].name, 'Tigers');
  assert.equal(s[2].gf, 1);
  assert.equal(s[2].name, 'Eagles');
  assert.equal(s[3].gf, 1);
  assert.equal(s[3].name, 'Wolves');
});

test('replayMatch reads final score from event log', () => {
  const m = makeFootballMatch('m-rep', 1, 2, TEAMS[0], TEAMS[1], 4, 2);
  const state = replayMatch(m);
  assert.equal(state.score.home, 4);
  assert.equal(state.score.away, 2);
  assert.equal(state.period, 'FT');
});

test('cricket tournament: completed 2-innings match contributes to standings', () => {
  // 1 over per side, 3 players each (so 2 wickets = all out).
  // Home (Lions) bats first, scores 12; Away (Tigers) chases 13, scores 8
  // and is all out → Lions win by 4 runs.
  const config = JSON.stringify({
    oversPerInnings: 1,
    playersPerSide: 3,
    teams: {
      home: { name: 'Lions',  short: 'LIO', color: '#f00', crest: null, players: ['H1','H2','H3'] },
      away: { name: 'Tigers', short: 'TIG', color: '#00f', crest: null, players: ['A1','A2','A3'] },
    },
    toss: { winner: 'home', decision: 'bat' },
  });

  const events = [
    // First innings: 6 balls, 12 runs (4,4,1,1,1,1)
    { type: 'startInnings', payload: { striker: 'H1', nonStriker: 'H2', bowler: 'A1' }, at: 0 },
    { type: 'ball', payload: { runs: 4, extra: null }, at: 1000 },
    { type: 'ball', payload: { runs: 4, extra: null }, at: 2000 },
    { type: 'ball', payload: { runs: 1, extra: null }, at: 3000 },
    { type: 'ball', payload: { runs: 1, extra: null }, at: 4000 },
    { type: 'ball', payload: { runs: 1, extra: null }, at: 5000 },
    { type: 'ball', payload: { runs: 1, extra: null }, at: 6000 }, // overs done, innings closes
    // Second innings: 2 wickets → all out
    { type: 'startInnings', payload: { striker: 'A1', nonStriker: 'A2', bowler: 'H1' }, at: 7000 },
    { type: 'ball', payload: { runs: 4, extra: null }, at: 8000 },
    { type: 'ball', payload: { runs: 4, extra: null }, at: 9000 },
    { type: 'ball', payload: { runs: 0, extra: null, wicket: { kind: 'bowled' } }, at: 10000 },
    { type: 'newBatsman', payload: { name: 'A3', onStrike: false }, at: 10500 },
    { type: 'ball', payload: { runs: 0, extra: null, wicket: { kind: 'bowled' } }, at: 11000 }, // all out
  ];

  const match = {
    id: 'c1', sport: 'cricket',
    home_team_id: 1, away_team_id: 2,
    config, _events: events,
  };
  const standings = computeStandingsFromBundle({
    tournament: { sport: 'cricket' },
    teamRows: TEAMS,
    matchRows: [match],
  });
  const lions = standings.find((r) => r.name === 'Lions');
  const tigers = standings.find((r) => r.name === 'Tigers');
  assert.equal(lions.played, 1);
  assert.equal(lions.wins, 1);
  assert.equal(lions.points, 3);
  assert.equal(lions.gf, 12);
  assert.equal(lions.ga, 8);
  assert.equal(tigers.played, 1);
  assert.equal(tigers.losses, 1);
  assert.equal(tigers.points, 0);
  assert.equal(tigers.gf, 8);
  assert.equal(tigers.ga, 12);
  // ranking: Lions (3 pts) > Eagles / Wolves (0) > Tigers (0)
  assert.equal(standings[0].name, 'Lions');
});

test('sport filtering: cricket tournament ignores football matches', () => {
  const fbMatch = makeFootballMatch('fb', 1, 2, TEAMS[0], TEAMS[1], 5, 0);
  const standings = computeStandingsFromBundle({
    tournament: { sport: 'cricket' },
    teamRows: TEAMS,
    matchRows: [fbMatch],
  });
  assert.equal(standings.length, 4);
  for (const row of standings) {
    assert.equal(row.played, 0);
    assert.equal(row.points, 0);
  }
});

test('team filtering: matches with non-tournament teams do not count', () => {
  // A completed match between team 1 and a phantom team 99 (not in TEAMS)
  // must NOT contribute to standings for team 1.
  const phantom = { id: 99, name: 'Phantom', short_name: 'PHM', color: '#888', crest_path: null };
  const match = makeFootballMatch('m1', 1, 99, TEAMS[0], phantom, 7, 0);
  const standings = computeStandingsFromBundle({
    tournament: { sport: 'football' },
    teamRows: TEAMS, // 99 is not in here
    matchRows: [match],
  });
  const lions = standings.find((r) => r.name === 'Lions');
  // match not counted (team 99 not in tournament) → Lions has played=0
  assert.equal(lions.played, 0);
  assert.equal(lions.gf, 0);
  assert.equal(lions.points, 0);
});