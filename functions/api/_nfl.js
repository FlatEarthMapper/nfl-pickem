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

const LEAGUE = '4391';

// API key: use the private key from the SPORTSDB_KEY secret if set, else the shared
// free test key "123". Add SPORTSDB_KEY as a Cloudflare secret (like TOKEN_SECRET)
// to switch to your own premium key — no code change needed. The free "123" key is
// shared by everyone (30 req/min total → frequent 429s); a premium key is yours
// alone (100 req/min).
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
const WEEK_CACHE_SECONDS = 60 * 15;              // consider a week's games "fresh" for 15 min (snappier scores/records)
const STALE_KEEP_SECONDS = 60 * 60 * 24 * 3;     // but KEEP the cached copy 3 days, to serve stale during rate-limit spells
const FETCH_TIMEOUT_MS = 8000;                   // never wait more than 8s on the upstream feed; abort and serve stale
const RECORDS_CACHE_SECONDS = 60 * 30;           // cache computed team records for 30 min
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

// Fetch one week's games (with KV cache). Returns an array of normalized games.
// Rate-limit resilient: on any fetch failure (including 429), we serve the last
// good cached copy if we have one, even if it's "expired" for freshness purposes.
// We keep a long-lived stale copy specifically so a rate-limited fetch never breaks
// the page.
export async function getWeek(env, week) {
  const cacheKey = `sdb:${SEASON}:wk${week}`;
  const cached = await env.PICKS.get(cacheKey, 'json');
  const fresh = cached && (Date.now() - cached.fetchedAt) < WEEK_CACHE_SECONDS * 1000;
  if (fresh) return cached.games;

  const url = `${baseUrl(env)}/eventsround.php?id=${LEAGUE}&r=${week}&s=${SEASON}`;
  let data;
  try {
    // Hard timeout: never wait more than FETCH_TIMEOUT_MS on the upstream. If it's
    // slow/hanging (rate-limited shared key), abort and fall back to stale cache so
    // the page returns in seconds instead of hanging ~40s.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) {
      // Rate-limited or errored: fall back to stale cache if we have ANY.
      if (cached) return cached.games;
      throw new Error(`schedule source failed (status ${resp.status})`);
    }
    data = await resp.json();
  } catch (e) {
    // Timeout (AbortError) or network error: serve stale cache if we have it.
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
  // Keep cache entries alive far longer than their freshness window, so a stale
  // copy is always available to serve during a rate-limit spell.
  await env.PICKS.put(cacheKey, JSON.stringify({ games, fetchedAt: Date.now() }),
    { expirationTtl: STALE_KEEP_SECONDS });
  return games;
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

// Compute every team's W-L-T record from completed games, weeks 1..current.
// Cached so the Make Picks / Board screens don't recompute it constantly. Because
// getWeek serves from cache, this walk is mostly cache hits, not new API calls.
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

  let cur;
  try { cur = await currentWeek(env); } catch { cur = NUM_WEEKS; }

  // Fetch all needed weeks in PARALLEL, not one-at-a-time. A sequential loop mid-
  // season means 7+ back-to-back API calls that can hang or rate-limit the whole
  // page; in parallel they overlap and any single failure is isolated.
  const weekNums = [];
  for (let wk = 1; wk <= cur; wk++) weekNums.push(wk);
  const weekResults = await Promise.all(
    weekNums.map(wk => getWeek(env, wk).catch(() => []))
  );

  for (const games of weekResults) {
    for (const g of games) {
      if (!g.final) continue;
      if (g.tie) { bump(g.home.abbr, 't'); bump(g.away.abbr, 't'); }
      else if (g.winner) {
        const loser = g.winner === g.home.abbr ? g.away.abbr : g.home.abbr;
        bump(g.winner, 'w'); bump(loser, 'l');
      }
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
