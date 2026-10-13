# Digital Diary: interface demo

This is a standalone preview of the Digital Diary web interface. It is a single HTML file with no server and no account.

The entries are generated sample data, not anyone's real diary. Everything you change (moving an entry, adding a note) is saved in your browser only. Clearing the site data resets it.

## How to open it

Double-click `index.html`, or open it in any modern browser. It needs an internet connection only to load the fonts.

## What to look at

- **Home:** switch between Day, Week, Month, and Year. The activity chart shows what was captured in that range, colored by category. The calendar grid shows each day of the year. The hour chart shows when entries are usually written. Entries written late at night are flagged as outliers.
- **Month:** a calendar, the category mix, a short computed summary, and a folder for each day.
- **Day:** entries grouped by category, with timestamps. Each entry has a "Move to" link to change its category, and a "Raw" tag that shows the original text before cleanup.
- **Theme:** the palette icon switches between Minimal, Paper, and Dark Journal. The sun and moon icon switches between light and dark.

## What is not here yet

This demo has no backend, no Telegram capture, and no AI features. Those are being built separately.
