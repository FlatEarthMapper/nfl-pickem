// The one place the lock rule lives. Change it here and both /week and /picks obey.
//
// RULE: every game locks exactly 5 minutes before its own scheduled kickoff.
// This uses each game's real start time from ESPN, so odd schedules — Thanksgiving,
// Saturday slates, international morning games, Christmas — all just work with no
// special cases.

const LOCK_LEAD_MINUTES = 5;

export function lockTimeFor(kickoffMs) {
  return kickoffMs - LOCK_LEAD_MINUTES * 60000;
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

function centralOffsetMinutes(ms) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', timeZoneName: 'shortOffset',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const name = dtf.formatToParts(new Date(ms)).find(p => p.type === 'timeZoneName')?.value || 'GMT-6';
  const m = name.match(/GMT([+-]\d{1,2})(?::?(\d{2}))?/);
  if (!m) return -360;
  return (parseInt(m[1],10) * 60) + (m[1].startsWith('-') ? -(+(m[2]||0)) : +(m[2]||0));
}
