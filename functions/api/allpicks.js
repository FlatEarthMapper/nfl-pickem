// GET /api/allpicks?week=N  ->  { week, players:[...], games:[...], picks:{ player: {gameId:abbr} } }
// Returns every player's picks for the week alongside the week's games, so the UI
// can show any player's full slate live. Fully open by design — everyone sees
// everyone's picks as they're made (picks remain changeable until each game locks).

import { authUser } from './_auth.js';
import { lockTimeFor } from './_locks.js';
import { getWeek, currentWeek, SEASON, NUM_WEEKS } from './_nfl.js';

export async function onRequestGet({ request, env }) {
  const user = await authUser(request, env);
  if (!user) return json({ error: 'Not signed in.' }, 401);

  try {
    let players;
    try { players = JSON.parse(env.PLAYERS || '[]'); } catch { players = []; }
    if (!Array.isArray(players)) players = [];

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
        kickoffLabel: fmtCentral(g.kickoffMs),
        locked: now >= lockMs,
        winner: g.winner,
        home: { abbr: g.home.abbr, name: g.home.name, logo: g.homeLogo },
        away: { abbr: g.away.abbr, name: g.away.name, logo: g.awayLogo },
      };
    });

    const picks = {};
    for (const p of players) {
      picks[p] = (await env.PICKS.get(`picks:${SEASON}:wk${week}:${p}`, 'json')) || {};
    }

    return json({ week, currentWeek: cur, players, games, picks });
  } catch (e) {
    return json({ error: 'allpicks_failed', detail: String(e && e.message || e) }, 500);
  }
}

function fmtCentral(ms) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }).format(new Date(ms)) + ' CT';
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
