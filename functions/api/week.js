// GET /api/week[?week=N]  ->  { week, currentWeek, games:[...], myPicks, seasonStarted }
// Backed by TheSportsDB per-round fetch (see _nfl.js).

import { authUser } from './_auth.js';
import { lockTimeFor } from './_locks.js';
import { getWeek, currentWeek, SEASON, NUM_WEEKS } from './_nfl.js';

export async function onRequestGet({ request, env }) {
  const user = await authUser(request, env);
  if (!user) return json({ error: 'Not signed in.' }, 401);

  try {
    const url = new URL(request.url);
    let want = parseInt(url.searchParams.get('week') || '', 10);

    const cur = await currentWeek(env);
    const week = isNaN(want) ? cur : Math.min(NUM_WEEKS, Math.max(1, want));

    const weekGames = await getWeek(env, week);
    const now = Date.now();
    const games = weekGames.map(g => {
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

    return json({ week, currentWeek: cur, games, myPicks, seasonStarted: games.length > 0 });
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
