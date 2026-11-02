---
name: ink-draft
description: Draft this session as notes, send nothing, then revise until you push. INK diary command: use only when the owner asks for it.
---

Use the `ink` skill, phase one. This is the after-session path: it composes, and it never sends.

Read the arguments as shape first, subject second:

- A depth alone (`brief`, `note`, `detail`, `guide`), or a depth and a category
  (`brief work`, `guide learning`, and the joined form `brief-work`).
- A unit (`threads`, `split`) in place of the depth word.
- Everything left over is the subject.

A first word that is none of those is the subject, and the shape comes from the skill's rules, exactly as
bare `/ink` would decide it. `/ink-draft` with no argument decides both, which is the usual case after a
session.

So `/ink-draft brief work` drafts what `/ink-brief-work` would send, without sending it.

Choose the unit and the depth, draft every note in full, normalise the markup, and write the set to
`.ink/draft.md` in the format the skill gives.

Print the file, then one line: the unit, the depth, the categories, and why that shape. Then stop. Send
nothing: no request, no proof note, no second copy.

## Revising it

The draft is a proposal, so his next message is usually a change rather than a push: "make note 2
shorter", "drop 3", "merge 1 and 2", "that is project, not work", "say it plainer".

- Change the file in place and print it again with one line saying what changed. Do not re-read the
  session, and do not re-draft the notes he did not name.
- Keep `day:` and `key:` exactly as they are. The key is what makes a retry safe, and a revision that
  minted a new one would make one session look like two.
- Notes are named by their number, which is the `## N` heading. If a change renumbers the blocks, say so
  in the line, so that "note 2" means the same thing on the next turn.
- A revision never sends, even when it is the final one.

`/ink-push` is the only thing that sends. Once it has, the key is spent: a further change is a new draft
with a new key, because the old one would answer `duplicate: true` and file nothing.

The subject, when the owner named one, is what they wrote beside the mention.
