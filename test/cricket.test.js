import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduce, replay, overString } from '../server/sports/cricket.js';

const config = {
  oversPerInnings: 2,
  playersPerSide: 3, // 2 wickets = all out; keeps tests short
  teams: {
    home: { name: 'Lions', short: 'LIO', color: '#f00', crest: null, players: ['H1', 'H2', 'H3'] },
    away: { name: 'Tigers', short: 'TIG', color: '#00f', crest: null, players: ['A1', 'A2', 'A3'] },
  },
  toss: { winner: 'home', decision: 'bat' },
};

const ev = (type, payload = {}) => ({ type, payload, at: 1000 });
const start = (striker = 'H1', nonStriker = 'H2', bowler = 'A1') =>
  ev('startInnings', { striker, nonStriker, bowler });
const ball = (runs, extra = null, wicket = null) => ev('ball', { runs, extra, wicket });

test('toss decides batting order', () => {
  let s = reduce(initialState(config), start());
  assert.equal(s.innings[0].battingTeam, 'home');
  const cfg2 = { ...config, toss: { winner: 'home', decision: 'bowl' } };
  let s2 = reduce(initialState(cfg2), start('A1', 'A2', 'H1'));
  assert.equal(s2.innings[0].battingTeam, 'away');
});

test('runs, boundaries and strike rotation', () => {
  let s = reduce(initialState(config), start());
  s = reduce(s, ball(1)); // H1 takes single -> H2 on strike
  let inn = s.innings[0];
  assert.equal(inn.runs, 1);
  assert.equal(inn.batsmen[inn.striker].name, 'H2');
  s = reduce(s, ball(4)); // H2 hits four, keeps strike
  inn = s.innings[0];
  assert.equal(inn.runs, 5);
  assert.equal(inn.batsmen[inn.striker].name, 'H2');
  assert.equal(inn.batsmen[1].fours, 1);
  assert.equal(s.flash.kind, '4');
  assert.equal(inn.balls, 2);
  assert.equal(overString(inn.balls), '0.2');
});

test('wide adds penalty, is not a legal ball, no ball faced', () => {
  let s = reduce(initialState(config), start());
  s = reduce(s, ball(0, 'wd'));
  const inn = s.innings[0];
  assert.equal(inn.runs, 1);
  assert.equal(inn.extras.wd, 1);
  assert.equal(inn.balls, 0);
  assert.equal(inn.batsmen[0].balls, 0);
  assert.equal(inn.bowlers[0].runs, 1);
});

test('no-ball: penalty + bat runs to striker, counts as ball faced', () => {
  let s = reduce(initialState(config), start());
  s = reduce(s, ball(4, 'nb'));
  const inn = s.innings[0];
  assert.equal(inn.runs, 5);
  assert.equal(inn.extras.nb, 1);
  assert.equal(inn.balls, 0);
  assert.equal(inn.batsmen[0].runs, 4);
  assert.equal(inn.batsmen[0].balls, 1);
  assert.equal(inn.bowlers[0].runs, 5);
});

test('byes/leg-byes: legal ball, not charged to bowler, odd runs rotate strike', () => {
  let s = reduce(initialState(config), start());
  s = reduce(s, ball(1, 'lb'));
  const inn = s.innings[0];
  assert.equal(inn.runs, 1);
  assert.equal(inn.extras.lb, 1);
  assert.equal(inn.balls, 1);
  assert.equal(inn.bowlers[0].runs, 0);
  assert.equal(inn.batsmen[inn.striker].name, 'H2'); // rotated
});

test('over completion: strike swaps, bowler change required, maiden counted', () => {
  let s = reduce(initialState(config), start());
  for (let i = 0; i < 6; i++) s = reduce(s, ball(0));
  let inn = s.innings[0];
  assert.equal(inn.balls, 6);
  assert.equal(inn.pendingBowler, true);
  assert.equal(inn.bowlers[0].maidens, 1);
  assert.equal(inn.batsmen[inn.striker].name, 'H2'); // end-of-over swap
  assert.throws(() => reduce(s, ball(0)), /new bowler/);
  assert.throws(() => reduce(s, ev('newBowler', { name: 'A1' })), /consecutive/);
  s = reduce(s, ev('newBowler', { name: 'A2' }));
  assert.equal(s.innings[0].pendingBowler, false);
});

