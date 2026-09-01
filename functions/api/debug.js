// TEMPORARY diagnostic — GET /api/debug
// Figures out how to get REGULAR-SEASON games from TheSportsDB.
// DELETE THIS FILE once the schedule works.

const KEY = '123';
const LEAGUE = '4391';
const BASE = `https://www.thesportsdb.com/api/v1/json/${KEY}`;

async function getJson(url) {
  const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!r.ok) return { __status: r.status };
  return await r.json();
}

export async function onRequestGet() {
  const report = {};

  // 1. eventsseason for a few season strings — how many events, and round breakdown.
  for (const s of ['2025', '2025-2026', '2024-2025']) {
    try {
      const d = await getJson(`${BASE}/eventsseason.php?id=${LEAGUE}&s=${s}`);
      if (d.__status) { report[`season_${s}`] = { status: d.__status }; continue; }
      const events = (d && d.events) || [];
      const roundCounts = {};
      let minDate = null, maxDate = null;
      for (const ev of events) {
        const k = String(ev.intRound);
        roundCounts[k] = (roundCounts[k] || 0) + 1;
        if (!minDate || ev.dateEvent < minDate) minDate = ev.dateEvent;
        if (!maxDate || ev.dateEvent > maxDate) maxDate = ev.dateEvent;
      }
      report[`season_${s}`] = { totalEvents: events.length, roundCounts, minDate, maxDate };
    } catch (e) { report[`season_${s}`] = { error: String(e.message || e) }; }
  }

  // 2. eventsround for Week 1 of 2025 — does round-based fetch return real games?
  for (const s of ['2025', '2025-2026']) {
    try {
      const d = await getJson(`${BASE}/eventsround.php?id=${LEAGUE}&r=1&s=${s}`);
      if (d.__status) { report[`round1_${s}`] = { status: d.__status }; continue; }
      const events = (d && d.events) || [];
      report[`round1_${s}`] = {
        count: events.length,
        sample: events.slice(0, 3).map(ev => ({
          event: ev.strEvent, round: ev.intRound, date: ev.dateEvent, ts: ev.strTimestamp,
        })),
      };
    } catch (e) { report[`round1_${s}`] = { error: String(e.message || e) }; }
  }

  return new Response(JSON.stringify(report, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  });
}
