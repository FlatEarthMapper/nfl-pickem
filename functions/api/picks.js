// POST /api/picks  { week, picks: { gameId: abbr } }  ->  { myPicks, skipped }
// Authoritative lock enforcement using the live per-week schedule.

import { authUser } from './_auth.js';
import { lockTimeFor } from './_locks.js';
import { getWeek, SEASON } from './_nfl.js';

export async function onRequestPost({ request, env }) {
  const user = await authUser(request, env);
  if (!user) return json({ error: 'Not signed in.' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  const week = parseInt(body.week, 10);
  const incoming = body.picks || {};
  if (isNaN(week)) return json({ error: 'Missing week.' }, 400);

  try {
    const weekGames = await getWeek(env, week);
    const now = Date.now();
    const gameById = {};
    for (const g of weekGames) gameById[g.id] = g;

    const picksKey = `picks:${SEASON}:wk${week}:${user}`;
    const existing = (await env.PICKS.get(picksKey, 'json')) || {};
    const merged = { ...existing };
    const skipped = [];

    for (const [gid, abbr] of Object.entries(incoming)) {
      const g = gameById[gid];
      if (!g) { skipped.push(gid); continue; }
      if (now >= lockTimeFor(g.kickoffMs)) { skipped.push(gid); continue; }
      const valid = abbr === g.home.abbr || abbr === g.away.abbr;
      if (!valid) { skipped.push(gid); continue; }
      merged[gid] = abbr;
    }

    await env.PICKS.put(picksKey, JSON.stringify(merged));
    return json({
      myPicks: merged,
      skipped,
      ...(skipped.length ? { error: `${skipped.length} pick(s) were already locked and skipped.` } : {}),
    });
  } catch (e) {
    return json({ error: 'save_failed', detail: String(e && e.message || e) }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
