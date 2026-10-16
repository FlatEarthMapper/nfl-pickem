// Shared NFL data layer, backed by TheSportsDB (premium tier).
//
// We fetch the WHOLE season in one call via eventsseason.php, cache it, and slice
// weeks from it. With a premium key this endpoint returns the full regular season,
// so one request covers everything — far lighter than per-week calls.
//
// Verified from live data:
//  - NFL league id 4391. Season string is the plain year, e.g. "2026".
//  - eventsseason.php (premium key) returns the full season; regular-season games
//    are intRound 1..18, preseason is 500-level (skipped), postseason is higher.
//  - strTimestamp is UTC -> plug straight into the lock math.

const LEAGUE = '4391';

// API key: the private key from the SPORTSDB_KEY secret (premium: 100 req/min, not
// shared). Falls back to the free shared test key "123" only if the secret is
// missing — that fallback is slow and rate-limited and shouldn't be relied on.
function baseUrl(env) {
  const key = (env && env.SPORTSDB_KEY) ? env.SPORTSDB_KEY : '123';
  return `https://www.thesportsdb.com/api/v1/json/${key}`;
}

// ====================================================================
// SEASON TOGGLE — the ONLY place to change the season.
// '2025' = last season, full data, use it to TEST right now.
// '2026' = the real season (regular-season rounds populate ~early Sept 2026).
// ====================================================================
export const SEASON = '2026';
// Premium tier gives plenty of rate-limit headroom (100 req/min), so we cache only
// briefly for freshness — scores and standings update within a few minutes.
const SEASON_CACHE_SECONDS = 60 * 3;             // season data is "fresh" for 3 min
const STALE_KEEP_SECONDS = 60 * 60 * 24;         // keep a stale copy 1 day as a safety net on any upstream blip
const FETCH_TIMEOUT_MS = 8000;                   // never wait more than 8s on the upstream feed; abort and serve stale
const RECORDS_CACHE_SECONDS = 60 * 3;            // records refresh within a few minutes too
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

function normalizeEvent(ev) {
  // Week comes from intRound. Regular season = rounds 1..18. Preseason is 500-level,
  // postseason is 160+/other — we skip anything outside 1..18.
  const round = parseInt(ev.intRound, 10);
  if (!(round >= 1 && round <= 18)) return null;
  const week = round;

  const ts = ev.strTimestamp;
  const kickoffMs = ts ? Date.parse(ts.endsWith('Z') ? ts : ts + 'Z') : NaN;
  if (!isFinite(kickoffMs)) return null;
  const homeName = ev.strHomeTeam, awayName = ev.strAwayTeam;
  if (!homeName || !awayName) return null;

  const hs = ev.intHomeScore, as = ev.intAwayScore;
  const final = ev.strStatus === 'FT' || ev.strStatus === 'AOT';
  let winner = null;
  let tie = false;
  if (final && hs !== '' && as !== '' && hs != null && as != null) {
    const h = parseInt(hs, 10), a = parseInt(as, 10);
    if (isFinite(h) && isFinite(a)) {
      if (h === a) tie = true;
      else winner = h > a ? abbrFor(homeName) : abbrFor(awayName);
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
    tie,
    final: !!final,
  };
}

// Fetch the WHOLE season once (one API call) via eventsseason.php, normalize every
// regular-season game, and cache it. With a premium key this endpoint returns the
// full season, so one request replaces 18 per-round calls. getWeek() just slices
// this cached set by week.
//
// Rate-limit resilient: on any failure we serve the last good cached copy even if
// stale, so a hiccup never breaks the page.
async function getSeason(env) {
  const cacheKey = `sdb:${SEASON}:season`;
  const cached = await env.PICKS.get(cacheKey, 'json');
  const fresh = cached && (Date.now() - cached.fetchedAt) < SEASON_CACHE_SECONDS * 1000;
  if (fresh) return cached.games;

  const url = `${baseUrl(env)}/eventsseason.php?id=${LEAGUE}&s=${SEASON}`;
  let data;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
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
      const g = normalizeEvent(ev); // skips non-regular-season automatically
      if (g) games.push(g);
    } catch (e) { /* skip malformed */ }
  }
  games.sort((a, b) => a.kickoffMs - b.kickoffMs);
  await env.PICKS.put(cacheKey, JSON.stringify({ games, fetchedAt: Date.now() }),
    { expirationTtl: STALE_KEEP_SECONDS });
  return games;
}

