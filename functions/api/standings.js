// GET /api/standings  ->  { season:[...], weeks:[...], throughWeek }
// Both season totals and each week's per-player breakdown update live as games finish.

import { authUser } from './_auth.js';
import { getWeek, currentWeek, SEASON } from './_nfl.js';

export async function onRequestGet({ request, env }) {
  const user = await authUser(request, env);
  if (!user) return json({ error: 'Not signed in.' }, 401);

  try {
    let players;
    try { players = JSON.parse(env.PLAYERS || '[]'); } catch { players = []; }
    if (!Array.isArray(players)) players = [];

    const cur = await currentWeek(env);

    const seasonTally = {};
    players.forEach(p => seasonTally[p] = { user: p, wins: 0, losses: 0 });
    const weeks = [];

    for (let wk = 1; wk <= cur; wk++) {
      const games = await getWeek(env, wk);
      if (!games.length) continue;

      const results = {};
      for (const g of games) {
        if (g.final && g.winner) results[g.id] = g.winner;
      }
      if (!Object.keys(results).length) continue;

      const wkTally = {};
      players.forEach(p => wkTally[p] = { user: p, wins: 0, losses: 0 });

      for (const p of players) {
        const picks = (await env.PICKS.get(`picks:${SEASON}:wk${wk}:${p}`, 'json')) || {};
        for (const [gid, abbr] of Object.entries(picks)) {
          const winner = results[gid];
          if (!winner) continue;
          if (abbr === winner) { seasonTally[p].wins++; wkTally[p].wins++; }
          else { seasonTally[p].losses++; wkTally[p].losses++; }
        }
      }

      weeks.push({
        week: wk,
        revealed: true,
        results: Object.values(wkTally).sort((a, b) => b.wins - a.wins || a.losses - b.losses),
      });
    }

    const seasonArr = Object.values(seasonTally).map(t => {
      const total = t.wins + t.losses;
      return { ...t, pct: total ? (t.wins / total).toFixed(3).replace(/^0/, '') : '—' };
    }).sort((a, b) => b.wins - a.wins || a.losses - b.losses);

    return json({ season: seasonArr, weeks: weeks.reverse(), throughWeek: cur });
  } catch (e) {
    return json({ error: 'standings_failed', detail: String(e && e.message || e) }, 500);
  }
}


function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