test('wicket: bowled credits bowler, new batsman flow with strike choice', () => {
  let s = reduce(initialState(config), start());
  s = reduce(s, ball(0, null, { kind: 'bowled' }));
  let inn = s.innings[0];
  assert.equal(inn.wickets, 1);
  assert.equal(inn.bowlers[0].wickets, 1);
  assert.equal(inn.batsmen[0].out, true);
  assert.match(inn.batsmen[0].outDesc, /^b A1/);
  assert.equal(inn.pendingBatsman, true);
  assert.throws(() => reduce(s, ball(1)), /new batsman/);
  s = reduce(s, ev('newBatsman', { name: 'H3', onStrike: true }));
  inn = s.innings[0];
  assert.equal(inn.batsmen[inn.striker].name, 'H3');
  assert.equal(inn.batsmen[inn.nonStriker].name, 'H2');
  assert.equal(inn.fow.length, 1);
  assert.equal(inn.fow[0].batsman, 'H1');
});

test('run out: completed runs count, non-striker out by pre-rotation end, not credited to bowler', () => {
  let s = reduce(initialState(config), start());
  // batsmen run 1 (so they crossed), non-striker (H2, pre-rotation end) run out
  s = reduce(s, ball(1, null, { kind: 'runout', who: 'nonStriker' }));
  const inn = s.innings[0];
  assert.equal(inn.runs, 1);
  assert.equal(inn.wickets, 1);
  assert.equal(inn.bowlers[0].wickets, 0);
  assert.equal(inn.batsmen[1].name, 'H2');
  assert.equal(inn.batsmen[1].out, true);
  // H1 ran the single so rotated to non-striker end; H2's (now striker) slot vacated
  assert.equal(inn.striker, null);
  assert.equal(inn.batsmen[inn.nonStriker].name, 'H1');
});

test('all out closes innings and sets target', () => {
  let s = reduce(initialState(config), start());
  s = reduce(s, ball(4));
  s = reduce(s, ball(0, null, { kind: 'bowled' }));
  s = reduce(s, ev('newBatsman', { name: 'H3', onStrike: true }));
  s = reduce(s, ball(0, null, { kind: 'lbw' })); // 2nd wicket = all out (3/side)
  assert.equal(s.phase, 'inningsBreak');
  assert.equal(s.target, 5);
  assert.equal(s.innings[0].closed, true);
});

test('overs exhausted closes innings', () => {
  let s = reduce(initialState(config), start());
  for (let over = 0; over < 2; over++) {
    for (let i = 0; i < 6; i++) s = reduce(s, ball(1));
    if (over === 0) s = reduce(s, ev('newBowler', { name: 'A2' }));
  }
  assert.equal(s.phase, 'inningsBreak');
  assert.equal(s.target, 13);
});

test('chase: win by wickets, tie, and loss by runs', () => {
  // First innings: 6 runs then declared
  const base = [];
  let s = reduce(initialState(config), start());
  s = reduce(s, ball(6));
  s = reduce(s, ev('endInnings'));
  assert.equal(s.target, 7);

  // Successful chase
  let w = reduce(s, start('A1', 'A2', 'H1'));
  assert.equal(w.innings[1].battingTeam, 'away');
  w = reduce(w, ball(6));
  w = reduce(w, ball(1));
  assert.equal(w.phase, 'finished');
  assert.equal(w.result, 'Tigers won by 2 wickets');

  // Tie: away ends with 6 after overs run out
  let t = reduce(s, start('A1', 'A2', 'H1'));
  t = reduce(t, ball(6));
  for (let i = 0; i < 5; i++) t = reduce(t, ball(0));
  t = reduce(t, ev('newBowler', { name: 'H2' }));
  for (let i = 0; i < 6; i++) t = reduce(t, ball(0));
  assert.equal(t.phase, 'finished');
  assert.equal(t.result, 'Match tied');

  // Loss: away all out on 2
  let l = reduce(s, start('A1', 'A2', 'H1'));
  l = reduce(l, ball(2));
  l = reduce(l, ball(0, null, { kind: 'bowled' }));
  l = reduce(l, ev('newBatsman', { name: 'A3', onStrike: true }));
  l = reduce(l, ball(0, null, { kind: 'caught', fielder: 'H3' }));
  assert.equal(l.phase, 'finished');
  assert.equal(l.result, 'Lions won by 4 runs');
});

test('replay determinism (undo = replay without last event)', () => {
  const log = [
    start(),
    ball(1), ball(4), ball(0, 'wd'), ball(2, 'nb'),
    ball(0, null, { kind: 'bowled' }),
    ev('newBatsman', { name: 'H3', onStrike: true }),
    ball(3),
  ];
  const full = replay(config, log);
  const undone = replay(config, log.slice(0, -1));
  assert.equal(full.innings[0].runs, undone.innings[0].runs + 3);
  const again = replay(config, log);
  assert.deepEqual(again, full);
});

