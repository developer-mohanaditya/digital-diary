# INK, full application audit

Audit date: 27 October 2026. Branch `developer-fb`, commit `43dc866` plus the heartbeat-notification
change in the working tree. Production origin: `ink.aweditya.com` (Worker `ink`, also reachable at
`ink.awesm.workers.dev`).

Every statement below was read out of the code in this repository. Where something is *not* verified,
it says so explicitly, in **Findings** (§15).

---

## 1. What this is

A one-person diary. One person (the owner) writes notes to a Telegram bot all day, and reads them
back on a web page. There is no sign-up, no other user, no admin panel: the whole product is
"capture fast on a phone, read it later on any screen, and let other projects of mine read the same
data through an API".

Three doors lead in, and the app is explicit about which one a note came through:

| Door | Who uses it | What it is |
| --- | --- | --- |
| Telegram bot | the owner, mostly from a phone | the primary capture path |
| The web page's composer | the owner, at a desk | same rows, same cleanup |
| `POST /api/v1/notes` | other apps (Claude Code, Codex, Freebuff) via MCP or curl | a session files itself |

One door leads out: `GET /api/v1/…`, a read API with per-project keys and per-key limits.

Two design commitments run through the whole codebase and explain most of its structure:

1. **Nothing is lost.** Every door writes a `captures` row holding exactly what arrived, *before*
   anything else happens. Cleanup, categorisation and reminder creation all happen after, and any
   of them failing costs a tidy line, never the note.
2. **The stored note is never silently rewritten.** `raw_text` always holds the typed words, the
   formatted `clean_text` sits beside it, and the page's Raw control shows the original word for
   word.

## 2. Architecture at a glance

```
Telegram  ──POST /telegram/webhook──┐
Web page  ──/api/entries /api/note ─┤   ┌──────────────┐   ┌─────────────────────┐
Other apps──/api/v1/notes ──────────┼──▶│ Cloudflare   │──▶│ Supabase (Postgres) │
Read keys ──/api/v1/* ──────────────┘   │ Worker "ink" │   │ captures, thoughts, │
                                        │  src/index.ts│   │ reminders, settings,│
   cron ──▶ scheduled() ────────────────▶│              │   │ api_keys, api_usage │
   Workers AI ◀── cleanup ───────────────┤              │   └─────────────────────┘
   static page ◀── ASSETS ───────────────┘   └──────────────┘
```

- **One Worker** does everything: webhook, page API, public API, key management, the cron job, and
  serving the static front end (`wrangler.toml` → `[assets] directory = "./public"`,
  binding `ASSETS`). There is no second deployable, no framework, no build step for the front end.
- **Supabase** is used as a plain REST database through PostgREST, with the `service_role` key held
  as a Worker secret. RLS is enabled on every table with **no** policies, so the anon key can read
  nothing; the service key bypasses RLS. Three SQL functions (`bump_api_usage`, `bump_api_notes`,
  `diary_stats`, `diary_days`) are the only server-side logic.
- **Workers AI** cleans up each note. It is bound as `AI` in `wrangler.toml`; there is no API key,
  and no other model provider.
- **No npm runtime dependencies.** `package.json` has devDependencies only (types, TypeScript,
  Vitest, Wrangler). The MCP server is dependency-free by hand.

### Route table (`src/index.ts` → `fetch`)

| Route | Method | Purpose |
| --- | --- | --- |
| `/telegram/webhook` | POST | Telegram updates, secret-token checked |
| `/api/session` | POST / DELETE | passphrase sign-in, sign-out |
| `/api/entries` | GET | what the page reads (a year, grouped by day) |
| `/api/note` | POST | a note typed on the page |
| `/api/note/move` | POST | re-file a note under another category |
| `/api/reminder/done` | POST | mark a deadline done / reopen it |
| `/api/passphrase` | POST | change the page's passphrase |
| `/api/ai-check` | GET | one tiny inference per cleanup model |
| `/api/reclean` | POST | re-run cleanup over untouched notes |
| `/api/v1…` | GET/POST | the public read API and the write endpoint |
| `/api/keys…` | GET/POST | mint, list, revoke keys (session only) |
| anything else | GET | static files from `public/` via `ASSETS` |

### Cron (`wrangler.toml` → `[triggers]`)

Four entries, because the Free plan allows five per account:

```
45 6,7 * * *      → 08:45 heartbeat (CEST, CET)
30 10,11 * * *    → 12:30 heartbeat (CEST, CET)
0 15,16 * * *     → 17:00 heartbeat (CEST, CET)
0 20,21 * * *     → 22:00 daily summary (CEST, CET)
```

