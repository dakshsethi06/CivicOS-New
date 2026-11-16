-- CivicOS 0016: forecasts for the next three years.
-- The models (0009, regenerated) now forecast complaints, waste and monthly air quality for 2026, 2027 and 2028,
-- and water (unfit drinking-water samples; water drawn and supplied) for each year from 2025 to 2028, since the
-- latest published water figures are for 2024. These read functions return every forecast year, nearest first.
-- Safe to run again: everything here is "create or replace", and the last statement reloads the models.

-- ---------------------------------------------------------------------------
-- Analytics: model cards, ward groups, and every forecast year for one complaint series.
-- 'forecast' (the nearest year) is kept for older callers.
-- ---------------------------------------------------------------------------
create or replace function public.ml_data(p_zone uuid default null, p_issue text default null)
returns jsonb
language sql stable set search_path = public, extensions as $$
  with fc as (
    select f.* from ml_forecasts f
     where f.metric = 'complaints_registered' and f.zone_id is not distinct from p_zone and f.category is not distinct from p_issue
  )
  select jsonb_build_object(
    'models', coalesce((select jsonb_object_agg(kind, to_jsonb(m) - 'organization_id') from ml_models m
                          where m.id in ('ward-groups-2025', 'complaints-forecast-2026')), '{}'::jsonb),
    'wards', coalesce((
      select jsonb_agg(jsonb_build_object('code', z.code, 'name', z.name, 'cluster', c.cluster,
                                          'features', c.features, 'z', c.z) order by c.cluster, z.code)
        from ml_ward_clusters c join city_zones z on z.id = c.zone_id), '[]'::jsonb),
    'zone', (select jsonb_build_object('id', id, 'code', code, 'name', name) from city_zones where id = p_zone),
    'issue', p_issue,
    'history', coalesce((
      select jsonb_agg(jsonb_build_object('year', year, 'value', value) order by year)
        from civic_indicators
       where metric = 'complaints_registered' and zone_id is not distinct from p_zone
         and category is not distinct from p_issue), '[]'::jsonb),
    'forecast', (select to_jsonb(f) - 'organization_id' - 'id' - 'zone_id' from fc f order by f.year limit 1),
    'forecasts', coalesce((select jsonb_agg(to_jsonb(f) - 'organization_id' - 'id' - 'zone_id' order by f.year) from fc f), '[]'::jsonb),
    'ward_forecasts', coalesce((
      select jsonb_agg(jsonb_build_object(
               'code', z.code, 'name', z.name, 'last', l.value, 'last_year', l.year,
               'years', (select jsonb_agg(jsonb_build_object('year', f.year, 'value', f.value, 'lower', f.lower, 'upper', f.upper) order by f.year)
                           from ml_forecasts f
                          where f.zone_id = z.id and f.metric = 'complaints_registered' and f.category is not distinct from p_issue))
             order by z.code)
        from city_zones z
        left join lateral (select ci.value, ci.year from civic_indicators ci
                            where ci.zone_id = z.id and ci.metric = 'complaints_registered' and ci.category is not distinct from p_issue
                              and ci.month is null order by ci.year desc limit 1) l on true
       where exists (select 1 from ml_forecasts f
                      where f.zone_id = z.id and f.metric = 'complaints_registered' and f.category is not distinct from p_issue)), '[]'::jsonb),
    'issues_with_forecasts', coalesce((
      select jsonb_agg(distinct category order by category) from ml_forecasts where metric = 'complaints_registered' and category is not null and zone_id is null), '[]'::jsonb),
    'ward_issues', coalesce((
      select jsonb_agg(distinct category order by category) from ml_forecasts where metric = 'complaints_registered' and category is not null and zone_id is not null), '[]'::jsonb)
  )
$$;

