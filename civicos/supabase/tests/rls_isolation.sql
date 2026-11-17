-- Tenant isolation test. Seeds two tenants, then checks as every role that
--   1. no row of the OTHER tenant is visible in any tenant table,
--   2. cross-tenant and privilege-escalating writes are rejected,
--   3. no table in "public" has RLS disabled.
-- Raises an exception (non-zero exit with ON_ERROR_STOP) on the first failure.
\set ON_ERROR_STOP on

begin;

-- ---- seed ------------------------------------------------------------------
insert into auth.users (id, email) values
  ('a0000000-0000-0000-0000-000000000001', 'admin@a.test'),
  ('a0000000-0000-0000-0000-000000000002', 'officer@a.test'),
  ('a0000000-0000-0000-0000-000000000003', 'field@a.test'),
  ('a0000000-0000-0000-0000-000000000004', 'citizen@a.test'),
  ('b0000000-0000-0000-0000-000000000001', 'admin@b.test');

create temp table t_org (tenant text primary key, id uuid) on commit drop;
grant select on t_org to authenticated;

insert into t_org values
  ('A', public.register_organization('a0000000-0000-0000-0000-000000000001', 'Tenant A', 'Admin A', 'admin@a.test', 'mumbai')),
  ('B', public.register_organization('b0000000-0000-0000-0000-000000000001', 'Tenant B', 'Admin B', 'admin@b.test'));

insert into public.users (id, organization_id, role, full_name, email)
select v.id::uuid, (select id from t_org where tenant = 'A'), v.role, v.name, v.email
  from (values
    ('a0000000-0000-0000-0000-000000000002', 'dept_officer', 'Officer A', 'officer@a.test'),
    ('a0000000-0000-0000-0000-000000000003', 'field_worker', 'Field A',   'field@a.test'),
    ('a0000000-0000-0000-0000-000000000004', 'citizen',      'Citizen A', 'citizen@a.test')
  ) as v(id, role, name, email);

-- one row in every remaining tenant table, for both tenants (tenant B has no city dataset)
insert into public.invitations (organization_id, email, role)
  select id, 'x@' || tenant || '.test', 'dept_officer' from t_org;
insert into public.usage_records (organization_id, metric) select id, 'ai_query' from t_org;
insert into public.api_keys (organization_id, name, key_prefix, key_hash)
  select id, 'k', 'civ_test', 'hash' from t_org;
insert into public.infrastructure_assets (organization_id, asset_type) select id, 'streetlight' from t_org;
insert into public.cities (organization_id, name) select id, 'Testville' from t_org where tenant = 'B';
insert into public.complaint_categories (organization_id, code, name) select id, 'roads', 'Roads' from t_org;
insert into public.complaints (organization_id, reference, description) select id, 'x', 'Seed complaint for the isolation test' from t_org;

-- operations (0018): a meter, a reading, an anomaly, a bin, a road, a job and a model run in each tenant
insert into public.ops_datasets (organization_id, kind, generated_at) select id, 'demo', now() from t_org;
insert into public.ops_jobs (organization_id, kind, status) select id, 'demo', 'done' from t_org;
insert into public.model_runs (organization_id, module, model, method) select id, 'water', 'water-anomaly', 'test' from t_org;
insert into public.water_sensors (organization_id, code) select id, 'FM-' || tenant from t_org;
insert into public.water_readings (organization_id, sensor_id, ts, flow_lps, pressure_bar, consumption_m3, anomaly_level)
  select organization_id, id, now(), 10, 2.5, 36, 2 from public.water_sensors;
insert into public.water_anomalies (organization_id, sensor_id, zone_id, started_at, ended_at, level, peak_score, pattern, evidence)
  select s.organization_id, s.id, (select z.id from public.city_zones z where z.organization_id = s.organization_id order by z.code limit 1),
         now() - interval '3 hours', now(), 'high', 0.7, 'Sustained extra flow', '{"consumption_vs_baseline_pct": 40, "pressure_change_bar": -0.5}'
    from public.water_sensors s;
insert into public.waste_bins (organization_id, code, kind, capacity_l) select id, 'BIN-' || tenant, 'residential', 660 from t_org;
insert into public.waste_readings (organization_id, bin_id, ts, fill_pct) select organization_id, id, now(), 50 from public.waste_bins;
insert into public.roads (organization_id, code, name, from_node, to_node, lanes, speed_limit, capacity_vph, length_m)
  select id, 'R-' || tenant, 'Road ' || tenant, 0, 1, 2, 40, 3200, 500 from t_org;
insert into public.traffic_readings (organization_id, road_id, ts, speed_kmh, volume_vph)
  select organization_id, id, now(), 30, 1500 from public.roads;
insert into public.traffic_simulations (organization_id, road_id, action, result)
  select organization_id, id, 'close', '{}' from public.roads;

-- ---- helpers ---------------------------------------------------------------
create function pg_temp.login(p_user uuid) returns void language plpgsql as $$
declare v_meta jsonb;
begin
  select raw_app_meta_data into v_meta from auth.users where id = p_user;
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_user, 'role', 'authenticated', 'app_metadata', v_meta)::text, true);
end $$;

-- ---- 1. the claims trigger wrote org_id and role into the token ------------
do $$
declare v jsonb;
begin
  select raw_app_meta_data into v from auth.users where id = 'a0000000-0000-0000-0000-000000000002';
  if v ->> 'role' <> 'dept_officer' or (v ->> 'org_id')::uuid <> (select id from t_org where tenant = 'A') then
    raise exception 'FAIL claims sync: %', v;
  end if;
  raise notice 'ok   claims synced to auth.users';
end $$;

-- ---- 2. read isolation, every role x every tenant table --------------------
do $$
declare
  v_users constant text[][] := array[
    ['city_admin A',   'a0000000-0000-0000-0000-000000000001', 'A'],
    ['dept_officer A', 'a0000000-0000-0000-0000-000000000002', 'A'],
    ['field_worker A', 'a0000000-0000-0000-0000-000000000003', 'A'],
    ['citizen A',      'a0000000-0000-0000-0000-000000000004', 'A'],
    ['city_admin B',   'b0000000-0000-0000-0000-000000000001', 'B']];
  v_tables text[];
  u text[];
  t text;
  v_own uuid;
  v_foreign int;
  v_total int;
  v_checks int := 0;
begin
  select array_agg(c.table_name::text order by c.table_name) into v_tables
    from information_schema.columns c
    join information_schema.tables tb using (table_schema, table_name)
   where c.table_schema = 'public' and c.column_name = 'organization_id' and tb.table_type = 'BASE TABLE';

  foreach u slice 1 in array v_users loop
    perform pg_temp.login(u[2]::uuid);
    select id into v_own from t_org where tenant = u[3];
    set local role authenticated;

    foreach t in array v_tables loop
      execute format('select count(*) filter (where organization_id <> %L), count(*) from public.%I', v_own, t)
         into v_foreign, v_total;
      if v_foreign > 0 then
        raise exception 'FAIL % sees % foreign rows in %', u[1], v_foreign, t;
      end if;
      v_checks := v_checks + 1;
    end loop;

    execute format('select count(*) from public.organizations where id <> %L', v_own) into v_foreign;
    if v_foreign > 0 then raise exception 'FAIL % sees other organizations', u[1]; end if;
    select count(*) into v_total from public.organizations;
    if v_total <> 1 then raise exception 'FAIL % cannot see own organization', u[1]; end if;

    reset role;
  end loop;
  raise notice 'ok   read isolation: % table checks across % users, tables: %',
    v_checks, array_length(v_users, 1), v_tables;