test('wicket on last ball of over sets both pending flags', () => {
  let s = reduce(initialState(config), start());
  for (let i = 0; i < 5; i++) s = reduce(s, ball(0));
  s = reduce(s, ball(0, null, { kind: 'bowled' }));
  const inn = s.innings[0];
  assert.equal(inn.pendingBatsman, true);
  assert.equal(inn.pendingBowler, true);
  s = reduce(s, ev('newBatsman', { name: 'H3', onStrike: false }));
  s = reduce(s, ev('newBowler', { name: 'A2' }));
  assert.equal(s.innings[0].pendingBatsman, false);
  assert.equal(s.innings[0].pendingBowler, false);
});

test('flash events: FOUR, SIX, FIFTY, HUNDRED', () => {
  let s = reduce(initialState(config), start('H1', 'H2', 'A1'));

  // 4 → FOUR flash
  s = reduce(s, ball(4));
  assert.equal(s.flash && s.flash.kind, '4');
  assert.equal(s.flash.text, 'FOUR!');

  // 6 → SIX flash
  s = reduce(s, ball(6));
  assert.equal(s.flash && s.flash.kind, '6');
  assert.equal(s.flash.text, 'SIX!');

  // 0 → no flash
  s = reduce(s, ball(0));
  assert.equal(s.flash, null);

  // FIFTY / HUNDRED walks — use a config with plenty of players + overs
  // and rotate bowlers so we can bowl many legal balls to one striker.
  const bowlerPool = ['A1', 'A2', 'A3', 'B1', 'B2', 'B3', 'C1', 'C2', 'C3', 'D1', 'D2'];
  const longConfig = {
    oversPerInnings: 50,
    playersPerSide: 12, // 11 wickets to all-out, plenty of headroom
    teams: {
      home: { name: 'Lions', short: 'LIO', color: '#f00', crest: null,
              players: ['H1','H2','H3','H4','H5','H6','H7','H8','H9','H10','H11','H12'] },
      away: { name: 'Tigers', short: 'TIG', color: '#00f', crest: null,
              players: bowlerPool.concat(['D3','D4','D5','D6','D7','D8']) },
    },
    toss: { winner: 'home', decision: 'bat' },
  };
  s = reduce(initialState(longConfig), start('H1', 'H2', 'A1'));

  // walk N runs of "1" balls, swapping strike so H1 stays on strike.
  // Rotate bowlers whenever pendingBowler is set.
  function walkRuns(target) {
    const strikerName = s.innings[0].batsmen[s.innings[0].striker].name;
    let safety = 0;
    while (s.innings[0].batsmen[s.innings[0].striker].runs < target) {
      if (++safety > 1000) throw new Error('walkRuns: runaway');
      if (s.innings[0].pendingBowler) {
        const cur = s.innings[0].bowlers[s.innings[0].bowler]?.name;
        const nextB = bowlerPool.find((n) => n !== cur);
        s = reduce(s, ev('newBowler', { name: nextB }));
      } else {
        s = reduce(s, ball(1));
        s = reduce(s, ev('swapStrike', {}));
      }
    }
    assert.equal(s.innings[0].batsmen[s.innings[0].striker].name, strikerName);
  }

  // Walk H1 to 49, then a single to reach 50
  walkRuns(49);
  assert.equal(s.innings[0].batsmen[s.innings[0].striker].runs, 49);
  if (s.innings[0].pendingBowler) {
    const cur = s.innings[0].bowlers[s.innings[0].bowler]?.name;
    s = reduce(s, ev('newBowler', { name: bowlerPool.find((n) => n !== cur) }));
  }
  s = reduce(s, ball(1)); // 50th run
  assert.equal(s.flash && s.flash.kind, '50');
  assert.match(s.flash.text, /FIFTY/);
  assert.match(s.flash.text, /H1/);

  // Walk H1 to 99, then a single to reach 100
  s = reduce(s, ev('swapStrike', {}));
  walkRuns(99);
  if (s.innings[0].pendingBowler) {
    const cur = s.innings[0].bowlers[s.innings[0].bowler]?.name;
    s = reduce(s, ev('newBowler', { name: bowlerPool.find((n) => n !== cur) }));
  }
  s = reduce(s, ball(1)); // 100th run
  assert.equal(s.flash && s.flash.kind, '100');
  assert.match(s.flash.text, /HUNDRED/);
  assert.match(s.flash.text, /H1/);

  // Wicket flash takes precedence over run flash
  s = reduce(initialState(longConfig), start('H1', 'H2', 'A1'));
  walkRuns(48);
  if (s.innings[0].pendingBowler) {
    const cur = s.innings[0].bowlers[s.innings[0].bowler]?.name;
    s = reduce(s, ev('newBowler', { name: bowlerPool.find((n) => n !== cur) }));
  }
  s = reduce(s, ball(1, null, { kind: 'bowled' })); // H1 reaches 49 and is bowled
  assert.equal(s.flash && s.flash.kind, 'W', 'wicket flash wins over 50');
});
