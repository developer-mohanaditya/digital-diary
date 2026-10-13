-- The Worker connects with the secret (service_role) key. Row Level Security
-- lets that role through, but it still needs table privileges to read and write.
-- Anon and authenticated keep no grants, so the public key still can't touch data.

grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
