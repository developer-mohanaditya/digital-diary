---
name: ink
description: File this session into Aweditya's private diary (INK). Use at the end of a session, or when he says "write to the diary", "note this down" or "remember this". A command per shape (ink-brief, ink-note, ink-detail, ink-guide and their category forms, ink-threads, ink-split), a two phase pair (ink-draft, ink-push), and a preset after the skill name.
argument-hint: [brief|note|detail|guide|one|threads|split|update] [what to write]
---

# INK: writing to the diary

The diary is where he keeps what he thought, decided and did, in his own voice, so he can remember
the day in a year. Not a changelog, not a status report, not a list of the tools you used.

Setup (the key, the MCP server, the curl fallback) is at <https://ink.aweditya.com/connect.md>.
Do that first, once, then this file is what to come back to.

Before the first write, call `diary_whoami`: it says which categories and dates this key may file
into. A policy narrower than the work is a refusal waiting to happen.

## Invocation

Two ways in, and both end at the same rules.

**One command per shape.** Each is a thin wrapper that names the preset, so the shape is settled
before the session is read:

| Command | Unit | Depth |
| --- | --- | --- |
| `/ink` | one | `brief` when bare, otherwise the rules decide |
| `/ink-brief` | one | `brief` |
| `/ink-note` | one | `note` |
| `/ink-detail` | one | `detail` |
| `/ink-guide` | one | `guide`, always `verbatim` |
| `/ink-threads` | threads | `note` |
| `/ink-split` | split | `note` |
| `/ink-draft` | draft | the shape words after it, or the rules |
| `/ink-push` | push | whatever the file says |

### The full catalogue

There are 58 commands. `commands/COMMANDS.md` lists every one with what it does, and
`commands/manifest.json` carries the same rows for anything that wants to read them. They are built
from ten categories, four depths, two units and two phases:

```
categories  work  project  learning  thought  quote  task  deadline  life  class  inbox
depths      brief  note  detail  guide
units       one  threads  split
phases      draft  push
```

| Family | Count | What it is |
| --- | --- | --- |
| `/ink-<depth>-<category>` | 40 | one preset shape, as in `/ink-note-project` |
| `/ink-<depth>` | 4 | the same depths, category chosen from the session |
| `/ink-<category>` | 10 | one `brief` note in that category, as in `/ink-work` |
| `/ink-threads`, `/ink-split` | 2 | a unit, both at `note` |
| `/ink-draft`, `/ink-push` | 2 | the two phases of one readable file |

`/ink` itself is the skill with no preset, which is why the files number 58 and not 59.

Examples: `/ink-work shipped the key naming`, `/ink-note-project the grid is generated`,
`/ink-guide-learning how a note learns where it came from`, `/ink-threads` after two unrelated jobs.

### Presets after the skill name

`/ink threads brief`, or `/ink guide how the keys work`. The words come in either order, and
anything that is not a preset is the subject.

| Word | Sets | Means |
| --- | --- | --- |
| `brief` | depth | one or two sentences |
| `note` | depth | three to eight sentences |
| `detail` | depth | two to four paragraphs, with the decision and the blocker |
| `guide` | depth | a written-up method, always `verbatim` |
| `one` | unit | a single note, the default |
| `threads` | unit | one note per separate line of work |
| `split` | unit | one note per distinct decision or topic |

If the harness hands the words over as `$ARGUMENTS` or as a line starting `ARGUMENTS:`, that is the
preset. If they are just the tail of his message, treat them the same way.

A word that is not on the list is the subject, not a preset, so `/ink the deploy broke` files one
note about the deploy. A preset always wins over your own judgement: if he asked for `brief`, do not
deliver `detail`. With no preset at all: `brief` for a bare `/ink`, and `note` once there is a
subject to write about.

### `/ink update`

`/ink update` is not a shape and writes no note. It replaces the local copy of this file and the
command wrappers with what the site serves now, so a change to either lands in the tool you are
running in without another handover. Use it when he says the skill is out of date or asks for an
update, and only then.

- Claude Code reads `~/.claude/commands`, flat, so `ink-brief.md` is `/ink-brief`.
- Codex reads `~/.codex/prompts`, flat, with the same file names.

Refresh every folder on this machine that exists, because he switches between tools:

```sh
base=https://ink.aweditya.com/commands
names=$(curl -fsS "$base/names.txt") || exit 1
for dir in "$HOME/.claude/commands" "$HOME/.codex/prompts"; do
  [ -d "$(dirname "$dir")" ] || continue
  mkdir -p "$dir"
  printf '%s\n' "$names" | while read -r name; do
    curl -fsS "$base/$name.md" -o "$dir/$name.md" || exit 1
  done
  for f in "$dir"/ink-*.md; do
    [ -e "$f" ] || continue
    printf '%s\n' "$names" | grep -qxF "$(basename "$f" .md)" || rm -f "$f"
  done
  echo "$dir: $(ls "$dir"/ink-*.md | wc -l) commands"
done
```

