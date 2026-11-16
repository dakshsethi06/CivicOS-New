-- CivicOS 0013: recommendations.
-- Each recommendation comes from a fixed, stated rule applied to published figures, model forecasts or
-- live CivicOS complaints. It shows its evidence and sources. Officers accept, reject, assign or complete
-- it, and every decision is kept. No probability is shown because the rules are not statistical models.

create table public.recommendations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  key             text not null,                          -- rule + ward: regenerating updates the same row
  rule            text not null,
  module          text not null,                          -- complaints, water, waste, environment
  zone_id         uuid references public.city_zones(id) on delete cascade,
  problem         text not null,
  evidence        jsonb not null,                         -- [{label, value, source}]
  prediction      text,
  action          text not null,
  priority        text not null check (priority in ('low', 'medium', 'high')),
  basis           text not null,                          -- the rule in words, shown instead of a confidence figure
  status          text not null default 'open' check (status in ('open', 'accepted', 'rejected', 'assigned', 'completed')),
  assignee_id     uuid references public.users(id) on delete set null,
  generated_at    timestamptz not null default now(),
  unique (organization_id, key)
);
create index recommendations_org_idx on public.recommendations (organization_id, status);

create table public.recommendation_decisions (
  id                bigint generated always as identity primary key,
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  recommendation_id uuid not null references public.recommendations(id) on delete cascade,
  decision          text not null,
  actor_id          uuid,
  note              text,
  created_at        timestamptz not null default now()
);

create or replace function app.generate_recommendations(p_org uuid) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_n int := 0;
  v_y int;