-- ---------------------------------------------------------------------------
-- Air-quality, waste and water forecasts for the Analytics and Water pages. p_zone narrows the waste and
-- unfit-water series to one ward; air quality and the water balance are city-wide only.
-- waste.forecast (the nearest year) is kept for older callers.
-- ---------------------------------------------------------------------------
create or replace function public.forecast_extras(p_zone uuid default null)
returns jsonb
language sql stable set search_path = public, extensions as $$
  select jsonb_build_object(
    'zone', (select jsonb_build_object('id', id, 'code', code, 'name', name) from city_zones where id = p_zone),
    'aqi', jsonb_build_object(
      'model', (select to_jsonb(m) - 'organization_id' from ml_models m where m.id = 'aqi-forecast-2026'),
      'history', coalesce((
        select jsonb_agg(jsonb_build_object('year', year, 'month', month, 'value', value) order by year, month)
          from civic_indicators where metric = 'aqi_monthly_avg' and zone_id is null and month is not null), '[]'::jsonb),
      'forecast', coalesce((
        select jsonb_agg(jsonb_build_object('year', year, 'month', month, 'value', value, 'lower', lower, 'upper', upper, 'method', method) order by year, month)
          from ml_forecasts where metric = 'aqi_monthly_avg'), '[]'::jsonb),
      'source', (select jsonb_build_object('publisher', s.publisher, 'table', s.table_ref, 'page', s.page)
                   from civic_indicators ci join data_sources s on s.organization_id = ci.organization_id and s.id = ci.source_id
                  where ci.metric = 'aqi_monthly_avg' limit 1)),
    'waste', jsonb_build_object(
      'model', (select to_jsonb(m) - 'organization_id' from ml_models m where m.id = 'waste-forecast-2026'),
      'history', coalesce((
        select jsonb_agg(jsonb_build_object('year', year, 'value', value) order by year)
          from civic_indicators where metric = 'waste_tonnes_per_day' and zone_id is not distinct from p_zone
           and category is null and month is null), '[]'::jsonb),
      'forecast', (
        select jsonb_build_object('year', year, 'value', value, 'lower', lower, 'upper', upper, 'method', method, 'family', family, 'category', null)
          from ml_forecasts where metric = 'waste_tonnes_per_day' and zone_id is not distinct from p_zone order by year limit 1),
      'forecasts', coalesce((
        select jsonb_agg(jsonb_build_object('year', year, 'value', value, 'lower', lower, 'upper', upper, 'method', method, 'family', family, 'category', null) order by year)
          from ml_forecasts where metric = 'waste_tonnes_per_day' and zone_id is not distinct from p_zone), '[]'::jsonb),
      'ward_forecasts', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'code', z.code, 'name', z.name, 'last', l.value, 'last_year', l.year,
                 'years', (select jsonb_agg(jsonb_build_object('year', f.year, 'value', f.value, 'lower', f.lower, 'upper', f.upper) order by f.year)
                             from ml_forecasts f where f.zone_id = z.id and f.metric = 'waste_tonnes_per_day'))
               order by z.code)
          from city_zones z
          left join lateral (select ci.value, ci.year from civic_indicators ci
                              where ci.zone_id = z.id and ci.metric = 'waste_tonnes_per_day' and ci.category is null and ci.month is null
                              order by ci.year desc limit 1) l on true
         where exists (select 1 from ml_forecasts f where f.zone_id = z.id and f.metric = 'waste_tonnes_per_day')), '[]'::jsonb),
      'source', (select jsonb_build_object('publisher', s.publisher, 'table', s.table_ref, 'page', s.page)
                   from civic_indicators ci join data_sources s on s.organization_id = ci.organization_id and s.id = ci.source_id
                  where ci.metric = 'waste_tonnes_per_day' and ci.zone_id is not null limit 1)),
    'water', jsonb_build_object(
      'model', (select to_jsonb(m) - 'organization_id' from ml_models m where m.id = 'water-forecast'),
      'unfit', jsonb_build_object(
        'history', coalesce((
          select jsonb_agg(jsonb_build_object('year', year, 'value', value) order by year)
            from civic_indicators where metric = 'water_unfit_samples_pct' and zone_id is not distinct from p_zone and month is null), '[]'::jsonb),
        'forecasts', coalesce((
          select jsonb_agg(jsonb_build_object('year', year, 'value', value, 'lower', lower, 'upper', upper, 'method', method) order by year)
            from ml_forecasts where metric = 'water_unfit_samples_pct' and zone_id is not distinct from p_zone), '[]'::jsonb),
        'wards', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'code', z.code, 'name', z.name, 'last', l.value, 'last_year', l.year,
                   'years', (select jsonb_agg(jsonb_build_object('year', f.year, 'value', f.value, 'lower', f.lower, 'upper', f.upper) order by f.year)
                               from ml_forecasts f where f.zone_id = z.id and f.metric = 'water_unfit_samples_pct'))
                 order by z.code)
            from city_zones z
            left join lateral (select ci.value, ci.year from civic_indicators ci
                                where ci.zone_id = z.id and ci.metric = 'water_unfit_samples_pct' and ci.month is null
                                order by ci.year desc limit 1) l on true
           where exists (select 1 from ml_forecasts f where f.zone_id = z.id and f.metric = 'water_unfit_samples_pct')), '[]'::jsonb)),
      'balance', jsonb_build_object(
        'history', coalesce((
          select jsonb_agg(jsonb_build_object('year', year, 'metric', metric, 'value', value) order by year, metric)
            from civic_indicators where metric in ('water_yield_fy', 'water_supply_fy') and zone_id is null and month is null), '[]'::jsonb),
        'forecasts', coalesce((
          select jsonb_agg(jsonb_build_object('year', year, 'metric', metric, 'value', value, 'lower', lower, 'upper', upper, 'method', method) order by year, metric)
            from ml_forecasts where metric in ('water_yield_fy', 'water_supply_fy') and zone_id is null), '[]'::jsonb)))
  )
