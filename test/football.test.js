import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduce, replay, clockElapsedMs, displayMinute } from '../server/sports/football.js';

const config = {
  halfMinutes: 45,
  teams: {
    home: { name: 'Lions FC', short: 'LIO', color: '#f00', crest: null, players: [] },
    away: { name: 'Tigers FC', short: 'TIG', color: '#00f', crest: null, players: [] },
  },
};

const ev = (type, payload = {}, at = 0) => ({ type, payload, at });

test('goals and score adjustment', () => {
  let s = initialState(config);
  s = reduce(s, ev('goal', { team: 'home', scorer: 'Silva' }));
  s = reduce(s, ev('goal', { team: 'home' }));
  s = reduce(s, ev('goal', { team: 'away' }));
  assert.deepEqual(s.score, { home: 2, away: 1 });
  assert.equal(s.scorers.length, 3);
  assert.equal(s.lastGoal.team, 'away');
  s = reduce(s, ev('adjustScore', { team: 'home', delta: -1 }));
  assert.deepEqual(s.score, { home: 1, away: 1 });
  assert.equal(s.scorers.filter((g) => g.team === 'home').length, 1);
  // never below zero
  s = reduce(s, ev('adjustScore', { team: 'away', delta: -5 }));
  assert.equal(s.score.away, 0);
});

test('clock: start, pause, elapsed math, period bases', () => {
  let s = initialState(config);
  s = reduce(s, ev('setPeriod', { period: '1H' }, 0));
  s = reduce(s, ev('startClock', {}, 10_000));
  assert.equal(clockElapsedMs(s, 70_000), 60_000);
  s = reduce(s, ev('pauseClock', {}, 70_000));
  assert.equal(clockElapsedMs(s, 999_999), 60_000);
  s = reduce(s, ev('startClock', {}, 100_000));
  assert.equal(clockElapsedMs(s, 160_000), 120_000);
  assert.equal(displayMinute(s, 160_000), 3);
  // 2nd half starts at 45:00
  s = reduce(s, ev('setPeriod', { period: '2H' }, 200_000));
  assert.equal(s.clock.running, false);
  assert.equal(clockElapsedMs(s, 200_000), 45 * 60_000);
  s = reduce(s, ev('startClock', {}, 200_000));
  assert.equal(displayMinute(s, 200_000 + 60_000), 47);
});

test('goal minute derives from clock at event time', () => {
  let s = initialState(config);
  s = reduce(s, ev('setPeriod', { period: '1H' }, 0));
  s = reduce(s, ev('startClock', {}, 0));
  s = reduce(s, ev('goal', { team: 'home', scorer: 'Silva' }, 12.5 * 60_000));
  assert.equal(s.scorers[0].minute, 13);
});

test('cards, stoppage, shootout', () => {
  let s = initialState(config);
  s = reduce(s, ev('card', { team: 'home', color: 'y', delta: 1 }));
  s = reduce(s, ev('card', { team: 'home', color: 'r', delta: 1 }));
  assert.deepEqual(s.cards.home, { y: 1, r: 1 });
  s = reduce(s, ev('stoppage', { minutes: 4 }));
  assert.equal(s.stoppage, 4);
  s = reduce(s, ev('setPeriod', { period: 'PENS' }));
  s = reduce(s, ev('shootoutKick', { team: 'home', scored: true }));
  s = reduce(s, ev('shootoutKick', { team: 'away', scored: false }));
  assert.deepEqual(s.shootout, { home: ['G'], away: ['X'] });
});

test('card event pushes to cardLog with name and lastCard mirrors it', () => {
  let s = initialState(config);
  // No cards yet: cardLog and lastCard are empty/null.
  assert.deepEqual(s.cardLog, []);
  assert.equal(s.lastCard, null);

  s = reduce(s, ev('card', { team: 'home', color: 'y', delta: 1, name: 'Silva' }));
  assert.equal(s.cardLog.length, 1);
  const entry = s.cardLog[0];
  assert.equal(entry.team, 'home');
  assert.equal(entry.color, 'y');
  assert.equal(entry.name, 'Silva');
  assert.equal(entry.at, 0);
  // lastCard mirrors the most recent issuance.
  assert.deepEqual(s.lastCard, entry);

  // Unnamed card — name defaults to ''.
  s = reduce(s, ev('card', { team: 'away', color: 'r', delta: 1 }));
  assert.equal(s.cardLog.length, 2);
  assert.equal(s.cardLog[1].name, '');
  assert.equal(s.cardLog[1].color, 'r');
  assert.equal(s.lastCard.color, 'r');
});

