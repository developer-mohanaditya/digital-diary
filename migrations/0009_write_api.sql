-- What an API write leaves behind.
--
-- A note filed through POST /api/v1/notes is the same kind of row as one sent to the bot: a
-- capture holding exactly what arrived, then one thought, and a reminder when the note is a
-- deadline. Two columns are new.
--
-- `client` is the app that sent it ("claude-code", "codex"), so a receipt and a row can say
-- where a note came from instead of "the API did it".
--
-- `dedupe_key` is the caller's Idempotency-Key, kept verbatim rather than hashed. A retried
-- request finds the capture it already made and answers with the same receipt instead of
-- filing the note a second time. The uniqueness that makes that retry a no-op is the one the
-- bot already relies on — (source, source_update_id), with the id derived from the key — so
-- this index is here to make the lookup an exact match, not to enforce anything.
--
-- Both are null for every row that already exists and for every Telegram or page capture.

alter table captures add column if not exists client text;
alter table captures add column if not exists dedupe_key text;
create index if not exists captures_dedupe_idx on captures (source, dedupe_key);
