-- CivicOS 0023: forecasts for more published indicators.
--
-- New in the model results (0009, retrained by data/mumbai/ml/train.py):
--   * average days to close a complaint and the share of complaints closed, per ward and city, 2026-2028
--     (from the three published years 2023-2025: tested one year ahead on 2025 only, so the ranges are wide);
--   * water lost between the lakes and supply, MLD and % of water drawn, city, 2025-2028 (from 2020-2024).
-- forecast_more() serves them to the pages; assistant_facts (as in 0016) now answers questions about them.
-- Figures published for a single year (water supply hours, waste per person, bulk generators, air-quality days)
-- have no trend to forecast and are not forecast.

create or replace function public.forecast_more(p_zone uuid default null) returns jsonb
language sql stable set search_path = public, extensions as $$
  with yrs as (select distinct year from civic_indicators where metric = 'avg_days_to_close' and month is null and category is null)
  select jsonb_build_object(
    'zone', p_zone,
    'closure', jsonb_build_object(
      'model', (select jsonb_build_object('method', method, 'description', description, 'params', params, 'trained_on', trained_on)
                  from ml_models where id = 'closure-forecast'),
      'days', jsonb_build_object(
        'history', coalesce((select jsonb_agg(jsonb_build_object('year', year, 'value', value) order by year)
                               from (select distinct on (year) year, value from civic_indicators
                                      where metric = 'avg_days_to_close' and zone_id is not distinct from p_zone and category is null and month is null
                                      order by year) h), '[]'::jsonb),
        'forecasts', coalesce((select jsonb_agg(jsonb_build_object('year', year, 'value', value, 'lower', lower, 'upper', upper, 'method', method) order by year)
                                 from ml_forecasts where metric = 'avg_days_to_close' and zone_id is not distinct from p_zone), '[]'::jsonb)),
      'pct', jsonb_build_object(
        'history', coalesce((select jsonb_agg(jsonb_build_object('year', y.year, 'value', round(100 * c.value / r.value, 1)) order by y.year)
                               from yrs y
                               cross join lateral (select value from civic_indicators where metric = 'complaints_closed' and year = y.year
                                                     and zone_id is not distinct from p_zone and category is null and month is null limit 1) c
                               cross join lateral (select value from civic_indicators where metric = 'complaints_registered' and year = y.year
                                                     and zone_id is not distinct from p_zone and category is null and month is null limit 1) r
                              where r.value > 0), '[]'::jsonb),
        'forecasts', coalesce((select jsonb_agg(jsonb_build_object('year', year, 'value', value, 'lower', lower, 'upper', upper, 'method', method) order by year)
                                 from ml_forecasts where metric = 'complaints_closed_pct' and zone_id is not distinct from p_zone), '[]'::jsonb)),
      'wards', coalesce((select jsonb_agg(jsonb_build_object(
                           'code', z.code, 'name', z.name,
                           'days', (select jsonb_agg(jsonb_build_object('year', f.year, 'value', f.value, 'lower', f.lower, 'upper', f.upper) order by f.year)
                                      from ml_forecasts f where f.zone_id = z.id and f.metric = 'avg_days_to_close'),
                           'pct', (select jsonb_agg(jsonb_build_object('year', f.year, 'value', f.value, 'lower', f.lower, 'upper', f.upper) order by f.year)
                                     from ml_forecasts f where f.zone_id = z.id and f.metric = 'complaints_closed_pct'),
                           'days_last', (select value from civic_indicators ci where ci.zone_id = z.id and ci.metric = 'avg_days_to_close'
                                            and ci.category is null and ci.month is null order by year desc limit 1)) order by z.code)
                          from city_zones z
                         where exists (select 1 from ml_forecasts f where f.zone_id = z.id and f.metric = 'avg_days_to_close')), '[]'::jsonb)),
    'water_loss', jsonb_build_object(
      'history', coalesce((select jsonb_agg(jsonb_build_object('year', year, 'metric', metric, 'value', value) order by year, metric)
                             from civic_indicators where metric in ('water_loss_fy', 'water_loss_fy_pct') and zone_id is null and month is null), '[]'::jsonb),
      'forecasts', coalesce((select jsonb_agg(jsonb_build_object('year', year, 'metric', metric, 'value', value, 'lower', lower, 'upper', upper, 'method', method) order by year, metric)
                               from ml_forecasts where metric in ('water_loss_fy', 'water_loss_fy_pct') and zone_id is null), '[]'::jsonb)))
$$;
revoke all on function public.forecast_more(uuid) from public, anon;
grant execute on function public.forecast_more(uuid) to authenticated;

-- assistant_facts as in 0016, with forecasts for days to close, share closed and water lost
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
    ('avg_days_to_close', null, 'Average days to close a complaint', 'days', '(days|slow|fast|time|resolution|resolve|delay)', true, 'avg_days_to_close'),
    ('complaints_closed_pct', null, 'Share of complaints closed', '%', '(closed|closure|resolved|unresolved|pending|resolution rate)', true, 'complaints_closed_pct'),
    ('complaints_registered', 'Solid Waste Management (SWM)', 'Solid-waste complaints registered', '', '(waste|garbage|swm)', true, 'complaints_registered'),
    ('complaints_registered', 'Drainage', 'Drainage complaints registered', '', '(drain|flood|waterlog)', true, 'complaints_registered'),
    ('waste_tonnes_per_day', null, 'Waste lifted', 'tonnes/day', '(waste|garbage|tonn|swm)', true, 'waste_tonnes_per_day'),
    ('waste_per_capita', null, 'Waste per person', 'kg/day', '(waste|garbage|per person|per capita)', false, null),
    ('water_supply_hours', null, 'Water supply', 'hours/day', '(water|supply)', false, null),
    ('water_unfit_samples_pct', null, 'Drinking-water samples found unfit', '%', '(water|unfit|contamin|drinking)', true, 'water_unfit_samples_pct'),
    ('water_supply_mld', null, 'Water supplied to the city', 'MLD', '(water|supply|demand|shortfall|shortage)', true, 'water_supply_fy'),
    ('water_demand_mld', null, 'Water demand', 'MLD', '(water|demand|shortfall|shortage)', false, null),
    ('water_gap_mld', null, 'Water supply shortfall', 'MLD', '(water|shortfall|shortage|gap|deficit)', false, null),
    ('water_loss_fy', null, 'Water lost between the lakes and supply', 'MLD', '(loss|lost|leak|non.revenue|nrw|wastage|en.?route)', true, 'water_loss_fy'),
    ('water_loss_fy_pct', null, 'Share of water drawn that is lost before supply', '%', '(loss|lost|leak|non.revenue|nrw|wastage|en.?route)', true, 'water_loss_fy_pct'),
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
                when f.metric in ('avg_days_to_close', 'complaints_closed_pct') then 'CivicOS complaint closure forecast model (3 published years: rough)'
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

-- load the retrained results into every workspace that holds the Mumbai data
select app.load_mumbai_models(o.id), app.generate_recommendations(o.id)
  from public.organizations o
 where exists (select 1 from public.cities c where c.organization_id = o.id and c.name = 'Mumbai');
