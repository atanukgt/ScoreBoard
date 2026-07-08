// Tournament engine — pure functions over the existing event-sourced match log.
//
// We replay each match through the sport-specific reducer to read the final
// state, then aggregate wins/draws/losses/GF/GA per team. Points:
//   win = 3, draw = 1, loss = 0.
//
// A match counts as completed if:
//   - football: state.period ∈ { 'FT', 'AET', 'PENS' }
//   - cricket:  state.phase === 'finished'
//
// This module is the SINGLE source of truth for "what is a finished match".
// Routes call `computeStandings(tournamentId)` directly; no in-memory cache.

import * as football from './sports/football.js';
import * as cricket from './sports/cricket.js';

const ENGINES = { football, cricket };
const COMPLETED_FOOTBALL = new Set(['FT', 'AET', 'PENS']);

/**
 * Replay a match's event log through the sport engine and return the final state.
 * Returns null if the match row or engine cannot be found.
 */
export function replayMatch(matchRow) {
  if (!matchRow) return null;
  const engine = ENGINES[matchRow.sport];
  if (!engine) return null;
  // events.forMatch-style rows: [{ seq, type, payload, at }]
  // callers pass already-parsed rows to keep this function pure (no DB coupling).
  const config = JSON.parse(matchRow.config);
  return engine.replay(config, matchRow._events || []);
}

/** Completion check on an already-computed state (shared with the socket layer). */
export function isCompletedState(sport, state) {
  if (!state) return false;
  if (sport === 'football') return COMPLETED_FOOTBALL.has(state.period);
  if (sport === 'cricket') return state.phase === 'finished';
  return false;
}

export function isMatchCompleted(matchRow) {
  if (!matchRow) return false;
  return isCompletedState(matchRow.sport, replayMatch(matchRow));
}

/**
 * Compute leaderboard standings for a tournament.
 *
 * @param {object} bundle  {
 *   tournament: { sport, ... },
 *   teamRows:   [ { id, name, short_name, color, crest_path, ... } ],
 *   matchRows:  [ { id, sport, home_team_id, away_team_id, config, _events: [...], ... } ]
 * }
 * @returns array of standings sorted by points DESC, gd DESC, gf DESC, name ASC
 */
export function computeStandingsFromBundle(bundle) {
  const { tournament, teamRows, matchRows } = bundle;
  const byId = new Map();
  for (const t of teamRows) {
    byId.set(t.id, {
      team_id: t.id,
      name: t.name,
      short: t.short_name,
      color: t.color,
      crest: t.crest_path ? `/uploads/${t.crest_path}` : null,
      played: 0, wins: 0, draws: 0, losses: 0,
      gf: 0, ga: 0, gd: 0, points: 0,
    });
  }

  // Only count matches that (a) match the tournament's sport, and (b) are
  // attached to a team currently in the tournament, and (c) are completed.
  const teamIds = new Set(teamRows.map((t) => t.id));
  for (const m of matchRows) {
    if (m.sport !== tournament.sport) continue;
    if (!teamIds.has(m.home_team_id) || !teamIds.has(m.away_team_id)) continue;
    if (!isMatchCompleted(m)) continue;

    const state = replayMatch(m);
    let hg, ag, isDraw;
    if (m.sport === 'football') {
      hg = state.score.home;
      ag = state.score.away;
      isDraw = hg === ag;
    } else if (m.sport === 'cricket') {
      const [first, second] = state.innings;
      if (!first || !second) continue;
      // The reducer's `battingTeam` is 'home' or 'away'; map to the match's DB pk.
      const firstRuns = first.runs;
      const secondRuns = second.runs;
      // 'home' in the reducer = m.home_team_id; 'away' = m.away_team_id.
      const firstIsHome = first.battingTeam === 'home';
      hg = firstIsHome ? firstRuns : secondRuns;
      ag = firstIsHome ? secondRuns : firstRuns;
      isDraw = hg === ag;
    } else {
      continue;
    }

    const home = byId.get(m.home_team_id);
    const away = byId.get(m.away_team_id);
    if (!home || !away) continue;

    home.played += 1; away.played += 1;
    home.gf += hg; home.ga += ag; home.gd = home.gf - home.ga;
    away.gf += ag; away.ga += hg; away.gd = away.gf - away.ga;

    if (isDraw) {
      home.draws += 1; away.draws += 1;
      home.points += 1; away.points += 1;
    } else if (hg > ag) {
      home.wins += 1; away.losses += 1;
      home.points += 3;
    } else {
      away.wins += 1; home.losses += 1;
      away.points += 3;
    }
  }

  const standings = [...byId.values()];
  standings.sort((a, b) =>
    (b.points - a.points) ||
    (b.gd - a.gd) ||
    (b.gf - a.gf) ||
    a.name.localeCompare(b.name)
  );
  return standings;
}

// ---- DB-coupled adapter (used by HTTP routes / tests) ----

import { tournaments, tournamentTeams, tournamentMatches, teams, matches, events as eventLog } from './db.js';

/**
 * Load all the data needed to compute standings for a tournament.
 * Returned bundle is what `computeStandingsFromBundle` consumes.
 */
export function loadBundle(tournamentId) {
  const tournament = tournaments.get(tournamentId);
  if (!tournament) return null;
  const teamIds = tournamentTeams.forTournament(tournamentId);
  const teamRows = teamIds
    .map((id) => teams.get(id))
    .filter(Boolean);
  const tMatches = tournamentMatches.forTournament(tournamentId);
  const matchRows = tMatches
    .map((tm) => {
      const m = matches.get(tm.match_id);
      if (!m) return null;
      const evs = eventLog.forMatch(tm.match_id).map((e) => ({
        type: e.type,
        payload: JSON.parse(e.payload),
        at: e.at,
      }));
      return {
        id: m.id,
        sport: m.sport,
        home_team_id: m.home_team_id,
        away_team_id: m.away_team_id,
        config: m.config,
        _events: evs,
        round: tm.round,
        group_name: tm.group_name,
      };
    })
    .filter(Boolean);
  return { tournament, teamRows, matchRows };
}

/**
 * Public entry: tournament id → standings array (sorted).
 */
export function computeStandings(tournamentId) {
  const bundle = loadBundle(tournamentId);
  if (!bundle) return [];
  return computeStandingsFromBundle(bundle);
}