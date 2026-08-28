# The Pick'em — NFL weekly pick'em for three friends

Same stack as the tree sale: **GitHub → Cloudflare Pages → Workers KV**.
Everything auto-deploys when you push to GitHub. No servers, no monthly cost.

## What each file does
```
index.html                     the whole front end (login, picks, standings)
functions/api/login.js         checks a player's PIN, hands back a signed token
functions/api/week.js          pulls the week's games from ESPN, computes locks
functions/api/picks.js         saves picks, refuses anything past its lock time
functions/api/standings.js     scores everyone's picks vs. final results
functions/api/_auth.js         PIN hashing + token signing/verifying (not a route)
functions/api/_locks.js        THE LOCK RULE — 5 min before each kickoff
```
Files under `functions/` become live endpoints automatically (e.g. `functions/api/week.js` → `/api/week`). Files starting with `_` are shared code, **not** routes.

## One-time setup

### 1. Player names
The three names live in two places that must match exactly:
- In **`index.html`**: `const PLAYERS = ["Andy", "Rick", "Jim"]` (the login buttons).
- In the **`PLAYERS`** secret in Cloudflare (below).

### 2. Players set their own PINs — you don't touch them
There's nothing to generate. Each person visits the site, taps their name, and types a **4-digit PIN of their choosing**. The first PIN entered for a name claims it, and that name is locked to that PIN. You (the commissioner) never see it: the PIN is salted with your `TOKEN_SECRET` and hashed before storage, so even the raw KV entry is meaningless without that secret.

> A forgotten PIN can't be recovered, only reset. To reset one, delete the `acct:<name>` key from the `pickem` KV namespace in the Cloudflare dashboard — that name's next login sets a fresh PIN.

### 3. GitHub
Repo holds the seven files, keeping the `functions/api/` folder structure intact. If the web uploader flattens folders, create the files directly in GitHub's editor and type the full path (e.g. `functions/api/login.js`).

### 4. Cloudflare Pages
- **Create a Pages project** connected to the repo. Framework preset: None; Build command: empty; Output dir: `/`.
- **Create a KV namespace** — call it `pickem`.
- In **Settings → Functions → KV namespace bindings**, add:
  - Variable name: **`PICKS`** → your `pickem` namespace. *(The code reads `env.PICKS`; the name must match exactly.)*
- In **Settings → Environment variables**, add (as encrypted / "Secret"):
  - **`PLAYERS`** = a JSON **array of the allowed names**, matching `index.html`. For this setup: `["Andy","Rick","Jim"]`. (Controls who's allowed to claim a slot — no PINs live here.)
  - **`TOKEN_SECRET`** = any long random string (mash the keyboard, 40+ chars). This both signs login tokens **and salts the PIN hashes**, so keep it private and **don't change it after people set PINs** — changing it invalidates every PIN.
- Redeploy (any push triggers it, or hit Retry deployment).

That's it. Visit the site, tap your name, set your PIN, make picks.

## The lock rule
Lives entirely in **`functions/api/_locks.js`**:
- **Every game locks 5 minutes before its own scheduled kickoff.** One rule, whole season.
- Because it reads each game's real start time from ESPN, odd schedules need no special handling: Thanksgiving's games, Saturday slates, international morning kickoffs, and Christmas games all lock 5 minutes before they each start.
- To change the lead time, edit `LOCK_LEAD_MINUTES` at the top of that file.

Locks are enforced **on the server** in both `week.js` (what you can click) and `picks.js` (what actually saves), so no one can beat the deadline by fiddling with the browser. All times computed in US Central with DST handled automatically.

This means picks can be made game-by-game right up to each kickoff, rather than committing the whole week at once — so late games can be picked after early ones have started.

## Standings & the weekly reveal
The Standings tab shows two things:
- A live **season** table (rank, W, L, Pct) that updates the moment games go final.
- A **weekly** section you can toggle through. Each week's individual per-player results stay hidden until **7:00am CT the Tuesday after** that week's games — so nobody peeks at the weekly scoreboard while Monday night is still live. Season totals are always current; only the per-week breakdown is gated.

Everything re-scores from ESPN automatically — you never hand-enter a result.

> Note: the 7am-Tuesday reveal is a *display* gate — the site hides the numbers until then, but a static site can't push a notification on its own. If you ever want a message sent to the group every Tuesday morning, that's a separate add-on (a scheduled Cloudflare Cron Worker).

## Notes & gotchas
- **ESPN's API is unofficial.** Free and reliable enough for this, but not guaranteed. The code caches each week's slate in KV for ~1 hour, so you hit ESPN rarely and the site stays fast. If ESPN ever changes shape, the field names to check are in `week.js`.
- **PIN security:** a 4-digit PIN is friends-and-football security, not bank security — 10,000 combinations. Salting means reading the database reveals no PINs, but tell your friends not to reuse a PIN they use anywhere real.
- **Free-tier writes:** each saved pick set is one KV write. Three people × 18 weeks is trivial against the 1,000/day limit.
- **Team logos** come straight from ESPN's CDN — no assets to host.
- **Changing a pick** before lock just overwrites the old one. After lock, the game is frozen.
- **New season:** the KV keys are namespaced `...2026...`. Bump the year in the code next season to start clean, or wipe the `pickem` namespace.
