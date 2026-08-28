// Shared auth utilities. Files starting with _ are NOT exposed as routes.
// Tokens are "user.expiry.signature" where signature = HMAC-SHA256 over "user.expiry".

const enc = new TextEncoder();

export async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Hash a PIN salted with the server secret + the player's name.
// Without TOKEN_SECRET the stored hash is useless — so even reading KV
// (which the account owner can) reveals nothing about the PIN.
export async function hashPin(name, pin, secret) {
  return sha256Hex(`${secret}:${name}:${pin}`);
}

async function hmac(msg, secret) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

export async function signToken(user, secret, days = 120) {
  const exp = Date.now() + days * 864e5;
  const msg = `${user}.${exp}`;
  const sig = await hmac(msg, secret);
  return `${msg}.${sig}`;
}

// Returns the username if valid, else null.
export async function verifyToken(token, secret) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [user, exp, sig] = parts;
  if (Date.now() > Number(exp)) return null;
  const good = await hmac(`${user}.${exp}`, secret);
  if (good !== sig) return null;
  return user;
}

// Pull + verify the bearer token from a request. Returns username or null.
export async function authUser(request, env) {
  const h = request.headers.get('Authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  return verifyToken(token, env.TOKEN_SECRET);
}