$$;

-- ---------------------------------------------------------------------------
-- Assistant facts (as in 0012), with forecasts for 2026-2028 and water.
-- A forecast question gets the year it names; otherwise the next year (the first forecast year of the
-- complaint model); a question about several years ("next three years", "coming years") gets them all.
-- ---------------------------------------------------------------------------
create or replace function public.assistant_facts(p_question text)
returns jsonb
language plpgsql stable set search_path = public as $$
declare
  q        text := lower(coalesce(p_question, ''));
  v_wards  uuid[];
  v_year   int := (select (regexp_match(q, '\m(20[0-3][0-9])\M'))[1]::int);
  v_future boolean := q ~ '(forecast|predict|projection|next year|next \w+ years|coming years|future|expect|will|202[6-9])';
  v_span   boolean := q ~ '(next (two|three|four|few|2|3|4) years|coming years|years ahead|over the next|three years|3 years)';
  v_next   int := (select min(year) from ml_forecasts where metric = 'complaints_registered');
  v_out    jsonb;
begin
  -- wards named as "ward K/W", "K/W ward" or "wards A and B"
  select array_agg(z.id) into v_wards
    from city_zones z
   where q ~ ('(\mward[s]?\s+([a-z/]+\s*(,|and|&)\s*)*' || lower(replace(z.code, '/', '\/')) || '\M)|(\m' || lower(replace(z.code, '/', '\/')) || '\s+ward\M)');

  with topics(metric, category, label, unit, pattern, forecastable, fmetric) as (values
    ('complaints_registered', null, 'Complaints registered', '', '(complaint|grievance|issue)', true, 'complaints_registered'),
    ('complaints_closed', null, 'Complaints closed', '', '(closed|closure|resolved|unresolved|pending)', false, null),
    ('avg_days_to_close', null, 'Average days to close a complaint', 'days', '(days|slow|fast|time|resolution|resolve|delay)', false, null),
    ('complaints_registered', 'Solid Waste Management (SWM)', 'Solid-waste complaints registered', '', '(waste|garbage|swm)', true, 'complaints_registered'),
    ('complaints_registered', 'Drainage', 'Drainage complaints registered', '', '(drain|flood|waterlog)', true, 'complaints_registered'),
    ('waste_tonnes_per_day', null, 'Waste lifted', 'tonnes/day', '(waste|garbage|tonn|swm)', true, 'waste_tonnes_per_day'),
    ('waste_per_capita', null, 'Waste per person', 'kg/day', '(waste|garbage|per person|per capita)', false, null),
    ('water_supply_hours', null, 'Water supply', 'hours/day', '(water|supply)', false, null),
    ('water_unfit_samples_pct', null, 'Drinking-water samples found unfit', '%', '(water|unfit|contamin|drinking)', true, 'water_unfit_samples_pct'),
    ('water_supply_mld', null, 'Water supplied to the city', 'MLD', '(water|supply|demand|shortfall|shortage)', true, 'water_supply_fy'),
    ('water_demand_mld', null, 'Water demand', 'MLD', '(water|demand|shortfall|shortage)', false, null),
    ('water_gap_mld', null, 'Water supply shortfall', 'MLD', '(water|shortfall|shortage|gap|deficit)', false, null),
    ('bwg_not_processing_on_site_pct', null, 'Bulk waste generators not processing on site', '%', '(bulk|societ|compost|processing)', false, null)
  ),
  wanted as (select * from topics t where q ~ t.pattern),
  yr as (       -- the asked year if published for the metric, else the latest
    select w.metric, w.category,
           coalesce((select max(year) from civic_indicators ci where ci.metric = w.metric and ci.category is not distinct from w.category and ci.year = v_year),
                    (select max(year) from civic_indicators ci where ci.metric = w.metric and ci.category is not distinct from w.category)) as y
      from wanted w
  ),
  base as (
    select ci.value, ci.year, ci.zone_id, z.code, w.label, w.unit, w.metric, w.category, s.publisher, s.table_ref, s.page,
           rank() over (partition by w.metric, w.category order by ci.value desc) as hi,
           rank() over (partition by w.metric, w.category order by ci.value asc)  as lo
      from wanted w
      join yr on yr.metric = w.metric and yr.category is not distinct from w.category
      join civic_indicators ci on ci.metric = w.metric and ci.category is not distinct from w.category and ci.year = yr.y and ci.month is null
      left join city_zones z on z.id = ci.zone_id
      left join data_sources s on s.organization_id = ci.organization_id and s.id = ci.source_id
  ),
  picked as (
    select *, 1 as ord from base where zone_id is null                                         -- city figure
    union all
    select *, 2 from base where zone_id = any (coalesce(v_wards, '{}'))                        -- wards that were named
    union all
    select *, 3 from base where zone_id is not null and v_wards is null and (hi <= 3 or lo <= 3)  -- extremes when no ward is named
  ),
  facts as (
    select distinct on (metric, category, zone_id)
           format('%s, %s, %s: %s%s', label, coalesce('Ward ' || code, 'Mumbai'), year,
                  rtrim(to_char(value, 'FM99,99,99,990.99'), '.'), case when unit = '' then '' else ' ' || unit end) as text,
           format('%s, %s, p. %s', publisher, table_ref, page) as source, ord, metric, category, value, zone_id
      from picked
  ),
  fyears as (   -- which forecast years to show, per forecast metric
    select distinct w.fmetric,
           case when v_span and v_year is null then null       -- null = every year
                else coalesce((select max(x.year) from ml_forecasts x where x.metric = w.fmetric and x.year = v_year),
                              greatest(v_next, (select min(x.year) from ml_forecasts x where x.metric = w.fmetric))) end as y
      from wanted w where w.forecastable
  ),
  forecasts as (
    select format('Forecast of %s, %s, %s: %s%s (80%% range %s to %s). A model estimate, not a published figure.',
                  lower(w.label), coalesce('Ward ' || z.code, 'Mumbai'), f.year,
                  rtrim(to_char(f.value, 'FM99,99,99,990.99'), '.'), case when w.unit = '' then '' else ' ' || w.unit end,
                  rtrim(to_char(f.lower, 'FM99,99,99,990.99'), '.'), rtrim(to_char(f.upper, 'FM99,99,99,990.99'), '.')) as text,
           case when f.metric = 'waste_tonnes_per_day' then 'CivicOS waste forecast model'
                when f.metric like 'water%' then 'CivicOS water forecast model'
                else 'CivicOS complaint forecast model' end as source, 4 as ord, f.year as k
      from wanted w
      join fyears fy on fy.fmetric = w.fmetric
      join ml_forecasts f on f.metric = w.fmetric and f.category is not distinct from w.category and f.month is null
      left join city_zones z on z.id = f.zone_id
     where w.forecastable and v_future
       and (fy.y is null or f.year = fy.y)
       and (f.zone_id is null or f.zone_id = any (coalesce(v_wards, '{}')))
  ),
  air as (       -- monthly air-quality forecast, asked about air and the future
    select format('Forecast average AQI, Mumbai, %s %s: %s (80%% range %s to %s). A model estimate, not a published figure.',
                  to_char(make_date(f.year, f.month, 1), 'FMMonth'), f.year, f.value::int, f.lower::int, f.upper::int) as text,
           'CivicOS air-quality forecast model' as source, 4 as ord, f.year * 100 + f.month as k
      from ml_forecasts f
     where f.metric = 'aqi_monthly_avg' and q ~ '(air|aqi|pollut|smog)' and v_future
       and (    (v_span and v_year is null)
             or f.year = coalesce((select max(x.year) from ml_forecasts x where x.metric = 'aqi_monthly_avg' and x.year = v_year), v_next))
  ),
  health as (
    select format('City Health Index (prototype), %s, %s: %s out of 100', coalesce('Ward ' || z.code, 'Mumbai'),
                  extract(year from h.snapshot_date)::int, h.score) as text,
           'CivicOS prototype index computed from published figures' as source, 5 as ord
      from health_index_snapshots h left join city_zones z on z.id = h.zone_id
     where q ~ '(health|index|score|overall)' and (h.zone_id is null or h.zone_id = any (coalesce(v_wards, '{}')))
  ),
  allf as (
    select text, source, ord, 0 as k from facts
    union all select text, source, ord, k from forecasts
    union all select text, source, ord, k from air
    union all select text, source, ord, 0 from health
  )
  select coalesce(jsonb_agg(jsonb_build_object('text', text, 'source', source) order by ord, k, text), '[]'::jsonb) into v_out
    from (select * from allf order by ord, k, text limit 24) t;
  return v_out;
end $$;

-- ---------------------------------------------------------------------------
-- Recommendations (as in 0013). Only change: R7 (poor air-quality months) looks at the next forecast year,
-- not every forecast year, so it raises one recommendation rather than three near-identical ones.
-- ---------------------------------------------------------------------------
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
     and f.year = (select min(x.year) from ml_forecasts x where x.organization_id = p_org and x.metric = 'aqi_monthly_avg')
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

-- ---------------------------------------------------------------------------
-- Reload the models (and the recommendations built on them) for workspaces that already hold the Mumbai data.
-- On a new project there are none yet, so this does nothing.
-- ---------------------------------------------------------------------------
select app.load_mumbai_models(o.id), app.generate_recommendations(o.id)
  from public.organizations o
 where exists (select 1 from public.cities c where c.organization_id = o.id and c.name = 'Mumbai');
