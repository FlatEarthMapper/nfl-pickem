// GET /api/records  ->  { records: { ABBR: "6-3" | "6-3-1", ... } }
// Separate from /api/week so the schedule loads instantly and records fill in after.
// Fail-soft: returns {} rather than erroring if the source is slow/unavailable.

import { authUser } from './_auth.js';
import { getRecords } from './_nfl.js';

export async function onRequestGet({ request, env }) {
  const user = await authUser(request, env);
  if (!user) return json({ error: 'Not signed in.' }, 401);

  let records = {};
  try {
    const full = await getRecords(env);
    // Flatten to abbr -> string for a small payload.
    for (const [abbr, r] of Object.entries(full)) records[abbr] = r.str;
  } catch {
    records = {};
  }
  return json({ records });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
