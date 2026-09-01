// The one place the lock rule lives. Change it here and both /week and /picks obey.
//
// RULE (weeks 1–16): every game locks exactly 5 minutes before its OWN kickoff.
// RULE (weeks 17–18): every game in the week locks 5 minutes before the EARLIEST
//   kickoff of that week — so the whole final-weeks slate freezes together at the
//   first game. (Requested so nobody picks late games after seeing earlier results
//   during the playoff-race weeks.)
//
// Using each game's real start time from the schedule feed means odd schedules —
// Thanksgiving, Saturday slates, international morning games, Christmas — all just
// work with no special cases.

const LOCK_LEAD_MINUTES = 5;

// Weeks that use the "whole slate locks at the first kickoff" rule.
const SLATE_LOCK_WEEKS = new Set([17, 18]);

// Per-game lock (weeks 1–16, and anywhere we only have one game's time).
export function lockTimeFor(kickoffMs) {
  return kickoffMs - LOCK_LEAD_MINUTES * 60000;
}

// Week-aware lock. Pass the game, all games in that week, and the week number.
// For SLATE_LOCK_WEEKS, every game locks 5 min before the week's earliest kickoff;
// otherwise it's 5 min before this game's own kickoff.
export function lockTimeForGame(game, weekGames, week) {
  if (SLATE_LOCK_WEEKS.has(week) && Array.isArray(weekGames) && weekGames.length) {
    const firstKick = Math.min(...weekGames.map(g => g.kickoffMs));
    return firstKick - LOCK_LEAD_MINUTES * 60000;
  }
  return game.kickoffMs - LOCK_LEAD_MINUTES * 60000;
}

// ---- Weekly results reveal ----
// A week's per-week results become public at 7:00am CT on the Tuesday AFTER
// that week's games (i.e. the Tuesday following that Sunday/Monday slate).
// We derive it from any kickoff in the week: find that week's Sunday, add 2 days
// to reach Tuesday, set 7:00am CT.
export function revealTimeFor(kickoffMs) {
  const dow = centralDayOfWeek(kickoffMs);
  // Shift to the Sunday of this game's week (Thu/Fri/Sat are before that Sunday).
  // Mon(1) belongs to the slate that STARTED the prior Thu–Sun, so its "week Sunday"
  // is the day before it.
  let dayShift;
  if (dow === 0) dayShift = 0;        // Sunday
  else if (dow === 1) dayShift = -1;  // Monday -> back to Sunday
  else dayShift = 7 - dow;            // Thu(4)->+3, Fri(5)->+2, Sat(6)->+1  (forward to Sunday)
  const sunday = new Date(kickoffMs + dayShift * 864e5);
  const p = centralParts(sunday.getTime());
  const tue = new Date(zonedToUtc(p.y, p.mo, p.d, 0, 0) + 2 * 864e5);
  const tp = centralParts(tue.getTime());
  return zonedToUtc(tp.y, tp.mo, tp.d, 7, 0);
}

// --- Central-time helpers (used by revealTimeFor). ---

function centralParts(ms) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  });
  const p = {};
  for (const part of fmt.formatToParts(new Date(ms))) p[part.type] = part.value;
  const wd = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 }[p.weekday];
  return { y:+p.year, mo:+p.month, d:+p.day, h:+p.hour, mi:+p.minute, s:+p.second, dow: wd };
}

function centralDayOfWeek(ms) { return centralParts(ms).dow; }

// Convert a Central wall-clock (y,mo,d,h,mi) to a correct UTC epoch ms,
// accounting for whether that date is in CDT (-5) or CST (-6).
function zonedToUtc(y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo - 1, d, h, mi) + 6 * 3600e3;
  const offMin = centralOffsetMinutes(guess);
  return Date.UTC(y, mo - 1, d, h, mi) - offMin * 60000;
}

// Central offset in minutes at a given instant (e.g. -300 for CDT, -360 for CST).
// Computed without relying on the newer 'shortOffset' Intl option: we read the
// wall-clock time that America/Chicago shows for this instant, compare it to the
// UTC wall clock for the same instant, and the difference IS the offset. Works on
// any runtime that has basic Intl timezone support (which Workers does).
function centralOffsetMinutes(ms) {
  const d = new Date(ms);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
  // Build a UTC timestamp from the Chicago wall-clock reading.
  let hh = parseInt(parts.hour, 10);
  if (hh === 24) hh = 0; // some engines emit '24' for midnight
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, hh, +parts.minute, +parts.second);
  // Difference between what Chicago's clock said and true UTC = the offset.
  return Math.round((asUTC - ms) / 60000);
}