begin
  create temp table if not exists _rec (
    key text, rule text, module text, zone_id uuid, problem text, evidence jsonb, prediction text,
    action text, priority text, basis text) on commit drop;
  truncate _rec;

  -- helper view of one value per ward for a metric/year, with its source text
  -- (written inline in each rule to keep every threshold visible)

  -- R1: wards that take much longer than the city to close complaints
  select max(year) into v_y from civic_indicators where organization_id = p_org and metric = 'avg_days_to_close' and zone_id is not null and category is null;
  insert into _rec
  select 'slow_closure:' || z.code, 'slow_closure', 'complaints', z.id,
         format('Ward %s takes %s days on average to close a complaint, against %s for the city (%s).', z.code, w.value, c.value, v_y),
         jsonb_build_array(
           jsonb_build_object('label', format('Ward %s average days to close, %s', z.code, v_y), 'value', w.value, 'source', format('%s, %s, p. %s', s.publisher, s.table_ref, s.page)),
           jsonb_build_object('label', format('City average days to close, %s', v_y), 'value', c.value, 'source', format('%s, %s, p. %s', s.publisher, s.table_ref, s.page))),
         null,
         format('Review how complaints are routed and escalated in Ward %s, starting with the issues that take longest.', z.code),
         case when w.value >= 2 * c.value then 'high' else 'medium' end,
         'Rule: ward average is at least 1.5 times the city average (high priority at 2 times).'
    from civic_indicators w
    join city_zones z on z.id = w.zone_id
    join civic_indicators c on c.organization_id = p_org and c.metric = 'avg_days_to_close' and c.zone_id is null and c.category is null and c.year = v_y
    left join data_sources s on s.organization_id = p_org and s.id = w.source_id
   where w.organization_id = p_org and w.metric = 'avg_days_to_close' and w.category is null and w.year = v_y
     and w.value >= 1.5 * c.value;

  -- R2: wards with very short water supply
  select max(year) into v_y from civic_indicators where organization_id = p_org and metric = 'water_supply_hours' and zone_id is not null;
  insert into _rec
  select 'short_water:' || z.code, 'short_water', 'water', z.id,
         format('Ward %s receives water for %s hours a day on average, against %s for the city (%s).', z.code, w.value, c.value, v_y),
         jsonb_build_array(
           jsonb_build_object('label', format('Ward %s supply hours per day, %s', z.code, v_y), 'value', w.value, 'source', format('%s, %s, p. %s', s.publisher, s.table_ref, s.page)),
           jsonb_build_object('label', format('City average supply hours per day, %s', v_y), 'value', c.value, 'source', format('%s, %s, p. %s', s.publisher, s.table_ref, s.page))),
         null,
         format('Examine supply timings and zone-level distribution in Ward %s; prioritise zones receiving two hours or less.', z.code),
         case when w.value < 2 then 'high' else 'medium' end,
         'Rule: ward average is under 3 hours a day (high priority under 2 hours).'
    from civic_indicators w
    join city_zones z on z.id = w.zone_id
    join civic_indicators c on c.organization_id = p_org and c.metric = 'water_supply_hours' and c.zone_id is null and c.year = v_y
    left join data_sources s on s.organization_id = p_org and s.id = w.source_id
   where w.organization_id = p_org and w.metric = 'water_supply_hours' and w.year = v_y and w.value < 3;

  -- R3: wards where many drinking-water samples fail
  select max(year) into v_y from civic_indicators where organization_id = p_org and metric = 'water_unfit_samples_pct' and zone_id is not null;
  insert into _rec
  select 'unfit_water:' || z.code, 'unfit_water', 'water', z.id,
         format('%s%% of drinking-water samples in Ward %s were found unfit in %s, against %s%% for the city.', w.value, z.code, v_y, c.value),
         jsonb_build_array(
           jsonb_build_object('label', format('Ward %s unfit samples, %s', z.code, v_y), 'value', w.value || '%', 'source', format('%s, %s, p. %s', s.publisher, s.table_ref, s.page)),
           jsonb_build_object('label', format('City unfit samples, %s', v_y), 'value', c.value || '%', 'source', format('%s, %s, p. %s', s.publisher, s.table_ref, s.page))),
         null,
         format('Increase sampling in Ward %s and inspect for contamination sources such as leaking or cross-connected lines.', z.code),
         case when w.value >= 2 then 'high' else 'medium' end,
         'Rule: at least 1% of samples unfit (high priority at 2%).'
    from civic_indicators w
    join city_zones z on z.id = w.zone_id
    join civic_indicators c on c.organization_id = p_org and c.metric = 'water_unfit_samples_pct' and c.zone_id is null and c.year = v_y
    left join data_sources s on s.organization_id = p_org and s.id = w.source_id
   where w.organization_id = p_org and w.metric = 'water_unfit_samples_pct' and w.year = v_y and w.value >= 1;

  -- R4: wards where the forecast points to a clear rise in complaints
  insert into _rec
  select 'forecast_rise:' || z.code, 'forecast_rise', 'complaints', z.id,
         format('Complaints in Ward %s are forecast to rise from %s in %s to about %s in %s.', z.code,
                to_char(l.value, 'FM99,99,990'), f.year - 1, to_char(f.value, 'FM99,99,990'), f.year),
         jsonb_build_array(
           jsonb_build_object('label', format('Ward %s complaints registered, %s', z.code, f.year - 1), 'value', l.value, 'source', format('%s, %s, p. %s', s.publisher, s.table_ref, s.page)),
           jsonb_build_object('label', format('Forecast for %s', f.year), 'value', f.value, 'source', 'CivicOS complaint forecast model')),
         format('Forecast %s: %s (80%% range %s to %s).', f.year, to_char(f.value, 'FM99,99,990'), to_char(f.lower, 'FM99,99,990'), to_char(f.upper, 'FM99,99,990')),
         format('Plan complaint-handling capacity in Ward %s for a higher load next year.', z.code),
         case when f.lower > l.value then 'high' else 'medium' end,
         'Rule: forecast is at least 10% above the last published year (high priority when even the low end of the range is above it).'
    from ml_forecasts f
    join city_zones z on z.id = f.zone_id
    join civic_indicators l on l.zone_id = f.zone_id and l.metric = 'complaints_registered' and l.category is null and l.year = f.year - 1
    left join data_sources s on s.organization_id = p_org and s.id = l.source_id
   where f.organization_id = p_org and f.metric = 'complaints_registered' and f.category is null and f.value >= 1.10 * l.value;

  -- R5: wards where almost no bulk waste generator processes waste on site
  insert into _rec
  select 'bwg:' || z.code, 'bwg', 'waste', z.id,
         format('%s%% of the %s bulk waste generator societies in Ward %s do not process waste on site (%s).', w.value, n.value, z.code, w.year),
         jsonb_build_array(
           jsonb_build_object('label', format('Ward %s societies not processing on site, %s', z.code, w.year), 'value', w.value || '%', 'source', format('%s, %s, p. %s', s.publisher, s.table_ref, s.page)),
           jsonb_build_object('label', 'Bulk waste generator societies in the ward', 'value', n.value, 'source', format('%s, %s, p. %s', s.publisher, s.table_ref, s.page))),
         null,
         format('Follow up with bulk waste generators in Ward %s on on-site wet-waste processing.', z.code),
         'medium',
         'Rule: at least 95% of societies not processing on site, in wards with 50 or more such societies.'
    from civic_indicators w
    join city_zones z on z.id = w.zone_id
    join civic_indicators n on n.zone_id = w.zone_id and n.metric = 'bwg_societies' and n.year = w.year
    left join data_sources s on s.organization_id = p_org and s.id = w.source_id
   where w.organization_id = p_org and w.metric = 'bwg_not_processing_on_site_pct' and w.value >= 95 and n.value >= 50;

  -- R6: live CivicOS complaints open longer than the typical time to close
  insert into _rec
  select 'overdue:' || coalesce(z.code, 'none'), 'overdue', 'complaints', z.id,
         format('%s complaint%s submitted through CivicOS in %s %s been open longer than the typical time to close.',
                count(*), case when count(*) = 1 then '' else 's' end, coalesce('Ward ' || z.code, 'an unspecified ward'),
                case when count(*) = 1 then 'has' else 'have' end),
         jsonb_build_array(
           jsonb_build_object('label', 'Overdue complaints', 'value', string_agg(c.reference, ', ' order by c.created_at), 'source', 'CivicOS complaints'),
           jsonb_build_object('label', 'Oldest', 'value', to_char(min(c.created_at), 'DD Mon YYYY'), 'source', 'CivicOS complaints')),
         null,
         'Review and reassign or escalate these complaints.',
         'high',
         'Rule: an open complaint is older than the published average days to close for its ward and issue.'
    from complaints c
    left join city_zones z on z.id = c.zone_id
   where c.organization_id = p_org and c.resolved_at is null and c.expected_days is not null
     and c.created_at < now() - make_interval(days => ceil(c.expected_days)::int)
   group by z.id, z.code;

  -- R7: months of next year when air quality is forecast to be poor for the city (AQI above 100)
  insert into _rec
  select 'aqi_season:' || f.year, 'aqi_season', 'environment', null,
         format('Average AQI is forecast above 100 in %s of %s, peaking at about %s in %s.',
                string_agg(to_char(make_date(f.year, f.month, 1), 'FMMon'), ', ' order by f.month), f.year,
                max(f.value)::int, (array_agg(to_char(make_date(f.year, f.month, 1), 'FMMonth') order by f.value desc))[1]),
         jsonb_build_array(
           jsonb_build_object('label', format('Months above AQI 100 in %s', f.year - 1),
                              'value', (select count(*) from civic_indicators a where a.organization_id = p_org and a.metric = 'aqi_monthly_avg'
                                          and a.zone_id is null and a.year = f.year - 1 and a.value > 100),
                              'source', (select format('%s, %s, p. %s', publisher, table_ref, page) from data_sources where organization_id = p_org and id = 'p26-t29')),
           jsonb_build_object('label', format('Forecast peak, %s', f.year), 'value', max(f.value), 'source', 'CivicOS air-quality forecast model')),
         format('Forecast %s, months above 100: %s.', f.year,
                string_agg(format('%s %s (80%% range %s to %s)', to_char(make_date(f.year, f.month, 1), 'FMMon'), f.value::int, f.lower::int, f.upper::int), ', ' order by f.month)),
         'Schedule dust control at construction sites, road sweeping and waste-burning checks for these months, and issue public advisories before they start.',
         case when max(f.lower) > 100 then 'high' else 'medium' end,
         'Rule: the monthly AQI forecast is above 100, the upper limit of the "Satisfactory" band (high priority when even the low end of the range is above it).'
    from ml_forecasts f
   where f.organization_id = p_org and f.metric = 'aqi_monthly_avg' and f.value > 100
   group by f.year;

  insert into recommendations (organization_id, key, rule, module, zone_id, problem, evidence, prediction, action, priority, basis)
  select p_org, key, rule, module, zone_id, problem, evidence, prediction, action, priority, basis from _rec
  on conflict (organization_id, key) do update
     set problem = excluded.problem, evidence = excluded.evidence, prediction = excluded.prediction,
         action = excluded.action, priority = excluded.priority, basis = excluded.basis, generated_at = now();
  get diagnostics v_n = row_count;

  -- a rule that no longer fires closes its untouched recommendation
  delete from recommendations r
   where r.organization_id = p_org and r.status = 'open' and not exists (select 1 from _rec t where t.key = r.key);
  return v_n;
