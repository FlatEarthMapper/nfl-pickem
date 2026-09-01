// Shared NFL data layer, backed by TheSportsDB's free API.
//
// IMPORTANT: the free tier's eventsseason.php only returns ~15 preseason games,
// NOT the regular season. The endpoint that DOES return real weeks is
// eventsround.php?id=4391&r=<week>&s=<year>, which returns all 16 games for that
// week. So we fetch PER ROUND (per week) and cache each week hard in KV.
//
// Verified from live data:
//  - Free key "123", NFL league id 4391.
//  - eventsround.php?r=1&s=2025 -> 16 Week 1 games, correct UTC strTimestamp.
//  - Regular season is rounds 1..18. Season string is the plain year, e.g. "2025".
//  - strTimestamp is UTC -> plug straight into the lock math.

const KEY = '123';
const LEAGUE = '4391';

// ====================================================================
// SEASON TOGGLE — the ONLY place to change the season.
// '2025' = last season, full data, use it to TEST right now.
// '2026' = the real season (regular-season rounds populate ~early Sept 2026).
// ====================================================================
export const SEASON = '2025';

const BASE = `https://www.thesportsdb.com/api/v1/json/${KEY}`;
const WEEK_CACHE_SECONDS = 60 * 60;       // cache each week's games for an hour
const NUM_WEEKS = 18;

// Canonical NFL team name -> abbreviation (standard NFL team codes).
const ABBR = {
  'Arizona Cardinals':'ARI','Atlanta Falcons':'ATL','Baltimore Ravens':'BAL','Buffalo Bills':'BUF',
  'Carolina Panthers':'CAR','Chicago Bears':'CHI','Cincinnati Bengals':'CIN','Cleveland Browns':'CLE',
  'Dallas Cowboys':'DAL','Denver Broncos':'DEN','Detroit Lions':'DET','Green Bay Packers':'GB',
  'Houston Texans':'HOU','Indianapolis Colts':'IND','Jacksonville Jaguars':'JAX','Kansas City Chiefs':'KC',
  'Las Vegas Raiders':'LV','Los Angeles Chargers':'LAC','Los Angeles Rams':'LAR','Miami Dolphins':'MIA',
  'Minnesota Vikings':'MIN','New England Patriots':'NE','New Orleans Saints':'NO','New York Giants':'NYG',
  'New York Jets':'NYJ','Philadelphia Eagles':'PHI','Pittsburgh Steelers':'PIT','San Francisco 49ers':'SF',
  'Seattle Seahawks':'SEA','Tampa Bay Buccaneers':'TB','Tennessee Titans':'TEN','Washington Commanders':'WAS',
};

function abbrFor(name) {
  if (ABBR[name]) return ABBR[name];
  const w = (name || '').trim().split(/\s+/).pop() || 'UNK';
  return w.slice(0, 3).toUpperCase();
}

function shortName(name) {
  const parts = (name || '').trim().split(/\s+/);
  return parts[parts.length - 1] || name || '';
}

function normalizeEvent(ev, week) {
  const ts = ev.strTimestamp;
  const kickoffMs = ts ? Date.parse(ts.endsWith('Z') ? ts : ts + 'Z') : NaN;
  if (!isFinite(kickoffMs)) return null;
  const homeName = ev.strHomeTeam, awayName = ev.strAwayTeam;
  if (!homeName || !awayName) return null;

  const hs = ev.intHomeScore, as = ev.intAwayScore;
  const final = ev.strStatus === 'FT' || ev.strStatus === 'AOT';
  let winner = null;
  if (final && hs !== '' && as !== '' && hs != null && as != null) {
    const h = parseInt(hs, 10), a = parseInt(as, 10);
    if (isFinite(h) && isFinite(a) && h !== a) {
      winner = h > a ? abbrFor(homeName) : abbrFor(awayName);
    }
  }
  return {
    id: ev.idEvent,
    week,
    kickoffMs,
    home: { abbr: abbrFor(homeName), name: shortName(homeName) },
    away: { abbr: abbrFor(awayName), name: shortName(awayName) },
    homeLogo: ev.strHomeTeamBadge || '',
    awayLogo: ev.strAwayTeamBadge || '',
    winner,
    final: !!final,
  };
}

// Fetch one week's games (with KV cache). Returns an array of normalized games.
export async function getWeek(env, week) {
  const cacheKey = `sdb:${SEASON}:wk${week}`;
  const cached = await env.PICKS.get(cacheKey, 'json');
  if (cached && (Date.now() - cached.fetchedAt) < WEEK_CACHE_SECONDS * 1000) {
    return cached.games;
  }
  const url = `${BASE}/eventsround.php?id=${LEAGUE}&r=${week}&s=${SEASON}`;
  let data;
  try {
    const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!resp.ok) {
      if (cached) return cached.games;
      throw new Error(`schedule source failed (status ${resp.status})`);
    }
    data = await resp.json();
  } catch (e) {
    if (cached) return cached.games;
    throw e;
  }
  const events = (data && data.events) || [];
  const games = [];
  for (const ev of events) {
    try {
      const g = normalizeEvent(ev, week);
      if (g) games.push(g);
    } catch (e) { /* skip malformed */ }
  }
  games.sort((a, b) => a.kickoffMs - b.kickoffMs);
  await env.PICKS.put(cacheKey, JSON.stringify({ games, fetchedAt: Date.now() }),
    { expirationTtl: WEEK_CACHE_SECONDS + 300 });
  return games;
}

export function gamesForWeek(seasonOrGames, week) {
  // Back-compat helper: if given an array, filter it; callers now pass games directly.
  if (Array.isArray(seasonOrGames)) return seasonOrGames.filter(g => g.week === week);
  return [];
}

// Determine the "current" week: the earliest week that still has an unfinished game.
// We check weeks in order and stop at the first with a game not yet final and not
// long past. Falls back to 1. Reads from cache/fetch per week (cheap once cached).
export async function currentWeek(env) {
  const now = Date.now();
  for (let w = 1; w <= NUM_WEEKS; w++) {
    let games;
    try { games = await getWeek(env, w); } catch { return w; }
    if (!games.length) continue;
    const allDone = games.every(g => g.final || now > g.kickoffMs + 6 * 3600e3);
    if (!allDone) return w;
  }
  return NUM_WEEKS; // season over (or all cached weeks complete)
}

export { NUM_WEEKS };
