"""git-filter-repo commit callback: drop agent attribution, give the bot commits back to the owner.

Run with:
    git filter-repo --commit-callback "$(cat tools/strip-attribution.py)"

Only touches commit messages and the author identity of the five commits the PR workflow
created. Author/committer dates, committer identity, trees and diffs are left untouched, so
the resulting history has byte-identical file contents at every commit.
"""

import re

CO_AUTHOR = re.compile(rb'^\s*co-authored-by:\s*"?(codebuff|freebuff)', re.IGNORECASE)
FOOTER = re.compile(rb'^\s*(\xf0\x9f\xa4\x96\s*)?generated with\s+codebuff', re.IGNORECASE)

BOT_EMAIL = b"github-actions[bot]@users.noreply.github.com"
OWNER_NAME = b"Mohan Aditya Sadhanala"
OWNER_EMAIL = b"100233499+developer-mohanaditya@users.noreply.github.com"

lines = [line for line in commit.message.split(b"\n") if not CO_AUTHOR.match(line) and not FOOTER.match(line)]
message = b"\n".join(lines).rstrip(b"\n") + b"\n"
if message != commit.message:
    commit.message = message

if commit.author_email.lower().endswith(BOT_EMAIL):
    commit.author_name = OWNER_NAME
    commit.author_email = OWNER_EMAIL
