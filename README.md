# The Pick'em — NFL weekly pick'em for three friends

Same stack as your tree sale: **GitHub → Cloudflare Pages → Workers KV**.
Everything auto-deploys when you push to GitHub. No servers, no monthly cost.

## What each file does
```
index.html                     the whole front end (login, picks, standings)
make-passwords.html            open locally to hash passphrases (setup only)
functions/api/login.js         checks passphrase, hands back a signed token
functions/api/week.js          pulls the week's games from ESPN, computes locks
functions/api/picks.js         saves picks, refuses anything past its lock time
functions/api/standings.js     scores everyone's picks vs. final results
functions/api/_auth.js         token signing/verifying (not a public route)
functions/api/_locks.js        THE LOCK RULE — Thursday & Sunday-noon cutoffs
```
Files under `functions/` become live endpoints automatically (e.g. `functions/api/week.js` → `/api/week`). Files starting with `_` are shared code, **not** routes.

## One-time setup

### 1. Edit the three player names
- In **`index.html`**, find `const PLAYERS = ["Andy", "Friend2", "Friend3"]` and set your three names.
- Use those exact same names in the `PLAYERS` secret below.

### 2. Players set their own PINs — you don't touch them
There's nothing to generate. Each person just visits the site, taps their name, and types a **4-digit PIN of their choosing**. The first PIN entered for a name becomes that name's PIN, forever (until you reset it). You (the commissioner) never see it: the PIN is salted with your `TOKEN_SECRET` and hashed before storage, so even the raw KV entry is meaningless without that secret. `make-passwords.html` is **not needed** for this flow — you can ignore or delete it.

> Fair warning to your friends: a forgotten PIN can't be recovered, only reset. To reset one, delete the `acct:<name>` key from the `pickem` KV namespace in the Cloudflare dashboard — that name's next login re-registers a fresh PIN.

### 3. Push to GitHub
Create a repo (e.g. `nfl-pickem`) and upload all the files, keeping the `functions/api/` folder structure — exactly like the tree sale. If the web uploader flattens folders, create the files directly in GitHub's editor and type the full path.

### 4. Cloudflare Pages
- **Create a Pages project** connected to the repo (Build command: none; Output dir: `/`). Same flow as before.
- **Create a KV namespace** — call it `pickem`.
- In **Settings → Functions → KV namespace bindings**, add:
  - Variable name: **`PICKS`** → your `pickem` namespace. *(The code reads `env.PICKS`; the name must match exactly.)*
- In **Settings → Environment variables** (encrypted / "Secret"), add:
  - **`PLAYERS`** = a JSON **array of the allowed names**, matching `index.html`. Example: `["Andy","Sam","Pat"]`. (This just controls who's allowed to claim a slot — no PINs live here.)
  - **`TOKEN_SECRET`** = any long random string (e.g. mash the keyboard, 40+ chars). This both signs login tokens **and salts the PIN hashes**, so keep it private and don't change it after people set PINs (changing it invalidates every PIN).
- Redeploy (any push triggers it).

That's it. Visit the site, pick your name, enter your passphrase, make picks.

## The lock rule (the part worth understanding)
Lives entirely in **`functions/api/_locks.js`**:
- **Every game locks 5 minutes before its own scheduled kickoff.** That's it — one rule for the whole season.
- Because it reads each game's real start time from ESPN, odd schedules need no special handling: Thanksgiving's three games, Saturday slates, international morning kickoffs, and Christmas games all lock 5 minutes before they each start.
- To change the lead time, edit `LOCK_LEAD_MINUTES` at the top of that file.

Locks are enforced **on the server** in both `week.js` (what you can click) and `picks.js` (what actually saves), so no one can beat the deadline by fiddling with the browser.

Note this means you can pick game-by-game right up to each kickoff, rather than committing the whole week at once — so late games can be picked after early ones have started.

## Notes & gotchas
- **ESPN's API is unofficial.** It's free and reliable enough for this, but not guaranteed. The code caches each week's slate in KV for ~1 hour, so you hit ESPN rarely and the site stays fast. If ESPN ever changes shape, the field names to check are in `week.js`.
- **Free-tier writes:** each saved pick set is one KV write. Three people × 18 weeks is trivial — you'll use a few dozen writes a week against a 1,000/day limit.
- **Team logos** come straight from ESPN's CDN — no assets to host.
- **Standings** show two things: a live **season** table (updates the moment games go final) and a **weekly** section you can toggle through. Each week's individual results stay hidden until **7:00am CT the Tuesday after** that week's games — so nobody peeks at the weekly scoreboard while Monday night is still live. Season totals are always current; only the per-week breakdown is gated. Everything re-scores from ESPN automatically — you never hand-enter a result.
- **Changing a pick** before lock just overwrites the old one. After lock, the game is frozen.
- **New season:** the KV keys are namespaced `...2026...`. Bump the year in the code next season to start clean, or wipe the `pickem` namespace.