Then fetch <https://ink.aweditya.com/skills/ink/SKILL.md> and write it over the file you are
reading this from, the same path, not a new one. If these words reached you in a message rather
than from a file, there is no path to overwrite: say so, and tell him the wrappers are current
while this text needs fetching again.

The menu is built when a session starts, so `/ink-` will not complete in the session that ran the
update. Report the folders, the counts it printed and that the skill file was rewritten, then stop.
An update is not a session worth remembering, so never file a note about it.

## Category and mode

The command decides the shape, not the shelf. Two more things are settled before the request, and
you own both unless he says otherwise.

**Category comes from what happened.** No preset picks it, because the same `/ink-brief` is `work`
one evening and `life` the next. Choose from the ten by what the note is about. `inbox` is only for
a note with no home; filed there by mistake, a note is invisible in the place he will look for it,
and the month rollup counts it as nothing in particular.

**Mode comes from the depth.** `brief`, `note` and `detail` file as `refine`, so the cleanup formats
them. `guide` files as `verbatim`, always. `detail` may also be `verbatim` when the prose is already
shaped, because `refine` is wrong for finished writing. The API itself defaults to `refine` when
`mode` is left out, and to `inbox` when `category` is.

He can override either, and an override beats both the command and your judgement. Usually the
command name already says it: `/ink-note-work` is a `note` under `work`, `/ink-guide-learning` is a
`guide` under `learning`. For what a name cannot say, three markers still work:

| Written in the invocation | Means |
| --- | --- |
| `cat:work`, `cat:project`, `cat:learning`, `cat:thought`, `cat:quote`, `cat:task`, `cat:deadline`, `cat:life`, `cat:class`, `cat:inbox` | file it in that category |
| `mode:refine`, `mode:verbatim`, `mode:reason`, `mode:think` | file it with that cleanup |
| `due:2026-11-06` | the date for a deadline, required with `cat:deadline` |

```
/ink cat:life the walk fixed my head
/ink-detail cat:project mode:verbatim the key-naming decision, in my own words
/ink-note cat:deadline due:2026-11-06 renew the domain
```

Colons, not `@`, because `@` already means other things in his projects: `@cf/` model ids, `@media`
in CSS, and an address in a note. A marker that can appear in ordinary text is a marker that fires
by accident. Angle brackets are worse, since they are HTML in a diary that renders markup.

These words are markers, not text: strip them from the note. In a batch, put a marker before each
entry when the request spans shelves:

```
/ink-threads cat:work the key naming, cat:project the connect page, cat:learning the two-axis rule
```

## Decide two things before writing

**How many notes** is the unit. **How deep each one is** is the depth. They are independent: one
long note, four short ones, four long ones, all valid. Nobody has to tell you which; pick from the
rules below, and if the session is genuinely ambiguous, ask once rather than guessing at length.

## Units: how many notes

| Unit | When | Example |
| --- | --- | --- |
| `one` (the default) | the session was one stretch of work | an hour chasing a failing deploy |
| `threads` | separate lines of work, each with its own outcome | auth fix **and** a journal backfill |
| `split` | one thread, but distinct decisions worth reading apart | a decision and the thing it unblocked |
| `notes: X; Y; Z` | he named the entries | "note that I shipped X; and that Y is blocked" |

### Which unit, in this order

1. **A name that already says it wins.** `/ink-threads` and `/ink-split` are the unit, and so are
   those words after `/ink-draft`. Every other command is `one`. Do not turn a single-note command
   into a batch because the session was long, and do not collapse a `threads` command into one note
   because it would read neatly.
2. **His words come next.** "Note that X, and that Y" is two entries whatever the command said. A
   plan he made earlier in the session ("file this as a guide at the end") counts as his words. If
   the session outgrew the plan, say so in one line and ask once, rather than quietly refiling it.
3. **Otherwise use the test below.** Length is not a unit: a long session that did one thing is one
   note, and a short session that touched two unrelated things is two.

The test for a unit: **would he want these two facts read together in a year?** If yes, one note. If
a reader would want them apart (different part of the system, different project, different
category), they are separate notes. Not one per file, not one per tool, not one per commit.

A thread is not the same as a topic. Two topics inside one line of work (a bug, then the fix it
suggested) are usually one note; two lines of work that happen to share a category are usually two.

Fewer, better notes: three to five for a real session. Twenty-five is the hard ceiling per request,
and above roughly six it is usually hair-splitting rather than detail.

**All the notes of one session go in one request.** One receipt, one Telegram message, one line of
allowance per note. Two requests means two phone buzzes for one session, which is the wrong kind of
reminder.

