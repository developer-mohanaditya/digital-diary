-- Read API keys, their rate-limit counters, and the two aggregates /api/v1 answers from.
--
-- The key itself is never stored: the row keeps sha256(key) beside a 16-character lookup
-- prefix, so a database leak exposes no working credential. A request hashes what it was
-- given and compares, and the prefix only narrows the search to one row first.

create table if not exists api_keys (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,                      -- "portfolio site", "analysis notebook"
  prefix       text not null unique,               -- ddk_live_xxxxxxx, the lookup index
  hash         text not null,                      -- sha256 of the whole key, hex
  scopes       text[] not null default '{notes:read,deadlines:read,stats:read}',
  per_minute   int  not null default 60,
  per_day      int  not null default 5000,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at   timestamptz,                        -- null: no expiry
  revoked_at   timestamptz                         -- set by Revoke, checked on every request
);

-- One row per key per clock minute. A day's total is the sum of that day's rows, so the
-- daily and burst limits are answered from the same table.
create table if not exists api_usage (
  key_id       uuid not null references api_keys(id) on delete cascade,
  window_start timestamptz not null,
  count        int not null default 0,
  primary key (key_id, window_start)
);
create index if not exists api_usage_window_idx on api_usage (window_start);

-- Counts one request and answers both limits in the same round trip, atomically: two
-- simultaneous requests can never read the same count and both slip under it. Rows older
-- than two days go with it, so the table stays the size of the last two days.
create or replace function bump_api_usage(k uuid, at_time timestamptz default now())
returns table (minute_count int, day_count int)
language plpgsql
as $$
declare
  m int;
begin
  insert into api_usage (key_id, window_start, count)
  values (k, date_trunc('minute', at_time), 1)
  on conflict (key_id, window_start) do update set count = api_usage.count + 1
  returning count into m;

  delete from api_usage u where u.key_id = k and u.window_start < at_time - interval '2 days';

  return query
    select m,
           coalesce((select sum(u.count)::int from api_usage u
                     where u.key_id = k and u.window_start >= date_trunc('day', at_time)), m);
end;
$$;

-- Grouped counts for /api/v1/stats. The group key is formatted in SQL so a year of notes
-- comes back as a few dozen rows instead of every note over the wire.
create or replace function diary_stats(p_from date, p_to date, p_by text)
returns table (bucket text, notes bigint, words bigint, days bigint)
language sql
stable
as $$
  select
    case p_by
      when 'day'      then to_char(t.day, 'YYYY-MM-DD')
      when 'week'     then to_char(t.day, 'IYYY-"W"IW')
      when 'month'    then to_char(t.day, 'YYYY-MM')
      when 'year'     then to_char(t.day, 'YYYY')
      when 'type'     then t.mode
      when 'source'   then t.category_source
      else t.category
    end as bucket,
    count(*)::bigint as notes,
    coalesce(sum(array_length(regexp_split_to_array(btrim(t.clean_text), '\s+'), 1)), 0)::bigint as words,
    count(distinct t.day)::bigint as days
  from thoughts t
  where t.day between p_from and p_to
  group by 1
  order by 1;
$$;

-- The per-day rollup for /api/v1/days: one row a day, with the category tally as JSON.
create or replace function diary_days(p_from date, p_to date)
returns table (day date, notes bigint, words bigint, categories jsonb,
               first_at timestamptz, last_at timestamptz)
language sql
stable
as $$
  select x.day,
         sum(x.n)::bigint as notes,
         sum(x.w)::bigint as words,
         jsonb_object_agg(x.category, x.n) as categories,
         min(x.first_at) as first_at,
         max(x.last_at) as last_at
  from (
    select t.day, t.category, count(*)::bigint as n,
           coalesce(sum(array_length(regexp_split_to_array(btrim(t.clean_text), '\s+'), 1)), 0)::bigint as w,
           min(t.created_at) as first_at,
           max(t.created_at) as last_at
    from thoughts t
    where t.day between p_from and p_to
    group by t.day, t.category
  ) x
  group by x.day
  order by x.day;
$$;

-- Same lockdown as every other table: RLS on, no public policies, service_role only.
alter table api_keys enable row level security;
alter table api_usage enable row level security;
grant select, insert, update, delete on api_keys to service_role;
grant select, insert, update, delete on api_usage to service_role;
grant execute on function bump_api_usage(uuid, timestamptz) to service_role;
grant execute on function diary_stats(date, date, text) to service_role;
grant execute on function diary_days(date, date) to service_role;
