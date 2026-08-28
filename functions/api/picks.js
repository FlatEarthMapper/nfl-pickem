// POST /api/picks  { week, picks: { gameId: abbr } }  ->  { myPicks, skipped:[gameId] }
// Authoritative lock enforcement: we recompute each game's lock from the live slate
// and refuse to write a pick for any game past its deadline. The browser can't lie
// its way past this because we don't trust the client's idea of "locked".

import { authUser } from './_auth.js';
import { lockTimeFor } from './_locks.js';

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

export async function onRequestPost({ request, env }) {
  const user = await authUser(request, env);
  if (!user) return json({ error: 'Not signed in.' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  const week = parseInt(body.week, 10);
  const incoming = body.picks || {};
  if (isNaN(week)) return json({ error: 'Missing week.' }, 400);

  // Pull the authoritative slate (cached) to know each game's lock + valid teams.
  const slate = await getSlate(env, week);
  const now = Date.now();
  const gameById = {};
  for (const g of slate.games) gameById[g.id] = g;

  const picksKey = `picks:2026:wk${week}:${user}`;
  const existing = (await env.PICKS.get(picksKey, 'json')) || {};
  const merged = { ...existing };
  const skipped = [];

  for (const [gid, abbr] of Object.entries(incoming)) {
    const g = gameById[gid];
    if (!g) { skipped.push(gid); continue; }              // unknown game
    if (now >= g.lockMs) { skipped.push(gid); continue; }  // locked — cannot change
    const valid = abbr === g.home.abbr || abbr === g.away.abbr;
    if (!valid) { skipped.push(gid); continue; }           // team not in this game
    merged[gid] = abbr;
  }

  await env.PICKS.put(picksKey, JSON.stringify(merged));

  const status = skipped.length ? 200 : 200;
  return json({
    myPicks: merged,
    skipped,
    ...(skipped.length ? { error: `${skipped.length} pick(s) were already locked and skipped.` } : {}),
  }, status);
}

// Same slate fetch/cache as week.js (kept local to avoid cross-import coupling).
async function getSlate(env, week) {
  const cacheKey = `slate:2026:wk${week}`;
  const cached = await env.PICKS.get(cacheKey, 'json');
  if (cached && (Date.now() - cached.fetchedAt) < 60 * 60000) return withLocks(cached);

  const resp = await fetch(`${ESPN}?seasontype=2&week=${week}`, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PickemApp/1.0)', 'Accept': 'application/json' } });
  if (!resp.ok) { if (cached) return withLocks(cached); throw new Error('ESPN fetch failed'); }
  const data = await resp.json();
  const games = (data.events || []).map(ev => {
    const comp = ev.competitions[0];
    const home = comp.competitors.find(c => c.homeAway === 'home');
    const away = comp.competitors.find(c => c.homeAway === 'away');
    return {
      id: ev.id,
      kickoffMs: new Date(ev.date).getTime(),
      home: { abbr: home.team.abbreviation },
      away: { abbr: away.team.abbreviation },
    };
  });
  const slate = { week, games, fetchedAt: Date.now() };
  await env.PICKS.put(cacheKey, JSON.stringify(slate), { expirationTtl: 65 * 60 });
  return withLocks(slate);
}

function withLocks(slate) {
  return { ...slate, games: slate.games.map(g => ({ ...g, lockMs: lockTimeFor(g.kickoffMs) })) };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