## Depth: how long each one

| Depth | Length | Shape | `mode` |
| --- | --- | --- | --- |
| `brief` | 1 to 2 sentences, under ~280 characters | one line, no markup | `refine` |
| `note` | 3 to 8 sentences, ~300 to 900 characters | one or two plain paragraphs | `refine` |
| `detail` | ~900 to 2,000 characters | two to four paragraphs, bullets when it is a list | `refine` for raw thinking, `verbatim` for prose you have already shaped |
| `guide` | ~1,500 to 3,800 characters | a short opening, then paragraphs and bullets; `**bold**` on the decisions, `==highlight==` on the date or number not to forget | `verbatim` |

What changes with depth is not padding but which questions get answered:

- **brief**: what changed. Only add why if the why is the point.
- **note**: what changed, what it means, what is still open.
- **detail**: plus the decision and the alternative rejected, the numbers that made it obvious, and
  the exact blocker, with the file or command named.
- **guide**: plus the method, in the order it actually happened, with the failure modes. Written so
  a future him could do the work again without the transcript.

### Why a guide goes in `verbatim`

The diary's cleanup step is built to cut filler and tighten sentences. That is exactly wrong for a
note whose structure you chose deliberately: it will flatten your bullets into prose and drop the
repetition that makes a method readable. It also switches to a larger model above 1,000 characters,
and that model's instruction is still compression. `verbatim` stores your words exactly, which is
the whole point of writing a guide by hand.

The same rule inverted: `refine` is for handing over raw notes, not finished prose. If you already
wrote it well, say so with `verbatim`.

### What a guide cannot be

The ceiling is 4,000 characters in a note, with no headings, no tables, no code fences and no emoji.
A "blog-style" entry here is an intro paragraph, `- ` bullets, paragraphs, `**bold**` at most three
times, `==highlight==` at most twice. If the material will not fit in 4,000 characters, keep the
method and drop the narrative, or file the background as a second note under `project` and the
method as the guide.

## The input is text, not a document

Send plain text. The diary stores exactly what arrives, and the page rebuilds five things: a blank
line between paragraphs, lines starting `- `, lines starting `1. `, `**bold**`, `*italic*` and
`==highlight==`. Everything else is shown literally, so a fence or a heading you did not strip is
something he will read as punctuation.

| If the draft has | Send instead |
| --- | --- |
| `## Heading` | the words as a short line of their own, or `**bold**` |
| a fenced code block | the lines themselves, no fence |
| a table | one `- ` bullet per row |
| `- [ ] task` | `- task` |
| `[text](url)` | the text, then the address in brackets, or the words alone |
| `> quote` | the words, with the source named in the sentence |
| `---` or `***` | a blank line |
| emoji | nothing |

The mode changes the risk. With `refine` the cleanup lays the note out, so a stray `##` is usually
tidied. With `verbatim`, and with every `guide`, your text is the final copy: what you send is what
he sees, so normalise it before sending.

Default to plain prose with no markup at all. Reach for `- ` only when the list is the point, `**`
for the two or three words that carry it, `==` for a date or a figure. One shape per note.

## The order of work

Compose first, send once. Nothing leaves the context until every note of the set is written.

1. Read the session: what changed, what was decided, what is still open.
2. Choose the unit and the depth, and the category for each note.
3. Draft every note in full, all of them, not the first one with the rest to follow.
4. Normalise the markup, as above: no fences, headings, tables or links.
5. Read the set once: nothing repeats, nothing is filler, and no `cat:` or `due:` is left in the
   prose.
6. Either send one request with one idempotency key, or write the set to the draft file and stop,
   for the two phases below.

There is no draft endpoint on the server and no append endpoint, so there is nothing to send early
and nothing to tidy up afterwards. The draft file in the next section is a local file, not a
request. After the send, each note is not one insert either: the API stores a capture holding your
exact text, then cleans it for its mode, then writes the thought the page shows, and the receipt
names any note that stopped partway. That is why the receipt is read rather than assumed.

## Two phases, when it matters

The one-shot commands compose and send in one move, which is right for a quick line. When the
writing deserves a read before it lands, split the work: draft, then push.

| Command | Does | Sends |
| --- | --- | --- |
| `/ink-draft` | composes the set, writes it to `.ink/draft.md`, revises on request | nothing |
| `/ink-push` | sends the draft exactly as written, in one request | the draft |

The file is plain, and the text after the blank line is what gets stored:

````
# ink draft
day: 2026-11-02
key: codex-2026-11-02-a3f1

## 1
category: work
mode: refine

The text of the first note.

## 2
category: project
mode: verbatim

The text of the second note.
````

**A draft takes the same shape words as a grid command.** Whatever a grid command's name says can be
said after `/ink-draft` instead, and the pair then does what that command does, with a read in the
middle:

