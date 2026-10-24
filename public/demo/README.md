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

## What is here

- **Home (`#/`)** is today, pinned: the day header with previous/next, the composer, the entries as
  the grouped ledger with category tabs, the hours strip, and a right rail with today's numbers,
  the deadlines that are due or overdue, and links out.
- **Dashboard (`#/dashboard`)** shows one month: KPIs, the month heatmap in **both** shapes
  (weeks table / calendar grid, switchable and remembered), activity day by day, when you write,
  AI usage with tokens and estimated neurons per note and per model, the year at a glance, folders,
  and the newest notes with what each cost. `‹ Sep · Today · Nov ›` move it between months.
- **Month (`#/y/2026/m/10`)** and **Day (`#/y/2026/m/10/d/24`)** are the app's existing views; a day
  is the same page as Home, opened on another date.
- **Settings (`#/settings`)** carries theme, light/dark, heatmap default, week start, timezone, the
  account the diary belongs to, and a reset for the sample data.
- **Search** sits in the top bar on every page and opens notes in the sheet. `/` focuses it.
- **Sign out** in the header shows the login card; any passphrase unlocks it again.

## What is deliberately not here

No Worker, no Supabase, no Telegram, and no AI call. Tokens and neurons are sample numbers recorded
per entry; the reconciliation against Cloudflare's billing is a nightly job in the real app, not this
page. Themes are real: they write the same preference key the app reads.
