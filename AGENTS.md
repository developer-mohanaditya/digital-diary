# Agent notes

## `/impeccable` — design skill

The Impeccable design skill (v4.7.0) lives at `.agents/skills/impeccable`. When the user
writes `/impeccable` or `/impeccable <subcommand> …`, read
[`.agents/skills/impeccable/SKILL.md`](.agents/skills/impeccable/SKILL.md) in full and
follow it; it owns the workflow, the modes and the quality floor for that turn.

Every session that uses it starts here, with the cwd at the project root:

```sh
.agents/skills/impeccable/scripts/impeccable context
```

That loads `PRODUCT.md`, `DESIGN.md`, any surface brief and native guidance, and says what
is missing. Follow its directives and do not run it twice. Add `--target <path>` to scope
it to one file or route. Then load the subcommand's playbook from
`.agents/skills/impeccable/reference/`, and read `reference/craft-floor.md` immediately
before the first UI edit.

Subcommands: `init`, `document`, `extract`, `live`, `generate`, `adapt`, `animate`,
`audit`, `bolder`, `clarify`, `colorize`, `critique`, `delight`, `distill`, `harden`,
`onboard`, `layout`, `optimize`, `overdrive`, `polish`, `quieter`, `shape`, `typeset`,
`craft`.

The launcher is a self-contained binary, so nothing needs installing to use it. The
binaries in `.agents/skills/impeccable/scripts/bin/` are platform-specific and git-ignored;
they are re-downloaded on demand.

Without a subcommand the skill decides from the request: narrowing an existing surface
(`polish`, `critique`, `typeset`…) preserves the incumbent look, while a new surface or a
redesign goes through `init`/`shape` first.

## This project's design truth

The demo shipped in `public/demo/` is the public face of the diary; `public/demo/v2/` is
the current one, and the Worker serves both at `/demo/` and `/demo/v2/`. `src/`, the
Telegram handler and the migrations are backend and are out of scope for design work.

Before changing how anything looks, run it (`npm run dev`, or
`python3 dev-server-v2.py`) and look at the rendered result at the sizes it ships at,
narrow phone width included. The site's tokens live in the `<style>` block of
`public/demo/v2/index.html`: ink, paper, accent, the offset shadow, the heavy 2px edge.
Purple is the accent; nothing else may compete with it.