end $$;

-- ---- 3. role scoping inside one tenant -------------------------------------
do $$
declare n int;
begin
  perform pg_temp.login('a0000000-0000-0000-0000-000000000001');
  set local role authenticated;
  select count(*) into n from public.users;
  if n <> 4 then raise exception 'FAIL city_admin should see 4 users, sees %', n; end if;
  select count(*) into n from public.city_zones;
  if n <> 24 then raise exception 'FAIL city_admin should see 24 Mumbai wards, sees %', n; end if;
  select count(*) into n from public.audit_logs;
  if n = 0 then raise exception 'FAIL city_admin should see audit rows'; end if;
  reset role;

  perform pg_temp.login('a0000000-0000-0000-0000-000000000004');
  set local role authenticated;
  select count(*) into n from public.users;
  if n <> 1 then raise exception 'FAIL citizen should see only own user row, sees %', n; end if;
  select count(*) into n from public.api_keys;
  if n <> 0 then raise exception 'FAIL citizen sees api keys'; end if;
  select count(*) into n from public.audit_logs;
  if n <> 0 then raise exception 'FAIL citizen sees audit logs'; end if;
  select count(*) into n from public.departments;
  if n <> 6 then raise exception 'FAIL citizen should see 6 departments, sees %', n; end if;
  reset role;

  perform pg_temp.login('a0000000-0000-0000-0000-000000000003');
  set local role authenticated;
  select count(*) into n from public.subscriptions;
  if n <> 0 then raise exception 'FAIL field_worker sees subscription'; end if;
  reset role;
  raise notice 'ok   role scoping inside a tenant';
end $$;

-- ---- 4. writes that must be rejected ---------------------------------------
create function pg_temp.must_fail(p_label text, p_sql text) returns void language plpgsql as $$
declare n int;
begin
  begin
    execute p_sql;
    get diagnostics n = row_count;
  exception when others then
    raise notice 'ok   blocked: % (%)', p_label, sqlerrm;
    return;
  end;
  if n = 0 then
    raise notice 'ok   blocked: % (0 rows affected)', p_label;
  else
    raise exception 'FAIL not blocked: % (% rows)', p_label, n;
  end if;
end $$;

do $$
declare
  v_a uuid := (select id from t_org where tenant = 'A');
  v_b uuid := (select id from t_org where tenant = 'B');
begin
  -- city admin of A
  perform pg_temp.login('a0000000-0000-0000-0000-000000000001');
  set local role authenticated;
  perform pg_temp.must_fail('admin A inserts department into B',
    format('insert into public.departments (organization_id, name, code) values (%L, ''x'', ''X'')', v_b));
  perform pg_temp.must_fail('admin A renames org B',
    format('update public.organizations set name = ''hacked'' where id = %L', v_b));
  perform pg_temp.must_fail('admin A upgrades own plan',
    format('update public.organizations set plan_code = ''enterprise'' where id = %L', v_a));
  perform pg_temp.must_fail('admin A promotes a user to super_admin',
    'update public.users set role = ''super_admin'' where id = ''a0000000-0000-0000-0000-000000000002''');
  perform pg_temp.must_fail('admin A moves a user into B',
    format('update public.users set organization_id = %L where id = ''a0000000-0000-0000-0000-000000000002''', v_b));
  perform pg_temp.must_fail('admin A deletes zones of B',
    format('delete from public.city_zones where organization_id = %L', v_b));
  perform pg_temp.must_fail('admin A edits audit log',
    'delete from public.audit_logs');
  perform pg_temp.must_fail('admin A calls register_organization',
    'select public.register_organization(gen_random_uuid(), ''x'', ''x'', ''x@x.test'')');
  reset role;

  -- citizen of A
  perform pg_temp.login('a0000000-0000-0000-0000-000000000004');
  set local role authenticated;
  perform pg_temp.must_fail('citizen makes self admin',
    'update public.users set role = ''city_admin'' where id = ''a0000000-0000-0000-0000-000000000004''');
  perform pg_temp.must_fail('citizen inserts department',
    format('insert into public.departments (organization_id, name, code) values (%L, ''x'', ''Y'')', v_a));
  reset role;

  -- not signed in
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  perform pg_temp.must_fail('anon reads organizations', 'select 1 from public.organizations limit 1');
  reset role;
end $$;

-- ---- 5. allowed writes still work ------------------------------------------
do $$
declare n int;
begin
  perform pg_temp.login('a0000000-0000-0000-0000-000000000001');
  set local role authenticated;
  update public.organizations set name = 'Tenant A renamed' where id = (select id from t_org where tenant = 'A');
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL admin cannot rename own org'; end if;
  insert into public.departments (organization_id, name, code)
    values ((select id from t_org where tenant = 'A'), 'Parks', 'PARKS');
  reset role;
  raise notice 'ok   allowed writes work';
end $$;

-- ---- 5b. published data + dashboard/map functions respect tenancy ----------
do $$
declare
  d jsonb;
  m jsonb;
