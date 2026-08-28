// GET /api/week[?week=N]  ->  { week, currentWeek, games:[...], myPicks:{gameId:abbr} }
// Fetches the NFL slate from ESPN's public (unofficial) endpoint, caches it in KV
// for an hour so we don't hammer ESPN, and computes each game's lock time.

import { authUser } from './_auth.js';
import { lockTimeFor } from './_locks.js';

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const CACHE_MINUTES = 60;

export async function onRequestGet({ request, env }) {
  const user = await authUser(request, env);
  if (!user) return json({ error: 'Not signed in.' }, 401);

  const url = new URL(request.url);
  let week = parseInt(url.searchParams.get('week') || '', 10);

  const slate = await getSlate(env, isNaN(week) ? null : week);
  const now = Date.now();

  // Attach lock state, based on server time (authoritative).
  const games = slate.games.map(g => {
    const lockMs = g.lockMs;
    return {
      ...g,
      locked: now >= lockMs,
      lockLabel: fmtCentral(lockMs, true),
    };
  });

  // Merge this user's saved picks for the week.
  const picksKey = `picks:2026:wk${slate.week}:${user}`;
  const myPicks = (await env.PICKS.get(picksKey, 'json')) || {};

  return json({ week: slate.week, currentWeek: slate.currentWeek, games, myPicks });
}

async function getSlate(env, wantWeek) {
  const cacheKey = wantWeek ? `slate:2026:wk${wantWeek}` : 'slate:2026:current';
  const cached = await env.PICKS.get(cacheKey, 'json');
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_MINUTES * 60000) {
    return cached;
  }

  const espnUrl = wantWeek ? `${ESPN}?seasontype=2&week=${wantWeek}` : ESPN;
  const resp = await fetch(espnUrl, { cf: { cacheTtl: 300 } });
  if (!resp.ok) {
    if (cached) return cached;           // serve stale on failure
    throw new Error('ESPN fetch failed');
  }
  const data = await resp.json();
  const week = data.week?.number || wantWeek || 1;
  const currentWeek = data.week?.number || week;

  const games = (data.events || []).map(ev => {
    const comp = ev.competitions[0];
    const home = comp.competitors.find(c => c.homeAway === 'home');
    const away = comp.competitors.find(c => c.homeAway === 'away');
    const kickoffMs = new Date(ev.date).getTime();
    const winner = comp.status?.type?.completed
      ? (home.winner ? home.team.abbreviation : (away.winner ? away.team.abbreviation : null))
      : null;
    return {
      id: ev.id,
      kickoffMs,
      kickoffLabel: fmtCentral(kickoffMs, false),
      lockMs: lockTimeFor(kickoffMs),
      winner,
      home: teamObj(home),
      away: teamObj(away),
    };
  }).sort((a,b) => a.kickoffMs - b.kickoffMs);

  const slate = { week, currentWeek, games, fetchedAt: Date.now() };
  // cache ~65 min; short enough that scores/records refresh, long enough to spare ESPN
  await env.PICKS.put(cacheKey, JSON.stringify(slate), { expirationTtl: 65 * 60 });
  return slate;
}

function teamObj(c) {
  const t = c.team;
  return {
    abbr: t.abbreviation,
    name: t.shortDisplayName || t.name,
    logo: t.logo || `https://a.espncdn.com/i/teamlogos/nfl/500/${t.abbreviation.toLowerCase()}.png`,
    record: (c.records && c.records[0] && c.records[0].summary) || '',
  };
}

// Format an epoch ms as US Central time.
function fmtCentral(ms, timeOnly) {
  const opts = timeOnly
    ? { timeZone: 'America/Chicago', weekday: 'short', hour: 'numeric', minute: '2-digit' }
    : { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  return new Intl.DateTimeFormat('en-US', opts).format(new Date(ms)) + ' CT';
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
