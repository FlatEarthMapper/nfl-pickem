// Shared NFL data layer, backed by TheSportsDB's free API.
// One season-wide fetch, cached hard in KV, sliced into weeks. This keeps us far
// under the free-tier rate limit (the whole season is one request) and gives every
// endpoint the same normalized game shape.
//
// TheSportsDB facts (verified from live data):
//  - Free key is "123". NFL league id is 4391.
//  - eventsseason.php returns the ENTIRE season (pre + regular + post) in one blob.
//  - strTimestamp is UTC, full date+time, e.g. "2025-09-08T00:20:00" -> plug into locks.
//  - intRound codes the week: regular-season weeks are 1..18; preseason is 500-level;
//    postseason is 160+/higher. We keep only 1..18 and treat intRound as the week.
//  - Team abbreviations aren't provided, so we map team NAME -> abbr below.

const KEY = '123';
const LEAGUE = '4391';
// ====================================================================
// SEASON TOGGLE — the ONLY place to change the season.
// '2025' = last season, has full data, use it to TEST the app right now.
// '2026' = the real season (games post ~early September 2026).
// The front end never sets this; the server decides. One line, one file.
// ====================================================================
export const SEASON = '2025';
const BASE = `https://www.thesportsdb.com/api/v1/json/${KEY}`;
const CACHE_SECONDS = 60 * 60;            // refresh the season blob hourly

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
  // Fallback: last word, uppercased, first 3 letters — keeps things from crashing
  // if a name ever arrives slightly different than expected.
  const w = (name || '').trim().split(/\s+/).pop() || 'UNK';
  return w.slice(0, 3).toUpperCase();
}

function shortName(name) {
  // "Green Bay Packers" -> "Packers"; used for the compact label under each logo.
  const parts = (name || '').trim().split(/\s+/);
  return parts[parts.length - 1] || name || '';
}

// Round -> week. Regular season only (1..18). Everything else returns null.
function weekFromRound(intRound) {
  const r = parseInt(intRound, 10);
  if (!isFinite(r)) return null;
  if (r >= 1 && r <= 18) return r;
  return null; // 500-level preseason, 160+ postseason, etc.
}

// Fetch + cache the whole season, normalized. Returns { games:[...], fetchedAt }.
// Each game: { id, week, kickoffMs, home:{abbr,name}, away:{abbr,name},
//              homeLogo, awayLogo, winner|null, final:bool }.
export async function getSeason(env) {
  const cacheKey = `sdb:season:${SEASON}`;
  const cached = await env.PICKS.get(cacheKey, 'json');
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_SECONDS * 1000) return cached;

  const url = `${BASE}/eventsseason.php?id=${LEAGUE}&s=${SEASON}`;
  let data;
  try {
    const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!resp.ok) {
      if (cached) return cached;               // serve stale on failure
      throw new Error(`schedule source failed (status ${resp.status})`);
    }
    data = await resp.json();
  } catch (e) {
    if (cached) return cached;
    throw e;
  }

  const events = (data && data.events) || [];
  const games = [];
  for (const ev of events) {
    try {
      const week = weekFromRound(ev.intRound);
      if (week == null) continue;              // skip preseason/postseason
      const ts = ev.strTimestamp;              // UTC
      const kickoffMs = ts ? Date.parse(ts.endsWith('Z') ? ts : ts + 'Z') : NaN;
      if (!isFinite(kickoffMs)) continue;

      const homeName = ev.strHomeTeam, awayName = ev.strAwayTeam;
      if (!homeName || !awayName) continue;

      const hs = ev.intHomeScore, as = ev.intAwayScore;
      const final = ev.strStatus === 'FT' || ev.strStatus === 'AOT' ||
                    (hs !== null && hs !== '' && as !== null && as !== '' &&
                     ev.strStatus && ev.strStatus !== 'NS');
      let winner = null;
      if (final && hs !== '' && as !== '' && hs != null && as != null) {
        const h = parseInt(hs, 10), a = parseInt(as, 10);
        if (isFinite(h) && isFinite(a) && h !== a) {
          winner = h > a ? abbrFor(homeName) : abbrFor(awayName);
        }
      }

      games.push({
        id: ev.idEvent,
        week,
        kickoffMs,
        home: { abbr: abbrFor(homeName), name: shortName(homeName) },
        away: { abbr: abbrFor(awayName), name: shortName(awayName) },
        homeLogo: ev.strHomeTeamBadge || '',
        awayLogo: ev.strAwayTeamBadge || '',
        winner,
        final: !!final,
      });
    } catch (e) {
      continue; // skip any malformed event rather than failing the whole season
    }
  }

  games.sort((a, b) => a.kickoffMs - b.kickoffMs);
  const out = { games, fetchedAt: Date.now() };
  await env.PICKS.put(cacheKey, JSON.stringify(out), { expirationTtl: CACHE_SECONDS + 300 });
  return out;
}

// Which week is "current"? The earliest week that still has an unfinished game,
// else the latest week present (season over), else 1 (season not started).
export function currentWeekOf(season) {
  const now = Date.now();
  const weeks = [...new Set(season.games.map(g => g.week))].sort((a, b) => a - b);
  if (!weeks.length) return 1;
  for (const w of weeks) {
    const games = season.games.filter(g => g.week === w);
    const allDone = games.every(g => g.final || now > g.kickoffMs + 6 * 3600e3);
    if (!allDone) return w;
  }
  return weeks[weeks.length - 1];
}

export function gamesForWeek(season, week) {
  return season.games.filter(g => g.week === week);
}

export function weeksPresent(season) {
  return [...new Set(season.games.map(g => g.week))].sort((a, b) => a - b);
}
