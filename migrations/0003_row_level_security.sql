-- Lock every table. The Worker uses the service_role key, which bypasses RLS.
-- With RLS on and no policies, the public anon key cannot read or write anything.

alter table categories       enable row level security;
alter table captures         enable row level security;
alter table thoughts         enable row level security;
alter table category_changes enable row level security;
alter table links            enable row level security;
alter table heartbeats       enable row level security;
alter table settings         enable row level security;