end $$;
revoke all on function app.generate_recommendations(uuid) from public, anon, authenticated;

create or replace function public.refresh_recommendations() returns int
language plpgsql security definer set search_path = public, extensions as $$
begin
  if app.role() not in ('city_admin', 'dept_officer') then
    raise exception 'Only officers can refresh recommendations' using errcode = 'P0001';
  end if;
  return app.generate_recommendations(app.org_id());
end $$;

create or replace function public.recommendation_decide(p_id uuid, p_decision text, p_note text default null, p_assignee uuid default null)
returns text
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_org uuid := app.org_id();
  v_status text;
begin
  if app.role() not in ('city_admin', 'dept_officer') then
    raise exception 'Only officers can decide on recommendations' using errcode = 'P0001';
  end if;
  if p_decision not in ('accept', 'reject', 'assign', 'complete', 'reopen') then
    raise exception 'Unknown decision %', p_decision using errcode = 'P0001';
  end if;
  if p_decision = 'assign' and not exists (
       select 1 from users u where u.id = p_assignee and u.organization_id = v_org and u.role in ('city_admin', 'dept_officer', 'field_worker')) then
    raise exception 'Choose a staff member of this organization' using errcode = 'P0001';
  end if;
  v_status := case p_decision when 'accept' then 'accepted' when 'reject' then 'rejected' when 'assign' then 'assigned'
                              when 'complete' then 'completed' else 'open' end;
  update recommendations
     set status = v_status, assignee_id = case when p_decision = 'assign' then p_assignee when p_decision = 'reopen' then null else assignee_id end
   where id = p_id and organization_id = v_org;
  if not found then raise exception 'Recommendation not found' using errcode = 'P0001'; end if;
  insert into recommendation_decisions (organization_id, recommendation_id, decision, actor_id, note)
  values (v_org, p_id, p_decision, auth.uid(), nullif(trim(coalesce(p_note, '')), ''));
  return v_status;
