-- A write is metered by the notes it carries, not only by the request that carried them.
--
-- bump_api_usage counts one request. A write key may put 25 notes in one request, so counting
-- requests alone let a 300-a-day ceiling buy 7,500 notes — and with them 7,500 model cleanups.
-- The write route counts the request first (that happens before the body is read, which is what
-- keeps a flood of large bodies cheap), then adds the rest of the batch here, into the same
-- per-minute and per-day buckets, so both ceilings are spent at the rate the notes arrive.
--
-- A separate function rather than a new argument to bump_api_usage: a changed signature would
-- be an overload, not a replacement, and PostgREST would refuse to choose between the two.

create or replace function bump_api_notes(k uuid, extra int, at_time timestamptz default now())
returns table (minute_count int, day_count int)
language plpgsql
as $$
declare
  m int;
begin
  insert into api_usage (key_id, window_start, count)
  values (k, date_trunc('minute', at_time), greatest(extra, 0))
  on conflict (key_id, window_start) do update set count = api_usage.count + greatest(extra, 0)
  returning count into m;

  return query
    select m,
           coalesce((select sum(u.count)::int from api_usage u
                     where u.key_id = k and u.window_start >= date_trunc('day', at_time)), m);
end;
$$;

grant execute on function bump_api_notes(uuid, int, timestamptz) to service_role;
