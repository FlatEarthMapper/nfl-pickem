// GET /api/standings  ->  {
//   season:  [ {user, wins, losses, pct} ],          // always live, all final games
//   weeks:   [ {week, revealed, revealLabel,          // per-week, gated to 7am CT Tue
//                results:[ {user, wins, losses} ] } ],
//   throughWeek
// }
//
// Season totals are always current. Each week's individual breakdown is hidden
// until 7:00am CT on the Tuesday after that week's games — the client can then
// toggle between whichever weeks are revealed.

import { authUser } from './_auth.js';
import { revealTimeFor } from './_locks.js';

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

export async function onRequestGet({ request, env }) {
  const user = await authUser(request, env);
  if (!user) return json({ error: 'Not signed in.' }, 401);

  let players;
  try { players = JSON.parse(env.PLAYERS || '[]'); } catch { players = []; }
  if (!Array.isArray(players)) players = [];

  const cur = await currentWeek(env);
  const now = Date.now();

  const season = {};
  players.forEach(p => season[p] = { user: p, wins: 0, losses: 0 });
  const weeks = [];

  for (let wk = 1; wk <= cur; wk++) {
    const { results, anyKickoff } = await weekResults(env, wk);
    if (!Object.keys(results).length) continue;

    // Per-week tallies for every player.
    const wkTally = {};
    players.forEach(p => wkTally[p] = { user: p, wins: 0, losses: 0 });

    for (const p of players) {
      const picks = (await env.PICKS.get(`picks:2026:wk${wk}:${p}`, 'json')) || {};
      for (const [gid, abbr] of Object.entries(picks)) {
        const winner = results[gid];
        if (!winner) continue;
        if (abbr === winner) { season[p].wins++; wkTally[p].wins++; }
        else { season[p].losses++; wkTally[p].losses++; }
      }
    }

    // Reveal gate: hide the per-week numbers until 7am CT Tuesday-after.
    const revealMs = anyKickoff ? revealTimeFor(anyKickoff) : now;
    const revealed = now >= revealMs;

    weeks.push({
      week: wk,
      revealed,
      revealLabel: fmtCentral(revealMs),
      results: revealed
        ? Object.values(wkTally).sort((a,b) => b.wins - a.wins || a.losses - b.losses)
        : null,
    });
  }

  const seasonArr = Object.values(season).map(t => {
    const total = t.wins + t.losses;
    return { ...t, pct: total ? (t.wins / total).toFixed(3).replace(/^0/, '') : '—' };
  }).sort((a,b) => b.wins - a.wins || a.losses - b.losses);

  return json({ season: seasonArr, weeks: weeks.reverse(), throughWeek: cur });
}

async function currentWeek(env) {
  const cached = await env.PICKS.get('meta:currentWeek', 'json');
  if (cached && (Date.now() - cached.at) < 30 * 60000) return cached.week;
  try {
    const r = await fetch(ESPN, { cf: { cacheTtl: 300 } });
    const d = await r.json();
    const week = d.week?.number || 1;
    await env.PICKS.put('meta:currentWeek', JSON.stringify({ week, at: Date.now() }), { expirationTtl: 1800 });
    return week;
  } catch { return cached?.week || 1; }
}

async function weekResults(env, wk) {
  const key = `results:2026:wk${wk}`;
  const cached = await env.PICKS.get(key, 'json');
  if (cached && cached.allFinal) return cached;
  if (cached && (Date.now() - cached.at) < 20 * 60000) return cached;

  let data;
  try {
    const r = await fetch(`${ESPN}?seasontype=2&week=${wk}`, { cf: { cacheTtl: 300 } });
    data = await r.json();
  } catch { return cached || { results: {}, anyKickoff: null, allFinal: false }; }

  const results = {};
  let allFinal = (data.events || []).length > 0;
  let anyKickoff = null;
  for (const ev of (data.events || [])) {
    if (anyKickoff === null) anyKickoff = new Date(ev.date).getTime();
    const comp = ev.competitions[0];
    if (!comp.status?.type?.completed) { allFinal = false; continue; }
    const home = comp.competitors.find(c => c.homeAway === 'home');
    const away = comp.competitors.find(c => c.homeAway === 'away');
    results[ev.id] = home.winner ? home.team.abbreviation : away.team.abbreviation;
  }
  const out = { results, anyKickoff, allFinal, at: Date.now() };
  await env.PICKS.put(key, JSON.stringify(out), { expirationTtl: allFinal ? 30 * 864e2 : 1800 });
  return out;
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
