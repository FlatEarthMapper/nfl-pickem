// GET /api/week[?week=N]  ->  { week, currentWeek, games:[...], myPicks:{gameId:abbr} }
// Backed by TheSportsDB (see _nfl.js). Computes each game's lock time and merges
// the signed-in user's saved picks for the week.

import { authUser } from './_auth.js';
import { lockTimeFor } from './_locks.js';
import { getSeason, currentWeekOf, gamesForWeek, weeksPresent, SEASON } from './_nfl.js';

export async function onRequestGet({ request, env }) {
  const user = await authUser(request, env);
  if (!user) return json({ error: 'Not signed in.' }, 401);

  try {
    const url = new URL(request.url);
    let want = parseInt(url.searchParams.get('week') || '', 10);

    const season = await getSeason(env);
    const currentWeek = currentWeekOf(season);
    const week = isNaN(want) ? currentWeek : Math.min(18, Math.max(1, want));

    const now = Date.now();
    const games = gamesForWeek(season, week).map(g => {
      const lockMs = lockTimeFor(g.kickoffMs);
      return {
        id: g.id,
        kickoffMs: g.kickoffMs,
        kickoffLabel: fmtCentral(g.kickoffMs, false),
        lockMs,
        locked: now >= lockMs,
        lockLabel: fmtCentral(lockMs, true),
        winner: g.winner,
        home: { abbr: g.home.abbr, name: g.home.name, logo: g.homeLogo, record: '' },
        away: { abbr: g.away.abbr, name: g.away.name, logo: g.awayLogo, record: '' },
      };
    });

    const picksKey = `picks:${SEASON}:wk${week}:${user}`;
    const myPicks = (await env.PICKS.get(picksKey, 'json')) || {};

    return json({ week, currentWeek, games, myPicks, seasonStarted: weeksPresent(season).length > 0 });
  } catch (e) {
    return json({ error: 'schedule_load_failed', detail: String(e && e.message || e) }, 500);
  }
}

function fmtCentral(ms, timeOnly) {
  const opts = timeOnly
    ? { timeZone: 'America/Chicago', weekday: 'short', hour: 'numeric', minute: '2-digit' }
    : { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  return new Intl.DateTimeFormat('en-US', opts).format(new Date(ms)) + ' CT';
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
