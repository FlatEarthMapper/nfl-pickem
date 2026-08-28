// POST /api/login  { user, pin }  ->  { token, justRegistered? }
//
// Each player sets their OWN 4-digit PIN the first time they sign in.
// - PLAYERS is just the ALLOWED NAMES (JSON array), so nobody can invent a slot.
// - The PIN is hashed with the server secret + name (see hashPin) and stored in KV
//   under acct:<name>. Only the hash is stored; the raw PIN is never saved and the
//   hash can't be reversed without TOKEN_SECRET (which the players never see).
// - First person to sign in as a given name sets that name's PIN. After that it's
//   locked to that PIN.

import { hashPin, signToken } from './_auth.js';

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  const user = (body.user || '').trim();
  const pin = (body.pin || '').trim();

  if (!user) return json({ error: 'Pick your name.' }, 400);
  if (!/^\d{4}$/.test(pin)) return json({ error: 'PIN must be exactly 4 digits.' }, 400);

  // Allowed names: JSON array like ["Andy","Sam","Pat"].
  let allowed;
  try { allowed = JSON.parse(env.PLAYERS || '[]'); } catch { allowed = []; }
  if (!Array.isArray(allowed) || !allowed.includes(user)) {
    return json({ error: 'Unknown player.' }, 401);
  }

  const acctKey = `acct:${user}`;
  const stored = await env.PICKS.get(acctKey);            // salted hash, or null if unclaimed
  const submitted = await hashPin(user, pin, env.TOKEN_SECRET);

  if (!stored) {
    // First claim — this PIN becomes the player's PIN.
    await env.PICKS.put(acctKey, submitted);
    const token = await signToken(user, env.TOKEN_SECRET);
    return json({ token, justRegistered: true });
  }

  if (submitted.length !== stored.length || submitted !== stored) {
    return json({ error: 'Wrong PIN.' }, 401);
  }

  const token = await signToken(user, env.TOKEN_SECRET);
  return json({ token });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
