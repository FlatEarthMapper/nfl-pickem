// GET /api/export  ->  CSV file (text/csv) of every pick, Week 1..current.
// One row per player per game. Opens in Excel / Google Sheets. Also serves as the
// manual-tally fallback if the automatic scoring ever looks off.

import { authUser } from './_auth.js';
import { getWeek, currentWeek, SEASON } from './_nfl.js';

export async function onRequestGet({ request, env }) {
  const user = await authUser(request, env);
  if (!user) return new Response('Not signed in.', { status: 401 });

  try {
    let players;
    try { players = JSON.parse(env.PLAYERS || '[]'); } catch { players = []; }
    if (!Array.isArray(players)) players = [];

    const cur = await currentWeek(env);
    const rows = [['Week', 'Away', 'Home', 'Player', 'Pick', 'Result', 'Correct']];

    for (let wk = 1; wk <= cur; wk++) {
      const games = await getWeek(env, wk);
      if (!games.length) continue;

      const wkPicks = {};
      for (const p of players) {
        wkPicks[p] = (await env.PICKS.get(`picks:${SEASON}:wk${wk}:${p}`, 'json')) || {};
      }
      const anyPicks = players.some(p => Object.keys(wkPicks[p]).length);
      if (!anyPicks) continue;

      for (const g of games) {
        const away = g.away.name, home = g.home.name;
        const winnerName = g.final && g.winner
          ? (g.winner === g.home.abbr ? home : away) : '';
        for (const p of players) {
          const abbr = wkPicks[p][g.id];
          let pickName = '';
          if (abbr === g.home.abbr) pickName = home;
          else if (abbr === g.away.abbr) pickName = away;
          let correct = '';
          if (g.final && g.winner && abbr) correct = (abbr === g.winner) ? 'Y' : 'N';
          rows.push([`Week ${wk}`, away, home, p, pickName, winnerName, correct]);
        }
      }
    }

    const csv = rows.map(r => r.map(csvCell).join(',')).join('\r\n');
    const filename = `pickem-${SEASON}-through-week-${cur}.csv`;
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (e) {
    return new Response('export_failed: ' + String(e && e.message || e), { status: 500 });
  }
}

// Escape a CSV cell: wrap in quotes if it contains comma, quote, or newline.
function csvCell(v) {
  const s = String(v == null ? '' : v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