begin
  perform pg_temp.login('a0000000-0000-0000-0000-000000000001');
  set local role authenticated;
  d := public.dashboard_data();
  m := public.map_data();
  -- values printed in the Praja 2026 report: Table 43 total for 2025, Table 3 closed, Table 29
  if (d #>> '{meta,year}')::int <> 2025 then raise exception 'FAIL latest year should be 2025'; end if;
  if (d #>> '{kpis,registered}')::int <> 130066 then raise exception 'FAIL 2025 complaints: %', d #>> '{kpis,registered}'; end if;
  if (d #>> '{kpis,closed}')::int <> 119458 then raise exception 'FAIL 2025 closed: %', d #>> '{kpis,closed}'; end if;
  if (d #>> '{kpis,avg_days}')::int <> 30 then raise exception 'FAIL 2025 avg days'; end if;
  if (d #>> '{kpis,waste_tpd}')::int <> 6955 then raise exception 'FAIL 2025 waste'; end if;
  if (d #>> '{kpis,water_hours}')::numeric <> 5.37 then raise exception 'FAIL water hours'; end if;
  if jsonb_array_length(d -> 'complaints_by_year') <> 10 or jsonb_array_length(d -> 'issues') <> 18
     or jsonb_array_length(d -> 'wards') <> 24 or jsonb_array_length(d #> '{aqi,grid}') <> 10 then
    raise exception 'FAIL dashboard series incomplete';
  end if;
  if (d #>> '{kpis,health_score}') is null then raise exception 'FAIL health score missing'; end if;
  if jsonb_array_length(m #> '{zones,features}') <> 24 then raise exception 'FAIL map should have 24 wards'; end if;

  d := public.dashboard_data(2019, (select id from public.city_zones where code = 'K/W'), null);
  if (d #>> '{kpis,registered}')::int <> 10399 then raise exception 'FAIL K/W 2019: %', d #>> '{kpis,registered}'; end if;
  d := public.dashboard_data(2018, null, 'Solid Waste Management (SWM)');
  if (d #>> '{kpis,registered}')::int <> 14494 then raise exception 'FAIL SWM 2018: %', d #>> '{kpis,registered}'; end if;
  -- model results are loaded with the dataset
  d := public.ml_data();
  if (d #>> '{models,clustering,id}') is null or jsonb_array_length(d -> 'wards') <> 24 then
    raise exception 'FAIL ward groups missing';
  end if;
  if (d #>> '{forecast,year}')::int <> 2026 or (d #>> '{forecast,lower}')::numeric > (d #>> '{forecast,value}')::numeric
     or (d #>> '{forecast,upper}')::numeric < (d #>> '{forecast,value}')::numeric then
    raise exception 'FAIL city forecast malformed: %', d -> 'forecast';
  end if;
  if jsonb_array_length(d -> 'ward_forecasts') <> 24 then raise exception 'FAIL ward forecasts missing'; end if;
  if (d #>> '{forecast,value}')::int <> 125270 or d #>> '{models,forecast,id}' <> 'complaints-forecast-2026' then
    raise exception 'FAIL complaint forecast mixed with other forecasts: %', d -> 'forecast';
  end if;
  -- three forecast years, nearest first, each range at least as wide as the year before
  if jsonb_array_length(d -> 'forecasts') <> 3 or (d #>> '{forecasts,0,year}')::int <> 2026 or (d #>> '{forecasts,2,year}')::int <> 2028
     or (d #>> '{forecasts,0,value}')::int <> 125270
     or (d #>> '{forecasts,2,upper}')::numeric - (d #>> '{forecasts,2,lower}')::numeric
        < (d #>> '{forecasts,0,upper}')::numeric - (d #>> '{forecasts,0,lower}')::numeric then
    raise exception 'FAIL three-year complaint forecast: %', d -> 'forecasts';
  end if;
  if jsonb_array_length(d #> '{ward_forecasts,0,years}') <> 3 or (d #>> '{ward_forecasts,0,last_year}')::int <> 2025 then
    raise exception 'FAIL ward forecast years: %', d #> '{ward_forecasts,0}';
  end if;
  -- waste, air-quality and water forecasts
  d := public.forecast_extras();
  if jsonb_array_length(d #> '{aqi,history}') <> 120 or jsonb_array_length(d #> '{aqi,forecast}') <> 36 then
    raise exception 'FAIL AQI history/forecast: % / %', jsonb_array_length(d #> '{aqi,history}'), jsonb_array_length(d #> '{aqi,forecast}');
  end if;
  if (d #>> '{aqi,forecast,0,value}')::int <> 144 or (d #>> '{aqi,forecast,7,value}')::int <> 45
     or (d #>> '{aqi,model,params,chosen}') <> 'profile' or (d #>> '{aqi,source,page}')::int <> 46 then
    raise exception 'FAIL AQI forecast values: %', d -> 'aqi';
  end if;
  if (d #>> '{waste,forecast,value}')::int <> 7174 or jsonb_array_length(d #> '{waste,history}') <> 5
     or jsonb_array_length(d #> '{waste,ward_forecasts}') <> 24 or d #>> '{waste,source,table}' <> 'Table 37'
     or jsonb_array_length(d #> '{waste,forecasts}') <> 3 or (d #>> '{waste,forecasts,2,year}')::int <> 2028 then
    raise exception 'FAIL waste forecast: %', d -> 'waste';
  end if;
  if d #>> '{water,model,id}' <> 'water-forecast' or jsonb_array_length(d #> '{water,unfit,history}') <> 5
     or jsonb_array_length(d #> '{water,unfit,forecasts}') <> 4 or (d #>> '{water,unfit,forecasts,0,year}')::int <> 2025
     or (d #>> '{water,unfit,forecasts,0,value}')::numeric <> 0.51
     or jsonb_array_length(d #> '{water,unfit,wards}') <> 24 or jsonb_array_length(d #> '{water,balance,forecasts}') <> 8 then
    raise exception 'FAIL water forecast: %', d -> 'water';
  end if;
  d := public.forecast_extras((select id from public.city_zones where code = 'A'));
  if (d #>> '{waste,forecast,value}')::int <> 125 or (d #>> '{waste,history,0,value}')::int <> 152 then
    raise exception 'FAIL ward A waste forecast: %', d -> 'waste';
  end if;
  reset role;

  perform pg_temp.login('b0000000-0000-0000-0000-000000000001');   -- admin of B: nothing from A
  set local role authenticated;
  d := public.ml_data();
  if d -> 'models' <> '{}'::jsonb or jsonb_array_length(d -> 'wards') <> 0 or d -> 'forecast' <> 'null'::jsonb then
    raise exception 'FAIL admin B sees tenant A models';
  end if;
  d := public.dashboard_data();
  m := public.map_data();
  if (d #>> '{meta,has_data}')::boolean then raise exception 'FAIL admin B sees tenant A data'; end if;
  if jsonb_array_length(m #> '{zones,features}') <> 0 then raise exception 'FAIL admin B map leaks tenant A wards'; end if;
  reset role;
  raise notice 'ok   dashboard_data, map_data and ml_data return the published figures and models, tenant-scoped';
end $$;

-- ---- 5c. complaint workflow ----------------------------------------------------
do $$
declare
  v_kw   uuid := (select z.id from public.city_zones z join t_org o on o.id = z.organization_id where o.tenant = 'A' and z.code = 'K/W');
  v_cat  uuid := (select c.id from public.complaint_categories c join t_org o on o.id = c.organization_id where o.tenant = 'A' and c.code = 'garbage_overflow');
  r jsonb; d jsonb; r2 jsonb;
  v_id uuid; n int;
begin
  -- citizen of A reports garbage, choosing no category: the system suggests one
  perform pg_temp.login('a0000000-0000-0000-0000-000000000004');
  set local role authenticated;
  r := public.submit_complaint(null, 'Garbage not lifted from the dustbin for three days near the school gate', v_kw, 72.8300, 19.1200, null);
  v_id := (r ->> 'id')::uuid;
  d := public.complaint_detail(v_id);
  if (d #>> '{complaint,reference}') not like 'CMP-%' then raise exception 'FAIL reference not generated'; end if;
  if (d #>> '{complaint,status}') <> 'classified' then raise exception 'FAIL status should be classified, is %', d #>> '{complaint,status}'; end if;
  if (d #>> '{complaint,category}') <> 'Garbage overflow' then raise exception 'FAIL suggested category: %', d #>> '{complaint,category}'; end if;
  if (d #>> '{complaint,suggested_severity}') <> 'high' then raise exception 'FAIL priority should be raised to high (school): %', d #>> '{complaint,suggested_severity}'; end if;
  if (d #>> '{complaint,expected_days}') is null or (d #>> '{complaint,expected_days_basis}') not like '%Solid Waste Management (SWM) complaints in Ward K/W, 2025%Table 40%' then
    raise exception 'FAIL expected days should come from the ward SWM average: %', d #>> '{complaint,expected_days_basis}';
  end if;
  if jsonb_array_length(d -> 'history') <> 2 then raise exception 'FAIL history should have 2 rows'; end if;

  -- a near-identical report 40 m away is flagged as a possible duplicate
  r2 := public.submit_complaint(v_cat, 'Garbage not lifted from dustbin for 3 days near school gate', v_kw, 72.8303, 19.1202, null);
  if (public.complaint_detail((r2 ->> 'id')::uuid) #>> '{complaint,duplicate,id}')::uuid <> v_id then raise exception 'FAIL duplicate not flagged'; end if;

  -- a citizen cannot run the workflow, and cannot smuggle fields in through a direct insert
  begin
    perform public.complaint_action(v_id, 'assign', null, 'a0000000-0000-0000-0000-000000000003');
    raise exception 'FAIL citizen assigned a complaint';
  exception when sqlstate 'P0001' then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  insert into public.complaints (organization_id, citizen_id, category_id, description, status, severity_confirmed, reference)
  values ((select id from t_org where tenant = 'A'), 'a0000000-0000-0000-0000-000000000004', v_cat,
          'Trying to insert a complaint that is already verified', 'verified', true, 'HACK');
  select count(*) into n from public.complaints where status = 'verified' or reference = 'HACK';
  if n <> 0 then raise exception 'FAIL submitter set protected fields'; end if;
  select count(*) into n from public.complaints;
  if n <> 3 then raise exception 'FAIL citizen should see exactly own 3 complaints, sees %', n; end if;
  reset role;

  -- officer assigns to the field worker, confirming priority
  perform pg_temp.login('a0000000-0000-0000-0000-000000000002');
  set local role authenticated;
  if public.complaint_action(v_id, 'assign', 'Send the morning crew', 'a0000000-0000-0000-0000-000000000003', 'medium') <> 'assigned' then
    raise exception 'FAIL assign';
  end if;
  begin
    perform public.complaint_action(v_id, 'verify');
    raise exception 'FAIL verified before resolution';
  exception when sqlstate 'P0001' then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  reset role;

  -- field worker sees only the assigned complaint, starts and resolves it, but cannot verify
  perform pg_temp.login('a0000000-0000-0000-0000-000000000003');
  set local role authenticated;
  select count(*) into n from public.complaints;
  if n <> 1 then raise exception 'FAIL field worker should see 1 assigned complaint, sees %', n; end if;
  perform public.complaint_action(v_id, 'start');
  perform public.complaint_action(v_id, 'resolve', 'Bin emptied and area cleaned');
  begin
    perform public.complaint_action(v_id, 'verify');
    raise exception 'FAIL field worker verified';
  exception when sqlstate 'P0001' then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  reset role;

  perform pg_temp.login('a0000000-0000-0000-0000-000000000002');
  set local role authenticated;
  if public.complaint_action(v_id, 'verify') <> 'verified' then raise exception 'FAIL verify'; end if;
  d := public.complaint_detail(v_id);
  if jsonb_array_length(d -> 'history') <> 6 then raise exception 'FAIL history should have 6 rows, has %', jsonb_array_length(d -> 'history'); end if;
  if (d #>> '{complaint,severity}') <> 'medium' or not (d #>> '{complaint,severity_confirmed}')::boolean then raise exception 'FAIL officer priority not kept'; end if;
  if (d #> '{history,2}' ->> 'note') <> 'Send the morning crew' or (d #> '{history,1}' ->> 'actor') <> 'System' then
    raise exception 'FAIL history notes/actors: %', d -> 'history';
  end if;
  reset role;

  -- the citizen can follow the whole history of their own complaint
  perform pg_temp.login('a0000000-0000-0000-0000-000000000004');
  set local role authenticated;
  if jsonb_array_length(public.complaint_detail(v_id) -> 'history') <> 6 then raise exception 'FAIL citizen cannot read own history'; end if;
  reset role;

  -- tenant B sees and can do nothing
  perform pg_temp.login('b0000000-0000-0000-0000-000000000001');
  set local role authenticated;
  if public.complaint_detail(v_id) -> 'complaint' <> 'null'::jsonb or jsonb_array_length(public.complaint_detail(v_id) -> 'history') <> 0 then
    raise exception 'FAIL tenant B reads tenant A complaint';
  end if;
  begin
    perform public.complaint_action(v_id, 'reopen', 'x');
    raise exception 'FAIL tenant B acted on tenant A complaint';
  exception when sqlstate 'P0001' then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  reset role;
  raise notice 'ok   complaint workflow: suggestions, duplicate flag, role-gated transitions, history, tenancy';
end $$;

-- ---- 5d. knowledge base, assistant, recommendations, plans, API keys --------------
do $$
declare
  v_a uuid := (select id from t_org where tenant = 'A');
  v_doc uuid; v_pub uuid; r jsonb; k jsonb; n int;
begin
  -- officer adds a staff document and a public one
  perform pg_temp.login('a0000000-0000-0000-0000-000000000002');
  set local role authenticated;
  v_doc := public.document_create('Solid Waste Rules', 'Policy', 'staff', 'x/rules.pdf', 'application/pdf');
  perform public.document_finish(v_doc, '[{"page": 3, "content": "Every bulk waste generator shall process biodegradable waste within the premises through composting or biomethanation."},
                                           {"page": 7, "content": "Street sweeping shall be carried out daily in commercial areas."}]'::jsonb, 9);
  v_pub := public.document_create('Public notice on water timings', 'Notice', 'public', 'x/notice.txt', 'text/plain');
  perform public.document_finish(v_pub, '[{"page": 1, "content": "Water supply timings in the ward will change from Monday. Supply will be given in the morning between six and eight."}]'::jsonb, 1);

  r := public.search_documents('How must a bulk waste generator process biodegradable waste?');
  if jsonb_array_length(r) < 1 or (r #>> '{0,title}') <> 'Solid Waste Rules' or (r #>> '{0,page}')::int <> 3 then
    raise exception 'FAIL search should return the rules chunk on page 3: %', r;
  end if;
  if jsonb_array_length(public.search_documents('quantum chromodynamics lattice gauge')) <> 0 then
    raise exception 'FAIL an unrelated question should retrieve nothing';
  end if;

  -- facts come from the published tables
  r := public.assistant_facts('How many hours of water supply does ward K/W get?');
  if not exists (select 1 from jsonb_array_elements(r) f where f ->> 'text' = 'Water supply, Ward K/W, 2024: 2.37 hours/day' and f ->> 'source' like 'Praja Foundation, Table 4, p. 14') then
    raise exception 'FAIL water fact for K/W missing: %', r;
  end if;
  if jsonb_array_length(public.assistant_facts('hello there')) <> 0 then raise exception 'FAIL small talk should produce no facts'; end if;

  r := public.assistant_retrieve('How must a bulk waste generator process waste, and what share do not?');
  if not (r ->> 'allowed')::boolean or jsonb_array_length(r -> 'chunks') = 0 or jsonb_array_length(r -> 'facts') = 0 then
    raise exception 'FAIL retrieve should return chunks and facts: %', r;
  end if;
  perform public.assistant_save(null, 'q', 'a [D1]', '[]'::jsonb, '{}', 1, 'extractive');
  if jsonb_array_length(public.assistant_history(null) -> 'conversations') <> 1 then raise exception 'FAIL conversation not saved'; end if;

  -- officers decide on recommendations; the decision is recorded
  select count(*) into n from public.recommendations;
  if n = 0 then raise exception 'FAIL no recommendations generated for the Mumbai data'; end if;
  if not exists (select 1 from public.recommendations where rule = 'aqi_season' and problem like '%Jan, Feb, Mar, Nov, Dec of 2026%') then
    raise exception 'FAIL air-quality season recommendation: %', (select problem from public.recommendations where rule = 'aqi_season');
  end if;
  r := public.assistant_facts('What will the air quality be in 2026?');
  if jsonb_array_length(r) <> 12 or r -> 0 ->> 'text' not like 'Forecast average AQI, Mumbai, January 2026: 144%' then
    raise exception 'FAIL assistant AQI forecast: %', r;
  end if;
  r := public.assistant_facts('Forecast of waste lifted in ward A next year');
  if not exists (select 1 from jsonb_array_elements(r) e where e ->> 'text' like 'Forecast of waste lifted, Ward A, 2026: 125 tonnes/day (80% range %')
     or exists (select 1 from jsonb_array_elements(r) e where e ->> 'text' like 'Forecast%2027%') then
    raise exception 'FAIL assistant waste forecast (next year only): %', r;
  end if;
  r := public.assistant_facts('Forecast of waste lifted in ward A over the next three years');
  if (select count(*) from jsonb_array_elements(r) e where e ->> 'text' like 'Forecast of waste lifted, Ward A, 202_:%') <> 3 then
    raise exception 'FAIL assistant three-year waste forecast: %', r;
  end if;
  r := public.assistant_facts('Will drinking water be unfit in ward A in 2027?');
  if not exists (select 1 from jsonb_array_elements(r) e where e ->> 'text' like 'Forecast of drinking-water samples found unfit, Ward A, 2027: % \%%' escape '\') then
    raise exception 'FAIL assistant water forecast: %', r;
  end if;
  if public.recommendation_decide((select id from public.recommendations order by key limit 1), 'accept', 'Agreed') <> 'accepted' then
    raise exception 'FAIL accept';
  end if;
  begin
    perform public.change_plan('enterprise');
    raise exception 'FAIL officer changed the plan';
  exception when sqlstate 'P0001' then if sqlerrm like 'FAIL%' then raise; end if;
  end;
  reset role;

  -- resident: only the public document, no recommendations, own conversations only
  perform pg_temp.login('a0000000-0000-0000-0000-000000000004');
  set local role authenticated;
  select count(*) into n from public.documents;
  if n <> 1 then raise exception 'FAIL resident should see 1 public document, sees %', n; end if;
  if jsonb_array_length(public.search_documents('bulk waste generator process biodegradable')) <> 0 then raise exception 'FAIL resident retrieved a staff document'; end if;
  if jsonb_array_length(public.search_documents('water supply timings morning')) <> 1 then raise exception 'FAIL resident cannot search the public document'; end if;
  select count(*) into n from public.recommendations;
  if n <> 0 then raise exception 'FAIL resident sees recommendations'; end if;
  if jsonb_array_length(public.assistant_history(null) -> 'conversations') <> 0 then raise exception 'FAIL resident sees an officer conversation'; end if;
  begin
    perform public.document_create('x', 'x', 'public', 'x', 'text/plain');
    raise exception 'FAIL resident created a document';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if;
  end;
  reset role;

  -- admin: plan switch (test mode), usage, API key lifecycle
  perform pg_temp.login('a0000000-0000-0000-0000-000000000001');
  set local role authenticated;
  r := public.usage_summary();
  if (r #>> '{usage,documents}')::int <> 2 or (r #>> '{usage,ai_queries}')::int <> 2 or (r #>> '{plan,code}') <> 'free' then
    raise exception 'FAIL usage summary: %', r;
  end if;
  k := public.create_api_key('Open data portal');
  if (k ->> 'key') not like 'civ_%' or exists (select 1 from public.api_keys where key_hash = k ->> 'key') then raise exception 'FAIL api key not hashed'; end if;
  begin
    perform public.api_indicators(k ->> 'key', 'population');
    raise exception 'FAIL a signed-in user called the server-only API function';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.platform_overview();
    raise exception 'FAIL city admin opened the platform overview';
  exception when sqlstate 'P0001' then if sqlerrm like 'FAIL%' then raise; end if;
  end;
  if jsonb_array_length(public.audit_recent(20)) = 0 then raise exception 'FAIL audit log empty for admin'; end if;
  reset role;

  -- the public API (service role): valid key, wrong key, rate limit, revoked key
  r := public.api_indicators(k ->> 'key', 'complaints_registered', 2025, 'k/w');
  if (r ->> 'status')::int <> 200 or jsonb_array_length(r -> 'data') <> 3 then raise exception 'FAIL api data: %', r; end if;
  if (public.api_indicators('civ_wrong') ->> 'status')::int <> 401 then raise exception 'FAIL wrong key accepted'; end if;
  insert into public.usage_records (organization_id, metric) select v_a, 'api_call' from generate_series(1, 60);
  if (public.api_indicators(k ->> 'key') ->> 'status')::int <> 429 then raise exception 'FAIL rate limit not applied'; end if;
  delete from public.usage_records where organization_id = v_a and metric = 'api_call';
  perform pg_temp.login('a0000000-0000-0000-0000-000000000001');
  set local role authenticated;
  perform public.revoke_api_key((k ->> 'id')::uuid);
  reset role;
  if (public.api_indicators(k ->> 'key') ->> 'status')::int <> 401 then raise exception 'FAIL revoked key still works'; end if;

  -- monthly AI limit on the free plan (50), then lifted by a test-mode upgrade
  insert into public.usage_records (organization_id, metric) select v_a, 'ai_query' from generate_series(1, 49);
  perform pg_temp.login('a0000000-0000-0000-0000-000000000001');
  set local role authenticated;
  if (public.assistant_retrieve('water supply') ->> 'allowed')::boolean then raise exception 'FAIL AI limit not enforced'; end if;
  perform public.change_plan('pro');
  if not (public.assistant_retrieve('water supply') ->> 'allowed')::boolean then raise exception 'FAIL upgrade did not lift the limit'; end if;
  perform public.change_plan('free');
  reset role;
  delete from public.usage_records where organization_id = v_a and metric = 'ai_query';

  -- tenant B sees none of it
  perform pg_temp.login('b0000000-0000-0000-0000-000000000001');
  set local role authenticated;
  select count(*) into n from public.documents;
  if n <> 0 or jsonb_array_length(public.search_documents('bulk waste generator biodegradable')) <> 0
     or jsonb_array_length(public.recommendation_list() -> 'rows') <> 0 then
    raise exception 'FAIL tenant B sees tenant A knowledge base or recommendations';
  end if;
  reset role;
  raise notice 'ok   knowledge base, assistant, recommendations, plans, API keys: behaviour and tenancy';
end $$;

-- ---- 5e. semantic retrieval (embeddings from the backend) ----------------------------
-- a unit vector along axis k: orthogonal test embeddings with known similarities
create function pg_temp.unit(k int) returns vector(768) language sql immutable as
$$ select (select array_agg(case when i = k then 1 else 0 end order by i) from generate_series(1, 768) i)::vector(768) $$;

do $$
declare
  v_rules uuid := (select id from public.documents where title = 'Solid Waste Rules');
  v_pub   uuid := (select id from public.documents where title = 'Public notice on water timings');
  v_a     uuid := (select id from t_org where tenant = 'A');
  r jsonb;
begin
  -- the officer's backend session stores one embedding per chunk
  perform pg_temp.login('a0000000-0000-0000-0000-000000000002');
  set local role authenticated;
  insert into public.document_embeddings (chunk_id, organization_id, document_id, model, embedding)
  select c.id, v_a, c.document_id, 'test', pg_temp.unit(case when c.document_id = v_pub then 3 when c.page_number = 3 then 1 else 2 end)
    from public.document_chunks c where c.document_id in (v_rules, v_pub);

  -- a paraphrase with no shared words is found by meaning alone
  r := public.match_document_chunks('zzqx', pg_temp.unit(1), 5, 0.5);
  if jsonb_array_length(r) <> 1 or (r #>> '{0,page}')::int <> 3 or (r #>> '{0,similarity}')::numeric <> 1 then
    raise exception 'FAIL vector search should return only the page-3 rules chunk: %', r;
  end if;
  -- keyword and vector evidence are fused: a word match survives a low similarity
  r := public.match_document_chunks('street sweeping', pg_temp.unit(1), 5, 0.5);
  if not exists (select 1 from jsonb_array_elements(r) e where (e ->> 'page')::int = 7) then
    raise exception 'FAIL keyword match dropped by fusion: %', r;
  end if;
  -- keyword-only mode (no embedding provider) still works
  if (public.match_document_chunks('composting biomethanation') #>> '{0,page}')::int <> 3 then
    raise exception 'FAIL keyword-only retrieval';
  end if;
  reset role;

  -- a resident never retrieves a staff document, even by its exact vector
  perform pg_temp.login('a0000000-0000-0000-0000-000000000004');
  set local role authenticated;
  if jsonb_array_length(public.match_document_chunks('zzqx', pg_temp.unit(1), 5, 0.5)) <> 0 then
    raise exception 'FAIL resident retrieved a staff document by vector';
  end if;
  if (public.match_document_chunks('zzqx', pg_temp.unit(3), 5, 0.5) #>> '{0,title}') <> 'Public notice on water timings' then
    raise exception 'FAIL resident cannot retrieve the public document by vector';
  end if;
  begin
    insert into public.document_embeddings (chunk_id, organization_id, document_id, model, embedding)
    select id, v_a, document_id, 'x', pg_temp.unit(5) from public.document_chunks limit 1;
    raise exception 'FAIL resident stored an embedding';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if;
  end;
  reset role;

  -- another municipality sees nothing, whatever the vector
  perform pg_temp.login('b0000000-0000-0000-0000-000000000001');
  set local role authenticated;
  if jsonb_array_length(public.match_document_chunks('bulk waste composting', pg_temp.unit(1), 5, 0)) <> 0
     or exists (select 1 from public.document_embeddings) then
    raise exception 'FAIL tenant B retrieves tenant A embeddings';
  end if;
  if (public.assistant_quota() ->> 'allowed')::boolean is not true then raise exception 'FAIL quota for tenant B'; end if;
  reset role;
  raise notice 'ok   semantic retrieval: vector + keyword fusion, access levels, tenancy';
end $$;

-- ---- 5f. operations: staff-only reads, writes by the administrator, anomaly review, tenancy --------
do $$
declare d jsonb; n int;
begin
  -- field worker: reads the tenant's operations data, cannot write model outputs
  perform pg_temp.login('a0000000-0000-0000-0000-000000000003');
  set local role authenticated;
  select count(*) into n from public.water_readings;
  if n <> 1 then raise exception 'FAIL field worker should see 1 reading, sees %', n; end if;
  d := public.ops_water();
  if jsonb_array_length(d -> 'sensors') <> 1 or (d -> 'sensors' -> 0 -> 'properties' ->> 'code') <> 'FM-A' then
    raise exception 'FAIL ops_water for field worker A: %', d -> 'sensors';
  end if;
  if (public.ops_status() -> 'predictions_enabled')::boolean then raise exception 'FAIL free plan has predictions'; end if;
  perform pg_temp.must_fail('field worker writes a model run',
    format('insert into public.model_runs (organization_id, module, model, method) values (%L, ''water'', ''x'', ''x'')',
           (select id from t_org where tenant = 'A')));
  reset role;

  -- citizen: no operations data at all
  perform pg_temp.login('a0000000-0000-0000-0000-000000000004');
  set local role authenticated;
  select count(*) into n from public.water_readings;
  if n <> 0 then raise exception 'FAIL citizen sees sensor readings'; end if;
  if jsonb_array_length(public.ops_water() -> 'sensors') <> 0 then raise exception 'FAIL citizen sees meters'; end if;
  if jsonb_array_length(public.ops_traffic() -> 'roads') <> 0 then raise exception 'FAIL citizen sees roads'; end if;
  if public.ops_summary() is not null then raise exception 'FAIL citizen sees the operations summary'; end if;
  if jsonb_array_length(public.map_layers() -> 'roads' -> 'features') <> 0 then raise exception 'FAIL citizen sees road layer'; end if;
  reset role;

  -- officer: refreshes recommendations, which now include the operations rules
  perform pg_temp.login('a0000000-0000-0000-0000-000000000002');
  set local role authenticated;
  perform public.refresh_recommendations();
  if not exists (select 1 from public.recommendations where rule = 'water_anomaly' and module = 'water' and priority = 'high'
                  and problem like '%Sustained extra flow%' and evidence::text like '%FM-A%') then
    raise exception 'FAIL water anomaly recommendation: %', (select jsonb_agg(problem) from public.recommendations where module = 'water');
  end if;
  if not exists (select 1 from public.recommendations where rule = 'aqi_season') then
    raise exception 'FAIL published-figure recommendations lost when operations rules were added';
  end if;
  -- officer: reviews own tenant's anomaly, not another's; cannot write model outputs
  perform public.water_anomaly_review((select id from public.water_anomalies limit 1), 'inspecting');
  select count(*) into n from public.water_anomalies where status = 'inspecting' and reviewed_by = 'a0000000-0000-0000-0000-000000000002';
  if n <> 1 then raise exception 'FAIL officer review not recorded'; end if;
  perform pg_temp.must_fail('officer A writes a model run',
    format('insert into public.model_runs (organization_id, module, model, method) values (%L, ''water'', ''x'', ''x'')',
           (select id from t_org where tenant = 'A')));
  reset role;
  n := (select a.id from public.water_anomalies a join t_org o on o.id = a.organization_id where o.tenant = 'B');
  set local role authenticated;
  perform pg_temp.must_fail('officer A reviews tenant B anomaly', format('select public.water_anomaly_review(%s, ''dismissed'')', n));
  reset role;
  select count(*) into n from public.water_anomalies a join t_org o on o.id = a.organization_id where o.tenant = 'B' and a.status <> 'open';
  if n <> 0 then raise exception 'FAIL tenant B anomaly changed'; end if;

  -- administrator B: only B's data in every operations read
  perform pg_temp.login('b0000000-0000-0000-0000-000000000001');
  set local role authenticated;
  d := public.ops_water();
  if jsonb_array_length(d -> 'sensors') <> 1 or (d -> 'sensors' -> 0 -> 'properties' ->> 'code') <> 'FM-B' then
    raise exception 'FAIL ops_water for B: %', d -> 'sensors';
  end if;
  if jsonb_array_length(public.ops_waste() -> 'bins') <> 1 then raise exception 'FAIL ops_waste for B'; end if;
  if (public.ops_summary() -> 'water' ->> 'open_anomalies')::int <> 1 then raise exception 'FAIL ops_summary for B: %', public.ops_summary(); end if;
  d := public.map_layers();
  if jsonb_array_length(d -> 'roads' -> 'features') <> 1 or jsonb_array_length(d -> 'bins' -> 'features') <> 1 then
    raise exception 'FAIL map_layers for B';
  end if;
  d := public.ops_traffic();
  if jsonb_array_length(d -> 'roads') <> 1 or jsonb_array_length(d -> 'simulations') <> 1 then
    raise exception 'FAIL ops_traffic for B: %', d;
  end if;
  reset role;
  raise notice 'ok   operations: staff-only reads, admin-only model writes, anomaly review, tenancy';
end $$;

-- ---- 5g. complaint AI: similar complaints, suggestions only, who may record them -------------------------
do $$
declare
  v_a uuid := (select id from t_org where tenant = 'A');
  v_road uuid; v_light uuid; c1 uuid; c2 uuid; c3 uuid; r jsonb; n int;
begin
  select id into v_road from public.complaint_categories where organization_id = v_a and code = 'road_damage';
  select id into v_light from public.complaint_categories where organization_id = v_a and code = 'streetlight';
  if (select description from public.complaint_categories where id = v_road) is null then
    raise exception 'FAIL category descriptions were not filled in';
  end if;

  -- the citizen reports the same pothole twice, and a broken light at the same spot
  perform pg_temp.login('a0000000-0000-0000-0000-000000000004');
  set local role authenticated;
  c1 := (public.submit_complaint(v_road, 'Big pothole on Link Road near the petrol pump', null, 72.8400, 19.1300) ->> 'id')::uuid;
  c2 := (public.submit_complaint(v_road, 'Huge gaddha on Link Road next to the petrol pump', null, 72.8401, 19.1301) ->> 'id')::uuid;
  c3 := (public.submit_complaint(v_light, 'Streetlight not working near the petrol pump on Link Road', null, 72.8400, 19.1300) ->> 'id')::uuid;
  begin
    perform public.complaint_ai_apply(c2, 'x', v_road, 0.9, '{}', '[]', null);
    raise exception 'FAIL a citizen recorded an AI analysis';
  exception when sqlstate 'P0001' then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  reset role;

  -- embeddings: c1 and c2 point the same way, c3 elsewhere (unit vectors, so similarity is exact)
  insert into public.complaint_embeddings (complaint_id, organization_id, model, embedding)
  values (c1, v_a, 'test', pg_temp.unit(1)), (c3, v_a, 'test', pg_temp.unit(2));

  -- the analysis service (an administrator's claims) finds c1 as similar to c2, near and open
  perform pg_temp.login('a0000000-0000-0000-0000-000000000001');
  set local role authenticated;
  select count(*) into n from public.complaint_similar(c2, pg_temp.unit(1), 150, 5) x where x.id = c1 and x.similarity > 0.99 and x.distance_m < 20;
  if n <> 1 then raise exception 'FAIL complaint_similar did not find the near duplicate'; end if;
  r := public.complaint_ai_apply(c2, 'test-model', v_road, 0.93, '{"road_damage": 0.93}',
         jsonb_build_array(jsonb_build_object('id', c3, 'reference', 'x', 'distance_m', 0, 'similarity', 0.95, 'same_category', false),
                           jsonb_build_object('id', c1, 'reference', 'CMP-1', 'distance_m', 14, 'similarity', 0.96, 'same_category', true)),
         '{"road_damage": true, "severity": "high", "summary": "A deep pothole", "matches_description": true}');
  if (select duplicate_of from public.complaints where id = c2) is distinct from c1 then
    raise exception 'FAIL duplicate should link to the same-category complaint, not the streetlight';
  end if;
  if (select suggested_severity from public.complaints where id = c2) <> 'high' or (select severity_confirmed from public.complaints where id = c2) then
    raise exception 'FAIL a severe pothole photo should raise the suggested priority one step, unconfirmed';
  end if;
  if not exists (select 1 from public.complaint_history where complaint_id = c2 and note like 'AI analysis:%') then
    raise exception 'FAIL the analysis was not written to the history';
  end if;
  if (public.complaint_ai_view(c2) ->> 'ai_similarity')::real < 0.9 then raise exception 'FAIL complaint_ai_view'; end if;
  reset role;

  -- another municipality cannot record an analysis on A's complaint, or see it
  perform pg_temp.login('b0000000-0000-0000-0000-000000000001');
  set local role authenticated;
  begin
    perform public.complaint_ai_apply(c1, 'x', null, null, null, '[]', null);
    raise exception 'FAIL tenant B analysed tenant A complaint';
  exception when sqlstate 'P0001' then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  if public.complaint_ai_view(c2) is not null then raise exception 'FAIL tenant B reads A''s complaint analysis'; end if;
  select count(*) into n from public.complaint_embeddings;
  if n <> 0 then raise exception 'FAIL tenant B sees A''s complaint embeddings'; end if;
  reset role;
  raise notice 'ok   complaint AI: similar complaints, same-category duplicate link, photo priority, roles, tenancy';
end $$;

-- ---- 5h. assistant tools: operations facts (RLS-scoped) and charts saved with answers ----------------------
do $$
declare r jsonb; v_conv uuid;
begin
  perform pg_temp.login('a0000000-0000-0000-0000-000000000003');            -- field worker A
  set local role authenticated;
  r := public.assistant_ops('water', null);
  if not exists (select 1 from jsonb_array_elements_text(r -> 'facts') f where f like 'Open water anomalies, Mumbai: 1%') then
    raise exception 'FAIL assistant_ops water for A: %', r;
  end if;
  if (r ->> 'source') not like '%demonstration data%' then raise exception 'FAIL demo data not labelled: %', r ->> 'source'; end if;
  r := public.assistant_ops('waste', null);                                   -- bins but no predictions in this seed
  if r ->> 'note' not like 'There are bins but no overflow predictions yet%' then raise exception 'FAIL assistant_ops waste: %', r; end if;
  r := public.assistant_ops('traffic', null);
  if jsonb_array_length(r -> 'facts') = 0 or r -> 'chart' is null then raise exception 'FAIL assistant_ops traffic: %', r; end if;
  r := public.assistant_ops('water', 'no-such-ward');
  if r ->> 'note' not like 'There is no ward%' then raise exception 'FAIL unknown ward: %', r; end if;
  begin
    perform public.assistant_ops('rockets', null);
    raise exception 'FAIL unknown module accepted';
  exception when sqlstate 'P0001' then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  reset role;

  perform pg_temp.login('a0000000-0000-0000-0000-000000000004');            -- citizen A: no operations data
  set local role authenticated;
  r := public.assistant_ops('water', null);
  if jsonb_array_length(coalesce(r -> 'facts', '[]')) <> 0 then raise exception 'FAIL citizen gets operations facts: %', r; end if;
  -- an answer with a chart is saved and comes back in the history
  v_conv := public.assistant_save(null, 'q', 'a [F1]', '[]', '{}', 1, 'llm', '[]', '[{"type": "bar", "title": "t", "data": [{"x": 1}]}]');
  if (public.assistant_history(v_conv) #>> '{messages,1,charts,0,title}') <> 't' then raise exception 'FAIL chart not saved with the answer'; end if;
  reset role;

  perform pg_temp.login('b0000000-0000-0000-0000-000000000001');            -- admin B: only B's meter and anomaly
  set local role authenticated;
  r := public.assistant_ops('water', null);
  if not exists (select 1 from jsonb_array_elements_text(r -> 'facts') f where f like 'Open water anomalies, Mumbai: 1%') then
    raise exception 'FAIL assistant_ops water for B: %', r;
  end if;
  reset role;
  raise notice 'ok   assistant tools: operations facts by role and tenant, demo label, charts saved with answers';
end $$;

-- ---- 5i. field work, inspection reports, department scoping, invitations -----------------------------------
do $$
declare
  v_a uuid := (select id from t_org where tenant = 'A');
  v_water uuid; v_waste uuid; c_water uuid; c_waste uuid; t jsonb; v_task uuid; n int; r jsonb; v_rec uuid;
begin
  select id into v_water from public.departments where organization_id = v_a and code = 'WATER';
  select id into v_waste from public.departments where organization_id = v_a and code = 'WASTE';
  -- officer A works in Water Supply (the claims trigger puts the department in the token)
  update public.users set department_id = v_water where id = 'a0000000-0000-0000-0000-000000000002';

  perform pg_temp.login('a0000000-0000-0000-0000-000000000004');            -- citizen reports a leak and a garbage pile
  set local role authenticated;
  c_water := (public.submit_complaint((select id from public.complaint_categories where organization_id = v_a and code = 'water_leakage'),
              'Water pipeline leaking near the temple', null, 72.85, 19.05) ->> 'id')::uuid;
  c_waste := (public.submit_complaint((select id from public.complaint_categories where organization_id = v_a and code = 'garbage_overflow'),
              'Garbage not lifted near the market', null, 72.86, 19.06) ->> 'id')::uuid;
  reset role;

  perform pg_temp.login('a0000000-0000-0000-0000-000000000002');            -- water officer
  set local role authenticated;
  if not exists (select 1 from public.complaints where id = c_water) then raise exception 'FAIL water officer cannot see a water complaint'; end if;
  if exists (select 1 from public.complaints where id = c_waste) then raise exception 'FAIL water officer sees a waste complaint'; end if;
  perform pg_temp.must_fail('water officer assigns a waste complaint',
    format('select public.complaint_action(%L, ''assign'', null, ''a0000000-0000-0000-0000-000000000003'')', c_waste));
  -- a task on the water complaint for the field worker
  t := public.task_create('Inspect the leaking pipeline', 'Check the joint near the temple', 'inspection', 'high',
                          'a0000000-0000-0000-0000-000000000003', null, null, null, c_water);
  v_task := (t ->> 'id')::uuid;
  if (t ->> 'reference') not like 'TSK-%' then raise exception 'FAIL task reference: %', t; end if;
  reset role;

  perform pg_temp.login('a0000000-0000-0000-0000-000000000003');            -- field worker
  set local role authenticated;
  r := public.work_list('mine');
  if jsonb_array_length(r -> 'tasks') <> 1 or (r #>> '{tasks,0,id}')::uuid <> v_task then raise exception 'FAIL field worker task list: %', r; end if;
  perform public.task_action(v_task, 'start');
  perform pg_temp.must_fail('field worker cancels a task', format('select public.task_action(%L, ''cancel'')', v_task));
  perform public.submit_inspection(v_task, null, 'major', 'Joint cracked, steady leak', 'Clamp fitted', true,
                                   v_a::text || '/a0000000-0000-0000-0000-000000000003/p.jpg', 19.05, 72.85, true);
  if (select status from public.work_tasks where id = v_task) <> 'done' then raise exception 'FAIL report with complete did not close the task'; end if;
  perform pg_temp.must_fail('field worker files a report on a task that is not theirs',
    format('select public.submit_inspection(null, %L, ''good'', ''x'')', c_waste));
  reset role;

  perform pg_temp.login('a0000000-0000-0000-0000-000000000004');            -- citizen: no tasks or reports
  set local role authenticated;
  select count(*) into n from public.work_tasks;
  if n <> 0 then raise exception 'FAIL citizen sees tasks'; end if;
  select count(*) into n from public.inspection_reports;
  if n <> 0 then raise exception 'FAIL citizen sees inspection reports'; end if;
  reset role;

  -- an administrator assigns a recommendation: it becomes the field worker's task, and completing it closes the task
  perform pg_temp.login('a0000000-0000-0000-0000-000000000001');
  set local role authenticated;
  select id into v_rec from public.recommendations where module = 'water' limit 1;
  perform public.recommendation_decide(v_rec, 'assign', null, 'a0000000-0000-0000-0000-000000000003');
  if not exists (select 1 from public.work_tasks where recommendation_id = v_rec and assignee_id = 'a0000000-0000-0000-0000-000000000003'
                  and status = 'open' and department_id = v_water) then
    raise exception 'FAIL assigning a recommendation did not create the task';
  end if;
  perform public.recommendation_decide(v_rec, 'complete');
  if (select status from public.work_tasks where recommendation_id = v_rec) <> 'done' then raise exception 'FAIL completed recommendation left its task open'; end if;

  -- invitations: only the administrator invites; the invited person joins with the role and department chosen
  r := public.invitation_create('New.Worker@a.test', 'field_worker', v_water);
  reset role;
  perform pg_temp.login('a0000000-0000-0000-0000-000000000002');
  set local role authenticated;
  perform pg_temp.must_fail('officer invites someone', 'select public.invitation_create(''x@a.test'', ''field_worker'')');
  reset role;
  insert into auth.users (id, email) values ('a0000000-0000-0000-0000-0000000000a1', 'new.worker@a.test'),
                                            ('a0000000-0000-0000-0000-0000000000a2', 'stranger@x.test');
  perform pg_temp.login('a0000000-0000-0000-0000-0000000000a2');
  set local role authenticated;
  perform pg_temp.must_fail('stranger accepts without an invitation', 'select public.accept_invitation(''Stranger'')');
  reset role;
  perform pg_temp.login('a0000000-0000-0000-0000-0000000000a1');
  set local role authenticated;
  perform public.accept_invitation('New Worker');
  reset role;
  if not exists (select 1 from public.users where id = 'a0000000-0000-0000-0000-0000000000a1' and organization_id = v_a
                  and role = 'field_worker' and department_id = v_water) then
    raise exception 'FAIL accepted invitation did not create the member';
  end if;
  if (select raw_app_meta_data ->> 'role' from auth.users where id = 'a0000000-0000-0000-0000-0000000000a1') <> 'field_worker' then
    raise exception 'FAIL the new member''s token claims were not set';
  end if;

  -- another municipality sees none of it
  perform pg_temp.login('b0000000-0000-0000-0000-000000000001');
  set local role authenticated;
  select count(*) into n from public.work_tasks;
  if n <> 0 then raise exception 'FAIL tenant B sees A''s tasks'; end if;
  perform pg_temp.must_fail('tenant B starts A''s task', format('select public.task_action(%L, ''reopen'')', v_task));
  reset role;

  -- leave the seat count as section 6 expects
  delete from public.users where id = 'a0000000-0000-0000-0000-0000000000a1';
  update public.users set department_id = null where id = 'a0000000-0000-0000-0000-000000000002';
  raise notice 'ok   field work: department scoping, tasks, inspection reports, recommendation tasks, invitations, tenancy';
end $$;

-- ---- 6. plan limit (free = 5 staff; citizens do not use a seat) ---------------------
do $$
begin
  insert into auth.users (id, email) values
    ('a0000000-0000-0000-0000-000000000005', 'u5@a.test'),
    ('a0000000-0000-0000-0000-000000000006', 'u6@a.test'),
    ('a0000000-0000-0000-0000-000000000007', 'u7@a.test'),
    ('a0000000-0000-0000-0000-000000000008', 'u8@a.test');
  -- A has 3 staff (admin, officer, field worker) and 1 citizen
  insert into public.users (id, organization_id, role, full_name, email) values
    ('a0000000-0000-0000-0000-000000000005', (select id from t_org where tenant = 'A'), 'dept_officer', 'U5', 'u5@a.test'),
    ('a0000000-0000-0000-0000-000000000006', (select id from t_org where tenant = 'A'), 'field_worker', 'U6', 'u6@a.test'),
    ('a0000000-0000-0000-0000-000000000007', (select id from t_org where tenant = 'A'), 'citizen', 'U7', 'u7@a.test');
  begin
    insert into public.users (id, organization_id, role, full_name, email)
      values ('a0000000-0000-0000-0000-000000000008', (select id from t_org where tenant = 'A'), 'dept_officer', 'U8', 'u8@a.test');
    raise exception 'FAIL sixth staff user allowed on free plan';
  exception when sqlstate 'P0001' then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'ok   plan limit: %', sqlerrm;
  end;
end $$;

-- ---- 7. every public table has RLS on --------------------------------------
do $$
declare v text;
begin
  select string_agg(table_name, ', ') into v from app.tables_without_rls;
  if v is not null then raise exception 'FAIL tables without RLS: %', v; end if;
  raise notice 'ok   every public table has RLS enabled';
end $$;

rollback;
\echo ALL RLS TESTS PASSED