Each slot has one entry per UTC hour, and the Worker resolves them on the *diary's* local clock
(`beatSlot`, `hourIn`), so the twin run lands on the same slot instead of a second one. A beat is
written by the first run at or after its slot, once: the slot it satisfied is recorded in
`settings` under `heartbeat`, which is what stops the twin run writing a second row and a second
message. `scheduled()` runs three things (`runDue` (reminders), `heartbeat`, `dailySummary`) each
in its own try/catch, so one failing step cannot silence the other two.

## 3. Data model (`migrations/`)

| Table | Holds | Notes |
| --- | --- | --- |
| `captures` | every message that arrives, verbatim | append-only in spirit; `unique (source, source_update_id)` is the idempotency key for all three doors. `client` + `dedupe_key` (0009) record which app filed an API note. |
| `thoughts` | one row per note as the diary shows it | `day` (local date), `clean_text`, `raw_text`, `category`, `category_source` (`tag`/`auto`/`manual`), `mode`, and (from 0006) `tokens_in`, `tokens_out`, `cleanup_model`. |
| `categories` | the ten categories, with labels and order | seeded in 0001, `deadline` added in 0005. |
| `reminders` | deadlines and reviews | `kind`, `title`, `due_at`, `next_remind_at`, `status`, `source`, `snooze_count`, `done_at`. |
| `settings` | key/value | `timezone`, the saved `passphrase` hash, `daily_summary` (the day the summary last went out). |
| `heartbeats` | one row per beat | keeps the free Supabase project from going a quiet week and pausing. |
| `api_keys` | one row per API key | `prefix` (16 chars, the lookup index), `hash` (SHA-256), `scopes`, `policy` (jsonb, 0008), limits, expiry, revocation. **The key itself is never stored.** |
| `api_usage` | one row per key per clock minute | both rate limits read from it; `bump_api_usage` is atomic so a burst cannot slip past a read-then-write race. |
| `archived_notes` | the 23 notes written while building | 0011 shelves the test notes out of the live diary, keeping the whole thought and capture row as jsonb so a restore is exact. Nothing reads it at runtime. |
| `category_changes`, `links` | schema only | created in 0001; **no code path writes them** (see §15). |

Every migration is written to be safe to run twice (`if not exists`, `on conflict do nothing`,
guarded deletes).

## 4. The website (`public/`)

Three files, one page: `index.html` (77 lines), `app.js` (~1834 lines), `diary.css` (~792 lines).
No framework, no bundler, no build. `document.querySelector` on demand, one hash router, one
`render()` that re-renders the current view from `state`, and event delegation on
`[data-action]`. `dev-server.py` serves the same folder on `:3000` for previewing.

### 4.1 The shell

- **Top bar** (sticky, dark in every theme): brand mark + wordmark, a search field, and three
  round glass buttons, dashboard/home, light-dark toggle, settings. The search field and buttons
  use a "liquid glass" treatment (layered gradients, `backdrop-filter: blur(20px) saturate(1.8)`,
  inset rim light).
- **Breadcrumb row** names where you are on every page, and carries the day's four counters and the
  **New note** button at its right end (`statCardsHTML`). On a phone that is where the fifth cell
  goes, because "I remembered something from yesterday" should not require a trip back to today.
- **Footer**: `INK · Aditya @ aweditya.com`.
- The bar's fourth icon is *wherever you are not*: dashboard, or home when you are on the dashboard.
- `index.html` also sets theme/mode **before first paint** from `localStorage`, so a saved choice
  never flashes the other mode.

### 4.2 Routes

| Hash | View | What it is |
| --- | --- | --- |
| `#/` | home | today's day page |
| `#/y/Y/m/M` | month | one month, as a stats page |
| `#/y/Y/m/M/d/D` | day | that day |
| `#/dashboard[/Y]` | year | the whole year, same blocks as the month page |
| `#/settings` | settings | facts, Look link, Access (keys), passphrase form |
| `#/settings/look` | look | every visual choice |

The month page and the dashboard are deliberately *the same page at two zooms*: same blocks, same
order, only the buckets and the arrows differ.

### 4.3 Day page

- **Hero**: previous day / the date (weekday over date) / next day. On a phone the labels shorten to
  Previous/Next and the two arrows keep a measured min-width so the date never collides.
- **Entries card**: category tab row (counts per category) over a ledger. In "All" the ledger is
  grouped by category with a coloured dot and a count; picking a tab flattens it. Each row is
  `time · clamped text · due pill`, clickable, keyboard-focusable.