// One week's games — just the cached season filtered to that week.
export async function getWeek(env, week) {
  const season = await getSeason(env);
  return season.filter(g => g.week === week);
}

export function gamesForWeek(seasonOrGames, week) {
  // Back-compat helper: if given an array, filter it; callers now pass games directly.
  if (Array.isArray(seasonOrGames)) return seasonOrGames.filter(g => g.week === week);
  return [];
}

// Determine the "current" week from the CALENDAR — no API calls, so it can never
// hang, rate-limit, or get stuck on a stale value (the failure modes of the old
// scan-the-weeks approach).
//
// NFL weeks run Thursday→Wednesday. We anchor to the Wednesday just before Week 1's
// first game, then every 7 days is the next week boundary. Clamped to 1..NUM_WEEKS.
//
// SEASON_WEEK1_ANCHOR is that Wednesday 00:00 CT as an epoch-ms, i.e. the start of
// Week 1's window. For 2026, Week 1 opened Wed Sep 9 / Thu Sep 10, so the anchor is
// Wed Sep 9 2026 00:00 CT.
const SEASON_WEEK1_ANCHOR = Date.parse('2026-09-09T05:00:00Z'); // 2026-09-09 00:00 CT (CDT = UTC-5)

// Pure calendar estimate — instant, no API calls.
function calendarWeek(now = Date.now()) {
  if (now < SEASON_WEEK1_ANCHOR) return 1;
  const weeksElapsed = Math.floor((now - SEASON_WEEK1_ANCHOR) / (7 * 864e5));
  return Math.min(NUM_WEEKS, Math.max(1, 1 + weeksElapsed));
}

export async function currentWeek(env) {
  // Start from the calendar estimate (instant, can't hang). Then do a BOUNDED
  // confirmation — at most 2 cheap, cached fetches — so if the anchor is off by a
  // week we still land somewhere sensible. This can never slow-scan the whole
  // season the way the old version did.
  const guess = calendarWeek();

  // If the guessed week has games, trust it.
  try {
    const g = await getWeek(env, guess);
    if (g.length) return guess;
  } catch { return guess; } // fetch failed — the calendar guess is our best answer

  // Guessed week had no games (anchor slightly off, or a between-weeks gap).
  // Check the previous week once; if it has games, use it. Otherwise keep the guess.
  if (guess > 1) {
    try {
      const prev = await getWeek(env, guess - 1);
      if (prev.length) return guess - 1;
    } catch { /* fall through */ }
  }
  return guess;
}

export { NUM_WEEKS };

// Compute every team's W-L-T record from all completed games. Walks the one cached
// season object in a single pass — no per-week loop, no extra API calls.
// Returns a map: { ABBR: { w, l, t, str } } where str is like "6-3-1" (or "6-3" if no ties).
export async function getRecords(env) {
  const cacheKey = `sdb:${SEASON}:records`;
  const cached = await env.PICKS.get(cacheKey, 'json');
  if (cached && (Date.now() - cached.at) < RECORDS_CACHE_SECONDS * 1000) {
    return cached.records;
  }

  const rec = {}; // abbr -> {w,l,t}
  const bump = (abbr, key) => {
    if (!rec[abbr]) rec[abbr] = { w: 0, l: 0, t: 0 };
    rec[abbr][key]++;
  };

  let season = [];
  try { season = await getSeason(env); } catch { season = []; }

  for (const g of season) {
    if (!g.final) continue;
    if (g.tie) { bump(g.home.abbr, 't'); bump(g.away.abbr, 't'); }
    else if (g.winner) {
      const loser = g.winner === g.home.abbr ? g.away.abbr : g.home.abbr;
      bump(g.winner, 'w'); bump(loser, 'l');
    }
  }

  const records = {};
  for (const [abbr, r] of Object.entries(rec)) {
    records[abbr] = { ...r, str: r.t > 0 ? `${r.w}-${r.l}-${r.t}` : `${r.w}-${r.l}` };
  }
  await env.PICKS.put(cacheKey, JSON.stringify({ records, at: Date.now() }),
    { expirationTtl: RECORDS_CACHE_SECONDS + 300 });
  return records;
}

// Look up one team's record string, '' if none yet (e.g. week 1, no games played).
export function recordStr(records, abbr) {
  return (records && records[abbr] && records[abbr].str) || '';
}