| Sends as it writes | Same shape, drafted first | Then |
| --- | --- | --- |
| `/ink-brief-work` | `/ink-draft brief work` | `/ink-push` |
| `/ink-guide-learning` | `/ink-draft guide learning` | `/ink-push` |
| `/ink-threads` | `/ink-draft threads` | `/ink-push` |
| `/ink-split` | `/ink-draft split` | `/ink-push` |

Only the leading words are read as a shape, and only when they name a depth, a unit or a category. A
first word that is none of those is the subject, and then the shape comes from the rules above, which
is what a bare `/ink-draft` does too.

The file carries the categories and the modes, because those are per note. It does not name the
depth or the unit, because a push has no opinion about either: it sends the blocks that are there.

Rules for the two phases:

- **Draft never sends**, not even one note. It writes the file, prints it, and stops. Say in one line
  what you chose (unit, depth, categories, and why), because that line is what he is reviewing.
- **Push sends what is in the file and nothing else.** No sentence rewritten, no note reordered, no
  category changed, because the file is the copy he read.
- **Push refuses rather than repairs.** A missing `day:`, a note with no category, a body over 4,000
  characters or an empty file gets a message and sends nothing.
- **Same key, same request.** The `key:` line is the idempotency key, so a push retried after a
  network failure files nothing and returns the first receipt.
- **After a successful push**, move the file to `.ink/sent/<day>-<key>.md` so the next draft starts
  clean. After a partial failure, leave it where it is and name the notes that failed.

### Revising a draft

The draft is a proposal, so his next message is usually a change rather than a push. A change edits
the file and prints it again. It does not start over.

- **The day and the key survive every revision.** They are what make a retry safe, and a revision
  that minted a new key would make one session look like two sessions.
- **Only the named notes change.** "Make note 2 shorter" does not rewrite notes 1 and 3, because a
  wholesale re-draft throws away the reading he already did.
- **One line says what changed**, and names the notes by number when the numbering moved.
- **A revision never sends**, and a push never revises.
- **After a push the key is spent.** A further change is a new draft with a new key, not a second
  push of the same file, which the API would answer with `duplicate: true`.

"Draft it and push it" in one breath is still two phases: draft, show the file, then push it. The
record of what was reviewed then exists, which is the point.

## Filing it

One request. `diary_add_notes` over MCP, or `POST /api/v1/notes` with `DIARY_API_KEY`:

```json
{ "notes": [
    { "text": "…", "category": "work", "mode": "refine" },
    { "text": "…", "category": "project", "mode": "verbatim" }
  ],
  "idempotencyKey": "codex-2026-11-02-connect-doc" }
```

- **One idempotency key per request.** A retry with the same key files nothing and returns the first
  receipt, so a network failure is always safe to repeat. A genuinely different second entry in the
  same session gets a new key: suffix it, `…-2`.
- **`day`** is today in the diary's timezone unless the work belongs to another day. **`at`** places
  the work at the hour it happened, which matters when four notes come out of one long evening.
- **`category`**: the one fact the reader will scan for. `work` and `project` for the doing,
  `learning` and `thought` for the understanding, `class` for taught material, `task` for something
  to do, `deadline` with `due` for anything dated, `life` for the rest, `quote` for words worth
  keeping exactly, `inbox` when you genuinely cannot tell.

## After

Report the receipt: how many notes, under which categories, the code, and anything that failed by
name. Never round a partial write up to "done": a failed note and a stored one look identical in a
sentence that says "filed".

One note is enough to prove the pipe. Do not write a second copy to be sure.

## Choosing without being told

Bare `/ink` is the quick door: one note, one or two lines, for a phrase he wants kept. If the session
was substantial he reached for the wrong command, so say so in one line and file it anyway rather
than silently stretching a brief.

Invoked by a sentence with no preset, use `one` plus `note`, then move only when the session earned
it: `threads` or `split` when the work genuinely separated, `detail` or `guide` when he said "write
it up", "properly", "detailed", or "as a guide". If he says "just a line", that is `brief`. If he
says nothing, a session that produced a decision is worth `detail`, and one that produced a
repeatable method is worth `guide`.

Worked examples:

- An hour fixing a deploy: `one`, `note`, `work`.
- An auth fix and, separately, a journal backfill: `threads`, two notes, `work` and `project`.
- "Note that I shipped the connect page": `one`, `brief`, `work`.
- "Write up how key naming works, as a guide": `one`, `guide`, `verbatim`, `project`.
- A session with a bug, the fix, and the lesson: `split` into two, the fix (`work`) and the lesson
  (`learning`), both at `note` depth.
- The after-session habit: `/ink-draft`, revise what reads wrong, then `/ink-push`.