- **Timeline card**: 24 bars for the day's hours, with the current hour marked on today.
- **Rail** (right column on wide screens, stacked below on phones):
  - **This month** heatmap, day cells shaded by count, today ringed, plus three computed lines:
    days written of days elapsed, longest run, best day.
  - **Due**, the five nearest open deadlines with due pills, or "Nothing due." On a phone an empty
    card steps aside entirely rather than taking a screenful of scroll.
  - **Rhythm**, when in the month you write, with a computed sentence naming the peak hour.

### 4.4 Month / dashboard page

One page, two scopes. Blocks: five KPI cells (items, active days, categories, open deadlines,
neurons), the heatmap (year-in-weeks, or the month as a weeks table *or* a calendar grid, a saved
choice), a stacked-by-category bar chart, a category composition bar with percentages, an
hour-of-day histogram, an **AI usage** card (estimated neurons, a meter, a per-model table), the
month folders, and the eight most recent notes with what each cost.

Every chart closes with a **reading**: one sentence computed from the same entries the chart draws
("Evenings from 18:00 hold the larger share at 61%, against 22% before noon. The busiest hour is
21:00, 9% of the notes."). Nothing is typed in by hand.

### 4.5 The note sheet

Clicking a row opens the note: category dot and label, the mode chip, and four things worth having , 

- **Raw** toggle (only when the note actually went through a cleanup, i.e. mode ≠ verbatim),
- **Move** menu, category list, then a Yes/No confirm, with a due-date field when the target is
  Deadline (a deadline without a date is half a move),
- the **via** line in the meta row: `via Telegram`, `via Web`, or the app that filed it
  (`via Claude`, `via Codex`, `via Freebuff`, or any new client name title-cased),
- the **due line**: the due date, how many days left/late, and a **Mark done / Reopen** button that
  writes the same reminder row the Telegram Done button writes, so the two cannot disagree.

The footer shows what the cleanup cost (estimated neurons, tokens in/out and the model id) or,
honestly, "No cleanup cost was recorded for this note." when no record exists (verbatim notes, or
notes older than migration 0006).

### 4.6 Composer

A sheet with a textarea, mode select (Refined / Verbatim / Reason / Think), category select, an
optional due-date calendar (shown only when Deadline is picked), and **Add note**. `⌘/Ctrl+↵` saves,
`n` opens the composer, `/` focuses search, `Esc` closes. The hint says what will happen: filed into
today by the Worker's clock, cleanup runs on save, category is only a guess.

After a save the page **reloads from the database** rather than keeping an optimistic copy, and the
toast says what the cleanup actually did (`Saved and formatted.` / `Saved as written.` /
`The cleanup found nothing to change.`).

### 4.7 Search

Client-side, over the year already loaded. Tokens are normalised (lowercase, accents stripped,
punctuation dropped); each query token must match ≥ 1 of word-prefix, substring, or
Levenshtein-distance-1; results are scored, deduplicated by text, capped at 8 and shown in a
dropdown with matched terms highlighted, date and category. Arrow keys and Enter navigate; clicking
one navigates to that day and opens the note.

### 4.8 Settings and Look

**Settings** holds only facts and one destructive action at a time: the Look summary line, the
default month-heatmap shape, week start, the timezone the Worker reports, the entry total with a
"Reload the diary" button, the **Access** card (API keys), the passphrase form, and Sign out.

**Look** owns every visual choice, and the day's tab shape is sampled there with **the same
renderer the day uses**, so the preview cannot drift from the real thing:

- **Theme**: Minimal / Paper / Dark Journal. Each pairs a typeface with an accent.
- **Mode**, light or dark, for every theme.
- **Font**: Theme default / Grotesk / Paper serif / System.
- **Accent**, theme's own, or one of six.
- **Category colours**, one colour per category, applied wherever a dot or chip is painted.
- **Category filter shape**, pills, underline, colour line, dot chips, segmented, dropdown. Six
  shapes, one job.
- **Reset** to theme defaults.

### 4.9 The design system (`diary.css`)

Six palettes (`theme × mode`) as attribute selectors on `<body>`, on top of one shared card shape:
**2px edge, a hard offset shadow (`4px 4px 0`), 18px radius, on paper-ish background**. Tokens:
`--bg --ink --muted --accent --card --line --alert --edge --shadow --top --grain`. Fonts come from
Google Fonts (Space Grotesk, Instrument Sans, Bricolage Grotesque, Hanken Grotesk), preconnected;
`[data-font]` overrides the theme's pair. Purple is the accent in the default theme; the brief in
`AGENTS.md` is that nothing else competes with it.

Responsive work is measured rather than assumed: `@media (max-width:600px)` gives every filter
shape a 44px thumb target, lifts the bar under the notch (`env(safe-area-inset-top)`), and raises
body text to 17px because "reading is the phone's main job". There are 480px and 380px blocks that
exist because a specific phone width was measured and overflowed, and the comments say so.

Preferences live in `localStorage` under `diary-prefs-v2` (theme, mode, font, accent, category
colours, chip shape) and `diary-view-v1` (heatmap shape, week start); the old `diary-setup-v1` key
is imported once and then forgotten. Entries themselves are never stored in the browser.

## 5. Capture, via Telegram (`src/handler.ts`, `src/parse.ts`, `src/timezone.ts`)

- Only the owner's chat id is accepted (`ALLOWED_CHAT_ID`); every other chat is ignored.
- The webhook is checked against `X-Telegram-Bot-Api-Secret-Token`; a wrong token is a 401.
- Leading command words are parsed left to right, separated by spaces, so `/push /thought Stay
  hungry` works. Modes: `/push` (verbatim), `/reason`, `/think`. Categories: `/class /learn
  /thought /quote /work /project /life /task /deadline`. Two conflicting modes or categories are
  refused with a reply naming the options.
- Commands are **instructions, not notes**: `/start`, `/timezone` (show/set/invalid), `/heartbeat`,
  `/reclean`, a bare `/word`, or an empty message get an answer and write **no** row. A diary that
  fills up with `/start` is noise the owner would clean up by hand.
- Voice and photos are refused with a polite line; `captures.kind` and `media_path` are already
  there for when they are built.
- Idempotency comes from Telegram's `update_id` through `unique (source, source_update_id)`, so a
  Telegram retry never files a second note.
- The reply is always three lines: where it was filed, what the cleanup did, and the first 180
  characters of what was stored.

## 6. The cleanup (`src/refine.ts`)

One model call does two jobs: strip filler/false starts/repetition, and lay the note out for
reading. The prompt is strict about what may change, keep every fact, name, number, date and
quotation, keep opinions, add nothing, and about the markup, which is a small closed set:

| Written by the model | Rendered as |
| --- | --- |
| blank line | new paragraph |
| line starting `- ` | bullet list |
| line starting `1. ` | numbered list |
| `**words**` | bold |
| `*words*` | italic |
| `==words==` | highlight |

The page escapes every note *before* rebuilding those markers, so a note can never inject HTML.
Headings, tables, code and emoji are explicitly out.

Model routing by length, with a fallback chain: `@cf/zai-org/glm-4.7-flash` first for notes up to
1000 characters, `@cf/meta/llama-3.3-70b-instruct-fp8-fast` first for longer ones,
`@cf/meta/llama-3.1-8b-instruct-fp8` as last resort. An answer that is empty, a lecture, commentary
about its own edit, or more than twice the note is rejected and the next model is asked. If every
model fails, the note is stored **as written**, the Telegram reply says `Cleanup failed (<reason>),
saved as written.`, and the reason is kept on the capture (`captures.last_error`).

Five outcomes, and they are the same at every door because they all call `cleanNote`:
`formatted`, `unchanged`, `verbatim`, `unavailable`, `failed`. Distinguishing "no change needed"
from "no model was there" matters: that conflation is exactly how the feature once broke silently.

## 7. Deadlines and reviews (`src/reminders.ts`)

One reminder table, two kinds:

- **Deadline**, explicit `/deadline`, or heuristic words (`deadline`, `due by`, `in 3 days`,
  `tomorrow`, `this weekend`, `by 3rd nov`). First ping three days before the due date (or now when
  that has passed), then daily until done. `reminderTimes()` is shared by all three places that can
  set one (the composer, a move to Deadline, and the write API) so the same due date pings on the
  same day whichever door the note came through.
- **Review**, heuristic phrases ("review later", "come back to", "check this again"). One or two
  evening pings, then it closes itself.

Each ping is a Telegram message with an inline **Done** button (`done:<reminderId>`), answered
through the webhook as a callback query. The page's Mark done/Reopen writes the same row.

## 8. Messages the app sends on its own

**Keep-alive heartbeat** (`src/heartbeat.ts`, three times a day). Purpose: the free Supabase project
pauses after a quiet week of inactivity, so the diary keeps itself awake. Each beat writes one row
*purpose-built for the signal*, a readable database can still reject inserts, and this table exists
to prove it can. The beat is now said out loud on Telegram as it is written, from whichever source
wrote it: the cron (with the line `Heartbeat 12:30 (Europe/Paris) · keep-alive written.`) or
`/heartbeat` by hand (which replies with live counts plus `Heartbeat written.`). The message names
the slot **on the diary's clock**, which is also what makes it useful on the two days a year the
clocks move: the twin run skips and says nothing.

**The 10pm summary** (`src/summary.ts`). One message when the day is over: the weekday and date,
the note count, the category tally, each note on one line with its hour (up to eight, then
"…and N more"), and everything still open. A day with nothing written says so rather than skipping.
Two cron entries cover CET and CEST; `summaryDue` requires the local hour to have reached 22 *and*
a `settings.daily_summary` row to not already name today, the settings marker is what stops the
day the clocks go back from sending twice. A database that refuses the reads sends nothing at all,
rather than a summary claiming the day was empty.

## 9. The page's own door (passphrase + session)

- The page is **open by default**. With no `DIARY_PASSPHRASE` and no saved hash, `/api/entries`
  serves the diary to anyone who has the URL and no sign-in card appears.
- Sign-in is `POST /api/session { passphrase }` → an HttpOnly, Secure, SameSite=Lax **signed
  cookie**, 30 days, HMAC-SHA-256, carrying its own expiry. There is no session table.
- The passphrase is the `DIARY_PASSPHRASE` secret until Settings saves one; then a salted
  PBKDF2-SHA-256 hash (100k iterations, salt and iteration count inside the stored string) in
  `settings` wins. Both are compared in constant time; a wrong guess takes a 400 ms pause. The
  cookie is signed with whichever of the two is live, so changing the passphrase signs every other
  device out while handing this one a fresh cookie.
- **Settings → Access → Change the passphrase** does this without the Cloudflare dashboard. A
  forgotten passphrase is *not* recovered by changing the secret (the hash wins): the documented way
  back is deleting the `passphrase` row in the Supabase SQL editor.
- The session gate reads **only** the signed cookie. An earlier version trusted the presence of a
  `Cf-Access-Jwt-Assertion` header, which anyone on the internet can send; that was a real
  unauthenticated read of the whole diary and was closed (`signedIn` in `src/index.ts`, regression
  tested in the passphrase suite).
- Key management (`/api/keys`) answers to that session, never to a key: **a key cannot mint or
  revoke a key.**
- Signing out clears the cookie and drops the whole in-memory state, including a revealed key.

## 10. The read API (`src/publicapi.ts`)

`GET /api/v1` describes itself **without a key** and without any note content, so a new key holder
can read the shape before querying.

**Authentication.** `Authorization: Bearer ddk_live_…`; the key is looked up by its 16-character
prefix and proved by SHA-256. A missing, malformed, unknown, revoked or expired key all answer the
**same 401**, so a caller cannot tell which. A valid key lacking a scope answers `403` *naming the
scope*, a silently empty list would hide a misconfiguration. Twenty failed keys a minute per client
address stop costing a database round trip (an in-isolate counter, deliberately a speed bump, see
§15). Every authenticated call writes one line to Worker Logs: `api <prefix> <method> <path>
<status>`, never the query string (a search term is note text) and never a body.

**Scopes.** `notes:read`, `deadlines:read`, `stats:read` (all on every new key), `raw:read` and
`notes:write` (deliberately not: the original text is the part cleanup was meant to replace, and a
write key is a separate, tighter kind of credential).

**Policy.** Every key also carries limits, enforced on every read *and* on writes, set when the key
is created:

| Limit | Effect on a read | Effect on a write |
| --- | --- | --- |
| `categories` | the only categories it may read; naming another is `403 out_of_policy` | the only categories it may file into |
| `from` / `to` | a wider period is clamped to the window; a note outside it is `404` | which days a note may be dated |
| `text: none` | counts, days, categories and word counts, no `text`; refuses `q=` and `fields=text`, cannot export, sees `"A deadline"` instead of a title | no effect (it is a read limit) |

A note outside a key's policy **does not exist** for that key (`404`, never `403`), the day and count
rollups are narrowed to the policy's categories and window, and a deadline whose note is outside it
is hidden, including one whose note cannot be found to check, since a limit that can be dodged by a
missing join is not a limit. A policy that cannot be parsed is a refusal, not a shrug.

**Endpoints.** `/me` (the key's own scopes, policy, limits, last use), `/notes` (filtered, keyset
paged), `/notes/{id}`, `/days`, `/stats` (`by=day|week|month|year|category|type|source`),
`/deadlines` (+`/{id}`, with `daysLeft`, `daysLate`, `openDays` and the note behind each),
`/categories`, `/export` (json, csv or md). `/notes` filters: `day`/`month`/`year`/`from`+`to`
(one selector only, never two), `category`, `type`, `source`, `q`, `has=deadline`, `done`,
`fields=…`, `limit`, `cursor`, `order`.

**Transport guarantees**, stated as tests: every answer carries `Cache-Control: private, no-store`
and `X-Content-Type-Options: nosniff`; **no CORS header is ever sent**, so a page on another origin
cannot read a response even if a key is pasted into it; nothing the caller sends reaches a query
unfiltered, each value is checked against a shape (a real calendar date, a known category, a known
type, a row id) and the PostgREST query is rebuilt server-side; `q` is stripped of `%`, `_`, `*` and
PostgREST punctuation so it cannot become a wildcard or a second filter; limits are whole numbers in
decimal only (`0x10`, `1e3`, `+1` are refused).

**Rate limits.** 60/minute and 5,000/day for a read key, 30/minute and 300/day for a write key.
Every answer carries `X-RateLimit-Limit/Remaining/Reset`; a spent allowance is `429` with
`Retry-After`. The counter is one atomic Postgres function. If the counter cannot be reached, a
**read carries on** (it spends nothing) and a **write is refused** (a key that can spend money and
send messages does not get to run uncounted).

## 11. The write API (`src/writeapi.ts`)

`POST /api/v1/notes` files 1–25 notes per request (4,000 characters a note, 40,000 a request) for a
key holding `notes:write`. A note written here is the *same kind of row* as one sent to the bot: a
capture holding exactly what arrived, one thought, and a reminder if it is a deadline, through the
same cleanup.

What is different is the answer: a **receipt** per note (`stored` / `duplicate` / `failed` with a
reason), the words and categories, any deadline with its first ping, what the cleanup cost, whether
Telegram was reached, and a short code (`rc_9f1a20`) that ties the API's answer to the message on the
owner's phone. The batch is **not** all-or-nothing on purpose: each note is its own row, and a retry
skips whatever already landed. Nothing stored plus something failed is a `502`.

Four properties the file is built around:

1. **A retry cannot file twice.** The capture's `source_update_id` is derived from the caller's
   `Idempotency-Key` plus the key's own id plus the note's index, so the same key is the same row.
   A pure retry answers `200` with `duplicate: true` and *no* Telegram message, because the owner
   has seen that one. If two identical requests race each other, the loser looks up which capture
   took the row and reports it as a duplicate rather than omitting it from the receipt.
2. **A write key cannot read.** Nothing here answers with a note the caller did not just write.
3. **A write key cannot silence its notification.** `ack` used to be a request field; a stolen key
   could set it false and file notes silently, so it is gone. Every request that stores a note is
   confirmed on the owner's phone, that message is the only real-time trace of a write nobody
   watched arrive. An old caller still sending `ack` is ignored rather than refused.
4. **Nothing fails the note.** A failed cleanup, reminder or Telegram send is reported in the
   receipt; the capture and the thought stay.

A write spends the allowance **per note**, not per request (`bump_api_notes`, migration 0010): a
25-note batch costs 25 of the 300, because each note is a model call.

The Telegram confirmation reads, for example:

```
Claude Code filed 2 notes · 26 Oct
work 1 · deadline 1 (first ping 30 Oct)
· Shipped the write API and its receipt.
Receipt rc_9f1a20
```

## 12. Key management (`src/apikey.ts`, `keysApi`)

Minted in **Settings → Access**, which switches between **Read keys** and **Write keys** because the
two are created with different fields and mean different things. A key looks like `ddk_live_…`
(52 characters, 256 random bits) and is shown **once**: the row keeps a 16-character lookup prefix
and a SHA-256, so nothing can be read back. Creation validates the name, the scopes, the expiry
(30/90/180/365 days or never) and the policy, and refuses combinations that cannot mean anything
(`raw:read` without `notes:read`; `text: none` with `raw:read`). POSTs also refuse a **foreign
Origin**, because minting a credential is heavier than changing a preference. The list shows prefix,
scopes, policy in words ("work, project · since 1 Jan 2026 · counts only"), last use or expiry or
revocation, with a Revoke button per row.

## 13. Reaching the diary from other apps (`mcp/`, `integrations/`)

- `mcp/server.mjs` is a dependency-free MCP server exposing two tools: **`diary_add_notes`** (with a
  schema that encodes the real limits, 1–25 notes, the ten categories, the four modes, `due`
  required on a deadline) and **`diary_whoami`** (name, scopes, limits, policy) so a refusal gets
  *explained* rather than retried around. It speaks both the current protocol revision
  (`server/discover`, every request carrying its version) and the older `initialize` handshake, so a
  client of either era gets a working server.
- `mcp/diary.mjs` is the stdio loop: one JSON-RPC message a line in, one out, **nothing else ever on
  stdout**, and requests handled strictly one at a time so a pipelined pair cannot file the same note
  twice.
- `integrations/diary-session.md` is the same thing without MCP: a `/diary` command file for Claude
  Code or Codex, spelling out what to write (first person, the owner's voice, three to eight
  sentences) and the markup the page renders, with `one note` / `split` / `notes: X; Y` /
  `deadline fri: …` argument modes.

## 14. Ops and tooling (`scripts/`)

| Command | What it does |
| --- | --- |
| `npm run dev` / `dev:local` | Wrangler dev on `:8787` against real Supabase / entirely local |
| `npm run deploy` | `wrangler deploy` |
| `npm run typecheck` / `test` | `tsc --noEmit` / `vitest run` |
| `npm run secret NAME` | silent prompt, writes `.dev.vars` **and** pushes to Cloudflare |
| `npm run env:check` | every name, its home, and what is missing |
| `npm run bindings:check` | diffs the **deployed** Worker's bindings against `wrangler.toml`: every `[vars]` value equal, every required secret present *as a secret*, `AI` and `ASSETS` attached, compatibility date not older. Exit 0 in step, 1 on drift, 2 when it cannot check |
| `npm run doctor` | Telegram webhook doctor (register, inspect) |
| `dev-server.py` | serves `public/` on `:3000` for previewing |

Config discipline is explicit and enforced: **two places only**, `wrangler.toml [vars]` for
non-secrets, `.dev.vars` (gitignored) for secrets, no name in both. Deploy is from `main` only.

## 15. Findings

### 15.1 What is verified right now

Run on this checkout (27 Oct 2026):

- `npx vitest run` → **260 tests, 18 files, all passing** (exit 0).
- `npm run typecheck` → clean (exit 0).

The suites map onto the features above: `publicapi` (74 tests, auth, filters, policies, exports,
audit line, key management), `writeapi` (23, receipt, retries, race, caps, metering), `mcp` (12,
including the stdio process), `handler`, `passphrase`, `session`, `auth`, `apikey`, `refine`,
`parse`, `reminders`, `reminder-done`, `move`, `summary`, `heartbeat`, `timezone`, `api`, `worker`.

### 15.2 Open items, not defects, but things the audit cannot call done

1. **The beat has never fired in production, though the cron itself does.** Settled on 27 Oct from both
   sides. The scheduled handler runs: `settings.daily_summary` = 2026-10-26, a marker only the 22:00
   run writes. The beats do not: `heartbeats` holds 8 rows, every one `note='test'` from the on-demand
   `/heartbeat` (the newest, 25 Oct 22:51 UTC), and none from the cron. Two candidate causes, and the
   live trigger list cannot be read from here to separate them (`CLOUDFLARE_API_TOKEN` can *list*
   Workers scripts but has no service access, so the schedules endpoint answers 403): either the
   registered trigger list is the older `0 6`, `30 12`, `0 20`, `0 21` UTC, which fires the summary
   but never lands on 08:45/12:30/17:00 Paris, or the deployed script predates the beat.
   **Partly closed on 27 Oct**: the deploy path turned out to be a push to `main` (Workers Builds),
   not a direct upload, and this tree went out that way at ~15:00 UTC; a `wrangler deploy` from this
   machine is refused. Since the last `main` merge (27 Oct 10:07) already carried the beat's own
   commit, the code was live and the trigger list was the stale half. The registered schedule is
   applied by the same build, so the first run at or after a slot is the empirical proof.
   The code no longer depends on the exact minute (§8), so the beat survives either way.
2. **The durable rate-limit wall in front of `/api/v1` does not exist.** The failed-key counter is
   per Worker isolate (`AUTH_MISSES`), and the code comment says so: it is a speed bump, not a wall.
   A Cloudflare rate-limiting rule on `/api/v1/*` was started and not finished.
3. **The heartbeat notification is not deployed.** The change (cron beats now message Telegram) is
   in the working tree and untested against production; the live Worker still runs the previous
   build. No migration is needed, so a plain deploy carries it.
4. **No backup or restore path.** `archived_notes` is a shelf, not a backup: the diary's only copy
   is the Supabase project. A scheduled export (the API can already produce one) is the natural fix.
5. **The published-domain checks were done by hand.** `ink.aweditya.com` was confirmed live earlier
   in the session, but nothing automated asserts that the site renders and a note opens with its via
   line after a deploy.

### 15.3 Residue, dead or unreachable code, verified by grep

**Removed on 27 October** (verified unreachable first: zero occurrences in every `class="…"` the
app can emit, in `index.html`, and in the only three `classList`/`className` writes):

- `donut()` in `public/app.js`, defined, never called; `statsPage` uses `compHTML`.
- Its CSS: `.donut` (5 rules), `.dtot`, and the two phone-block `.donut` rules.
- The orphaned v1 classes `.strip`, `.ticks`, `.outlier-list`, `.ltag`, `.lmore`, `.lmove`,
  `.lmove-open`, `.lraw`, `.sfigure`, `.smove`, `.tab.zero`, and the v1 entry card's `.entry`,
  `.entry p`, `.meta`, `.time`, `.chip`, `.rawtag`, with their phone-block padding rules.

Still present but equally orphaned, and left alone deliberately: `.rtext`, `.raw` and `.actions`
(the rest of the same v1 entry card). They are the same kind of candidate; removing them is one
more edit of the same shape.

Confirmed unused in the schema/backend:

- `category_changes` and `links` tables (migration 0001) and `thoughts.reasoning` are written by **no
  code path**. They are plausible future work (audit trail, link capture, stored reasoning), not
  accidental: the README lists link capture and richer reasoning as "not built yet". The honest
  statement is that they cost a migration line and buy nothing today.
- `captures.kind` allows `voice`/`photo`/`link` and `media_path` exists, but only `text` is ever
  written. Reserved for the same reason.
- `dev-server.py` was changed to serve only `public/`; the sample-data demo it used to mirror
  (`demo/`, `public/demo/`) is **gone from the tree** (confirmed: neither directory exists), so
  there is exactly one copy of the interface.
- Repository hygiene: `docs/`, `artifacts/`, `preview/`, `.impeccable/` are untracked or ignored
  scaffolding (`*.log`, `logo-drafts/`, `.env`, `.dev.vars` are gitignored).

### 15.4 Risks worth naming

- **The passphrase is the only thing in front of a page that can read the whole diary.** There is no
  second factor and no account system; `SUPABASE_ANON_KEY` is listed as "when auth ships". With the
  page open by default, an owner who has set no passphrase is one URL leak away from exposing
  everything.
- **A read key with `raw:read` and no policy is the whole diary**, which is exactly what the policy
  machinery exists to prevent. Any key created before migration 0008 (or created with every category
  and no dates) has `policy = {}` and reads everything. Settings shows the policy in words for each
  row, which is what makes this visible rather than invisible.
- **`text: none` is a read limit, not a write limit**, by design; a counts-only key can still be
  granted `notes:write` separately, and Settings says so.
- **The write path is the one that spends money and sends messages.** It is capped per note, refuses
  to run uncounted, and cannot silence its own confirmation, but it is also the furthest thing from
  the owner's attention, the Telegram receipt is the only real-time trace, which is precisely why
  it cannot be turned off.
- **`AI` is remote-only.** `wrangler dev --local` answers "not supported", so cleanup can only be
  tested after a deploy; `GET /api/ai-check` exists for exactly that reason and separates a missing
  binding from a retired model id from an account that cannot use Workers AI.

## 16. Feature index, feature → entry point → files

| Feature | Entry point | Files |
| --- | --- | --- |
| Telegram capture + commands | `POST /telegram/webhook` | `handler.ts`, `parse.ts`, `timezone.ts` |
| Cleanup | any door that stores a note | `refine.ts` |
| Deadlines & reviews | `/deadline`, heuristic words, `due` on a write | `reminders.ts` |
| Keep-alive heartbeat + beat message | cron + `/heartbeat` | `heartbeat.ts`, `index.ts` |
| 10pm summary | cron | `summary.ts` |
| Web app (all views) | `GET /` → `ASSETS` | `public/index.html`, `app.js`, `diary.css` |
| Read the diary in the page | `GET /api/entries` | `index.ts`, `api.ts` |
| Write from the page | `POST /api/note` | `index.ts`, `refine.ts` |
| Move a note | `POST /api/note/move` | `index.ts` |
| Mark a deadline done | `POST /api/reminder/done` | `index.ts` |
| Passphrase gate + session | `/api/session` | `session.ts`, `auth.ts`, `index.ts` |
| Change the passphrase | `POST /api/passphrase` | `auth.ts`, `index.ts` |
| Public read API | `/api/v1/*` | `publicapi.ts` |
| Write API | `POST /api/v1/notes` | `writeapi.ts` |
| API keys | `/api/keys*` | `apikey.ts`, `publicapi.ts`, `index.ts` |
| MCP / `/diary` command | `mcp/diary.mjs` | `mcp/server.mjs`, `integrations/diary-session.md` |
| Schema | SQL editor | `migrations/0001…0011` |
| Ops checks | `npm run …` | `scripts/*.mjs`, `dev-server.py` |
