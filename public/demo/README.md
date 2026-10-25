# Digital Diary: interface demo

A clickable preview of the diary split into **Home (today)** and a **Dashboard**, built in the same
design system as the served app: the same tokens, themes, cards, chips, ledgers and sheet as
`index.html` and `app.js` one directory up. The stylesheet is copied from the app, so what you see here
is what the real pages will look like.

Everything is local. The entries are generated samples, stored in this browser, and no request
leaves the page. Clearing site data resets them.

## How to open it

Serve this folder (`python3 ../../dev-server.py` from the repo root, which is what the preview panel
uses) and open the root. On the Worker it is `/demo/`; on GitHub Pages it is the site root. Opening `index.html` directly also works; the fonts need a connection.

The **second home layout** lives in [`v2/`](v2/index.html) and opens at `/v2/`. It keeps the same
design system and data, and changes only the home page: the breadcrumb stays on every page with
the day's counters at its right end, the day's entries first, the composer as a sheet, and the
month heatmap in the rail. The two
share sample data through the same browser key but keep tabs separately, so they can sit open side by
side.

## What is here

- **Home (`#/`)** is today, pinned:  the day header with previous/next, the composer, the entries as
  the grouped ledger with category tabs, the hours strip, and a right rail with today's numbers
  and the deadlines that are due or overdue.
- **Home v2 (`v2/#/`)** is the same day without the composer card: four compact stat cards and a
  **New note** button in the header (the note opens in a sheet), the entries card first, the hours
  band under it, and a rail of this month's heatmap, the deadlines and the hours you write at.
  The note sheet pins its tokens-and-neurons line to the bottom of the card, so a long
  note scrolls inside it while the cost stays put. Deadlines are completed from the note, or with
  the tick on each Due row. The wordmark carries the demo's yellow instead of a badge; the tab
  title says which build is open.
- **Month (`#/y/2026/m/10`)** and **Dashboard (`#/dashboard`)** are one page at two zooms: KPIs,
  the heatmap, activity, when you write, AI usage with tokens and estimated neurons per note and per
  model, and the newest notes with what each cost. The month scopes all of it to its 30-odd days
  (heatmap in **both** shapes, switchable and remembered, activity day by day, a calendar to pick a
  day, the deadlines); the dashboard scopes it to the whole year (the year in weeks, months as
  doors, activity month by month). Both lead with the day page's header — `‹ Sep | October 2026 |
  Nov ›` — and its arrows are the only thing that differs.
- **Day (`#/y/2026/m/10/d/24`)** is the same page as Home, opened on another date. The breadcrumb
  reads `Home / October 2026 / 24` and carries the counters of that day at its right end, with no
  separate count; any day but today adds a **Today** card after them in the accent colour. Links to
  another zoom ("Open month", "The year") are small tinted labels rather than bordered pills or
  underlined text. Closing a deadline stores the moment it was closed and shows it as
  `done 16 Oct · 10:42`; reopening clears it.
- **Settings (`#/settings`)** carries theme, light/dark, heatmap default, week start, timezone, the
  account the diary belongs to, **change the passphrase**, **sign out**, and a reset for the sample
  data. The theme picker lives here only; the top bar keeps search, light/dark, dashboard, settings.
- **Search** sits in the top bar on every page and opens notes in the sheet. `/` focuses it.
- **Sign out** is the one button in Settings' header, at the far right, in the alert colour with its
  door icon; the gate then asks for the passphrase. A fresh demo starts at `demo`, and Settings can
  change it — the old one stops working immediately.

## What is deliberately not here

No Worker, no Supabase, no Telegram, and no AI call. Tokens and neurons are sample numbers recorded
per entry; the reconciliation against Cloudflare's billing is a nightly job in the real app, not this
page. Themes are real: they write the same preference key the app reads.
