-- How long each note's cleanup took.
--
-- 0006 recorded what a cleanup cost in tokens; this records how long it took, which is the
-- number the owner actually waits on. The note is not stored until the model answers, so a slow
-- model is half a minute of "typing…" in Telegram and the same half minute behind the page's
-- spinner — invisible until now, because only the tokens were kept.
--
-- Per note, not an average: the case worth spotting is always one slow note, and a mean over a
-- month hides it. The note sheet shows it beside what the cleanup cost.
--
-- Nullable on purpose, and null is not 0. A verbatim note never reached a model, a cleanup that
-- never ran measured nothing, and every note written before this column existed has no figure.
-- A zero would be drawn as "instant", which is the one claim this column must not make.
alter table thoughts
  add column if not exists cleanup_ms integer;
