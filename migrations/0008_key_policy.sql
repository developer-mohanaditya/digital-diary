-- A key is no longer all-or-nothing. It can carry a policy: which categories it may read,
-- which days, and whether it may read note text at all. The Worker enforces it on every read
-- (notes, one note, the day rollup, the counts, deadlines, exports); these two aggregates take
-- the category list too, so a limited key cannot count its way around its limit.

alter table api_keys add column if not exists policy jsonb not null default '{}'::jsonb;

-- A new argument makes an overload rather than a replacement, and PostgREST would then refuse
-- to choose between them, so the old signatures go first. Calls that omit the category list
-- still match the new function through its default.
drop function if exists diary_stats(date, date, text);
drop function if exists diary_days(date, date);

create or replace function diary_stats(
  p_from date, p_to date, p_by text, p_categories text[] default null
)
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
    and (p_categories is null or t.category = any (p_categories))
  group by 1
  order by 1;
$$;

create or replace function diary_days(
  p_from date, p_to date, p_categories text[] default null
)
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
      and (p_categories is null or t.category = any (p_categories))
    group by t.day, t.category
  ) x
  group by x.day
  order by x.day;
$$;

grant execute on function diary_stats(date, date, text, text[]) to service_role;
grant execute on function diary_days(date, date, text[]) to service_role;

-- PostgREST caches the schema; this saves the few seconds it would otherwise take to notice.
notify pgrst, 'reload schema';