test('card minute derives from clock at event.at, never Date.now()', () => {
  let s = initialState(config);
  // Run a clock from t=0 for 22 minutes (so displayMinute(22:00) = 23, matching
  // football convention where the 1st minute is "1'"). The recorded card minute
  // must be 23, matching displayMinute(s, 22 * 60_000), not whatever real
  // wall-clock time the test happens to run in.
  s = reduce(s, ev('setPeriod', { period: '1H' }, 0));
  s = reduce(s, ev('startClock', {}, 0));
  s = reduce(s, ev('card', { team: 'home', color: 'y', delta: 1, name: 'Sunil' }, 22 * 60_000));
  assert.equal(s.cardLog[0].minute, 23);
  // Pin: displayMinute must agree with the recorded minute.
  assert.equal(s.cardLog[0].minute, displayMinute(s, 22 * 60_000));
  // Independent timing: a card at 0:00 still records minute 1 (football convention).
  s = reduce(s, ev('card', { team: 'away', color: 'r', delta: 1, name: 'Tigers #4' }, 1));
  assert.equal(s.cardLog[1].minute, 1);
});

test('clearLastCard clears lastCard and undo restores pre-card state', () => {
  let s = initialState(config);
  s = reduce(s, ev('setPeriod', { period: '1H' }, 0));
  s = reduce(s, ev('startClock', {}, 0));
  // Issue one yellow then one red.
  s = reduce(s, ev('card', { team: 'home', color: 'y', delta: 1, name: 'Silva' }, 5 * 60_000));
  s = reduce(s, ev('card', { team: 'home', color: 'r', delta: 1, name: 'Ramos' }, 20 * 60_000));
  assert.equal(s.cardLog.length, 2);
  assert.equal(s.lastCard.color, 'r');

  // clearLastCard wipes the banner entry without touching history or counters.
  s = reduce(s, ev('clearLastCard'));
  assert.equal(s.lastCard, null);
  assert.equal(s.cardLog.length, 2);
  assert.deepEqual(s.cards.home, { y: 1, r: 1 });

  // Undo the red card via the full log replay path — the most recent entry
  // disappears, count drops, no negative, lastCard reverts to the yellow.
  const log = [
    ev('setPeriod', { period: '1H' }, 0),
    ev('startClock', {}, 0),
    ev('card', { team: 'home', color: 'y', delta: 1, name: 'Silva' }, 5 * 60_000),
    ev('card', { team: 'home', color: 'r', delta: 1, name: 'Ramos' }, 20 * 60_000),
  ];
  const undone = replay(config, log.slice(0, -1));
  assert.deepEqual(undone.cards.home, { y: 1, r: 0 });
  assert.equal(undone.cardLog.length, 1);
  assert.equal(undone.cardLog[0].name, 'Silva');
  assert.equal(undone.lastCard.name, 'Silva');

  // A full reset clears everything.
  const reset = reduce(undone, ev('reset'));
  assert.deepEqual(reset.cards, { home: { y: 0, r: 0 }, away: { y: 0, r: 0 } });
  assert.deepEqual(reset.cardLog, []);
  assert.equal(reset.lastCard, null);
});

test('negative card delta removes the matching log entry (× delete button)', () => {
  let s = initialState(config);
  s = reduce(s, ev('setPeriod', { period: '1H' }, 0));
  s = reduce(s, ev('startClock', {}, 0));
  s = reduce(s, ev('card', { team: 'home', color: 'y', delta: 1, name: 'Silva' }, 5 * 60_000));
  s = reduce(s, ev('card', { team: 'home', color: 'r', delta: 1, name: 'Costa' }, 6 * 60_000));
  assert.equal(s.cardLog.length, 2);
  // × delete next to yellow — drops the LAST yellow entry but leaves the red alone.
  s = reduce(s, ev('card', { team: 'home', color: 'y', delta: -1 }, 7 * 60_000));
  assert.equal(s.cardLog.length, 1);
  assert.deepEqual(s.cardLog[0], { team: 'home', color: 'r', name: 'Costa', minute: 7, at: 6 * 60_000 });
  assert.deepEqual(s.cards.home, { y: 0, r: 1 });
  // lastCard should now re-derive to the red entry (since yellow was the banner).
  assert.equal(s.lastCard.color, 'r');
});

test('replay determinism', () => {
  const log = [
    ev('setPeriod', { period: '1H' }, 0),
    ev('startClock', {}, 0),
    ev('goal', { team: 'home', scorer: 'Silva' }, 60_000),
    ev('card', { team: 'away', color: 'y', delta: 1 }, 90_000),
    ev('pauseClock', {}, 120_000),
  ];
  assert.deepEqual(replay(config, log), replay(config, log));
  const undone = replay(config, log.slice(0, -1));
  assert.equal(undone.clock.running, true);
});
