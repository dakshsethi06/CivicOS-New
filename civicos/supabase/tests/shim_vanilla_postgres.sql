-- TEST ONLY. Makes a plain Postgres look enough like Supabase to run the
-- migrations and the RLS test without PostGIS/pgvector installed.
-- Not needed (and not used) against a real Supabase database.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

create schema extensions;
create schema auth;
create table auth.users (
  id uuid primary key,
  email text,
  raw_app_meta_data jsonb default '{}'::jsonb
);
create function auth.jwt() returns jsonb language sql stable as
$$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as
$$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

-- Geometry stand-ins: run_rls_test.sh rewrites geometry(...) columns to text, and these
-- treat a geometry as its GeoJSON text. Enough to run the migrations and read the data back.
create function public.st_geomfromgeojson(text) returns text language sql immutable as $$ select $1 $$;
create function public.st_asgeojson(text) returns text language sql immutable as $$ select $1 $$;
create function public.st_multi(text) returns text language sql immutable as $$ select $1 $$;
create function public.st_setsrid(text, int) returns text language sql immutable as $$ select $1 $$;
create function public.st_makepoint(float8, float8) returns text language sql immutable as
$$ select format('{"type":"Point","coordinates":[%s,%s]}', $1, $2) $$;
-- the type name only, so plpgsql functions that declare geography variables compile; they are not run in shim mode
create domain public.geography as text;

-- pgvector stand-in: run_rls_test.sh rewrites vector(n) to float8[] and drops HNSW indexes;
-- <=> is cosine distance, as in pgvector. Slow, but exact, which is all the test needs.
create function public.shim_cosine_distance(float8[], float8[]) returns float8 language sql immutable as $$
  select 1 - (select sum(a * b) from unnest($1, $2) t(a, b))
           / nullif(sqrt((select sum(a * a) from unnest($1) a)) * sqrt((select sum(b * b) from unnest($2) b)), 0)
$$;
create operator public.<=> (leftarg = float8[], rightarg = float8[], function = public.shim_cosine_distance);