end $$;

create or replace function public.recommendation_list() returns jsonb
language sql stable set search_path = public, extensions as $$
  select jsonb_build_object(
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', r.id, 'rule', r.rule, 'module', r.module, 'ward', z.code, 'problem', r.problem, 'evidence', r.evidence,
               'prediction', r.prediction, 'action', r.action, 'priority', r.priority, 'basis', r.basis, 'status', r.status,
               'assignee', u.full_name, 'generated_at', r.generated_at,
               'decisions', coalesce((
                 select jsonb_agg(jsonb_build_object('decision', d.decision, 'note', d.note, 'at', d.created_at, 'actor', coalesce(a.full_name, 'Staff')) order by d.id)
                   from recommendation_decisions d left join users a on a.id = d.actor_id
                  where d.recommendation_id = r.id), '[]'::jsonb))
             order by case r.priority when 'high' then 1 when 'medium' then 2 else 3 end, r.module, z.code)
        from recommendations r
        left join city_zones z on z.id = r.zone_id
        left join users u on u.id = r.assignee_id), '[]'::jsonb),
    'staff', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', full_name) order by full_name)
                         from users where role in ('city_admin', 'dept_officer', 'field_worker') and is_active), '[]'::jsonb))
$$;

grant select on public.recommendations, public.recommendation_decisions to authenticated;
grant all on public.recommendations, public.recommendation_decisions to service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;
revoke all on public.recommendations, public.recommendation_decisions from anon;
select app.apply_tenant_policies('public.recommendations', '{city_admin,dept_officer}', '{}');
select app.apply_tenant_policies('public.recommendation_decisions', '{city_admin,dept_officer}', '{}');

revoke all on function public.refresh_recommendations() from public, anon;
revoke all on function public.recommendation_decide(uuid, text, text, uuid) from public, anon;
revoke all on function public.recommendation_list() from public, anon;
grant execute on function public.refresh_recommendations() to authenticated;
grant execute on function public.recommendation_decide(uuid, text, text, uuid) to authenticated;
grant execute on function public.recommendation_list() to authenticated;
