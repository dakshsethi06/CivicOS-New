-- CivicOS 0020: assistant tools for the operations modules and places, and charts in answers.
--
-- assistant_ops(module, ward)     water / waste / traffic: the current state, model outputs and a chart, as facts
-- assistant_nearby(lon, lat, r)   what is around a point (PostGIS): ward, open complaints, anomalies, risky pipes,
--                                 bins about to fill, congested roads, incidents
-- Each fact names its source, and says "demonstration data" when the operations data is the demo dataset.
-- All of it runs as the caller (security invoker), so Row Level Security decides what is visible.

alter table public.assistant_messages add column if not exists charts jsonb not null default '[]'::jsonb;

drop function if exists public.assistant_save(uuid, text, text, jsonb, bigint[], int, text, jsonb);
create or replace function public.assistant_save(
  p_conversation uuid, p_question text, p_answer text, p_citations jsonb, p_chunk_ids bigint[], p_fact_count int, p_mode text,
  p_tools jsonb default '[]'::jsonb, p_charts jsonb default '[]'::jsonb
) returns uuid
language plpgsql set search_path = public as $$
declare
  v_conv uuid := p_conversation;
begin
  if v_conv is null or not exists (select 1 from assistant_conversations where id = v_conv and user_id = auth.uid()) then
    insert into assistant_conversations (organization_id, user_id, title)
    values (app.org_id(), auth.uid(), left(p_question, 80)) returning id into v_conv;
  end if;
  insert into assistant_messages (organization_id, conversation_id, role, content) values (app.org_id(), v_conv, 'user', p_question);
  insert into assistant_messages (organization_id, conversation_id, role, content, citations, mode, charts)
  values (app.org_id(), v_conv, 'assistant', p_answer, coalesce(p_citations, '[]'::jsonb), p_mode, coalesce(p_charts, '[]'::jsonb));
  insert into retrieval_logs (organization_id, user_id, query, chunk_ids, fact_count, mode, tools)
  values (app.org_id(), auth.uid(), p_question, coalesce(p_chunk_ids, '{}'), coalesce(p_fact_count, 0), p_mode, coalesce(p_tools, '[]'::jsonb));
  return v_conv;
end $$;
revoke all on function public.assistant_save(uuid, text, text, jsonb, bigint[], int, text, jsonb, jsonb) from public, anon;
grant execute on function public.assistant_save(uuid, text, text, jsonb, bigint[], int, text, jsonb, jsonb) to authenticated;

create or replace function public.assistant_history(p_conversation uuid default null)
returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object(
    'conversations', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'title', title, 'created_at', created_at) order by created_at desc)
        from (select * from assistant_conversations where user_id = auth.uid() order by created_at desc limit 20) c), '[]'::jsonb),
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object('role', role, 'content', content, 'citations', citations, 'mode', mode, 'charts', charts,
                                          'at', created_at) order by id)
        from assistant_messages where conversation_id = p_conversation), '[]'::jsonb),
    'documents', (select count(*) from documents where status = 'ready'),
    'usage', jsonb_build_object('used', app.usage_this_month(app.org_id(), 'ai_query'),
                                'limit', app.plan_limit(app.org_id(), 'ai_queries_per_month')))
$$;

-- ------------------------------------------------------------------------------------------- operations facts
create or replace function public.assistant_ops(p_module text, p_ward text default null) returns jsonb
language plpgsql stable set search_path = public, extensions as $$
declare
  v_zone   uuid;
  v_scope  text := 'Mumbai';
  v_demo   boolean := coalesce((select kind = 'demo' from ops_datasets where organization_id = app.org_id()), false);
  v_src    text;
  v_last   timestamptz;
  f        text[] := '{}';
  v_chart  jsonb;
  r        record;
  v_txt    text;
begin
  if p_ward is not null and trim(p_ward) <> '' then
    select id, 'Ward ' || code into v_zone, v_scope from city_zones where upper(code) = upper(trim(p_ward)) and organization_id = app.org_id();
    if v_zone is null then
      return jsonb_build_object('facts', '[]'::jsonb, 'note', format('There is no ward %s in this city.', p_ward));
    end if;
  end if;

  if p_module = 'water' then
    v_src := 'CivicOS water network meters and models' || case when v_demo then ' (demonstration data)' else '' end;
    select max(ts) into v_last from water_readings;
    if v_last is null then return jsonb_build_object('facts', '[]'::jsonb, 'note', 'No water meter readings in this workspace.'); end if;

    select sum(r2.consumption_m3) filter (where r2.ts > v_last - interval '24 hours') as now24,
           sum(r2.consumption_m3) filter (where r2.ts > v_last - interval '192 hours' and r2.ts <= v_last - interval '168 hours') as wk
      into r from water_readings r2 join water_sensors s on s.id = r2.sensor_id
     where r2.ts > v_last - interval '8 days' and (v_zone is null or s.zone_id = v_zone);
    f := f || format('Water drawn in the 24 hours to %s, %s: %s m3%s', to_char(v_last at time zone 'Asia/Kolkata', 'DD Mon HH24:MI'), v_scope,
                     to_char(r.now24, 'FM999,999,999'),
                     case when r.wk > 0 then format(' (%s%% against the same day a week earlier)', to_char((r.now24 / r.wk - 1) * 100, 'FMSG990.0')) else '' end);

    if v_zone is null then
      select string_agg(format('%s %s%%', code, to_char(pct, 'FMSG990.0')), ', ' order by pct desc) into v_txt
        from (select z.code, (sum(r2.consumption_m3) filter (where r2.ts > v_last - interval '7 days')
                              / nullif(sum(r2.consumption_m3) filter (where r2.ts <= v_last - interval '7 days'), 0) - 1) * 100 as pct
                from water_readings r2 join water_sensors s on s.id = r2.sensor_id join city_zones z on z.id = s.zone_id
               where r2.ts > v_last - interval '14 days' group by z.code order by 2 desc nulls last limit 3) q;
      if v_txt is not null then f := f || ('Wards whose consumption rose most over the last 7 days against the 7 before: ' || v_txt); end if;
    end if;

    for r in select a.*, s.code as sensor, z.code as ward from water_anomalies a join water_sensors s on s.id = a.sensor_id
                     left join city_zones z on z.id = a.zone_id
              where a.status in ('open', 'inspecting') and (v_zone is null or a.zone_id = v_zone)
              order by (a.level = 'high') desc, a.peak_score desc limit 3 loop
      f := f || format('Open %s anomaly at meter %s (Ward %s), %s to %s: %s Consumption %s%% against its usual level, pressure change %s bar. Status: %s. An anomaly is a pattern to inspect, not proof of a leak.',
                       r.level, r.sensor, r.ward, to_char(r.started_at at time zone 'Asia/Kolkata', 'DD Mon HH24:MI'),
                       to_char(r.ended_at at time zone 'Asia/Kolkata', 'DD Mon HH24:MI'), r.pattern,
                       coalesce(r.evidence ->> 'consumption_vs_baseline_pct', '?'), coalesce(r.evidence ->> 'pressure_change_bar', '?'), r.status);
    end loop;
    select count(*) into r from water_anomalies where status in ('open', 'inspecting') and (v_zone is null or zone_id = v_zone);
    f := f || format('Open water anomalies, %s: %s', v_scope, r.count);

    select count(*) filter (where k.level = 'high') as hi, count(*) as n,
           string_agg(format('%s (%s, %s, %s%%)', p.code, p.material, p.installed_year, round((k.probability * 100)::numeric)), '; '
                      order by k.probability desc) filter (where k.level = 'high') as top
      into r from pipeline_risk k join water_pipelines p on p.id = k.pipeline_id where v_zone is null or p.zone_id = v_zone;
    if r.n > 0 then
      f := f || format('Pipes with at least a 50%% chance of failing in the next 12 months, %s: %s of %s (XGBoost pipe failure model)', v_scope, r.hi, r.n);
      if r.top is not null then f := f || ('Highest-risk pipes: ' || array_to_string((string_to_array(r.top, '; '))[1:3], '; ')); end if;
    end if;

    for r in select w.name, k.current_pct, k.min_pct, k.days_to_20pct, k.risk from reservoir_risk k join water_reservoirs w on w.id = k.reservoir_id
              where k.risk <> 'low' and (v_zone is null or w.zone_id = v_zone) order by k.min_pct limit 3 loop
      f := f || format('%s: level now %s%%, projected to fall to %s%% within 7 days (%s shortage risk)', r.name,
                       round(r.current_pct::numeric), round(r.min_pct::numeric), r.risk);
    end loop;

    select sum(predicted_m3) as v, sum(lower_m3) as lo, sum(upper_m3) as hi into r
      from (select * from water_predictions where granularity = 'day' and (v_zone is null or zone_id = v_zone)
             order by target_at) p
     where p.target_at < (select min(target_at) + interval '7 days' from water_predictions where granularity = 'day');
    if r.v is not null then
      f := f || format('Forecast water demand for the next 7 days, %s: %s m3 (range %s to %s; XGBoost demand model)', v_scope,
                       to_char(r.v, 'FM999,999,999'), to_char(r.lo, 'FM999,999,999'), to_char(r.hi, 'FM999,999,999'));
    end if;

    v_chart := jsonb_build_object('type', 'line', 'title', format('Water drawn per day, %s (m3): last 14 days and 7-day forecast', v_scope),
      'x', 'day', 'unit', 'm3',
      'series', jsonb_build_array(jsonb_build_object('key', 'observed', 'label', 'Observed'), jsonb_build_object('key', 'forecast', 'label', 'Forecast')),
      'data', coalesce((select jsonb_agg(x order by x ->> 'day') from (
                select jsonb_build_object('day', to_char(d, 'DD Mon'), 'observed', round(v::numeric)) as x
                  from (select (r2.ts at time zone 'Asia/Kolkata')::date d, sum(r2.consumption_m3) v
                          from water_readings r2 join water_sensors s on s.id = r2.sensor_id
                         where r2.ts > v_last - interval '15 days' and (v_zone is null or s.zone_id = v_zone)
                         group by 1) q
                 where d > (v_last at time zone 'Asia/Kolkata')::date - 15 and d < (v_last at time zone 'Asia/Kolkata')::date
                union all
                select jsonb_build_object('day', to_char(d, 'DD Mon'), 'forecast', round(v::numeric))
                  from (select (target_at at time zone 'Asia/Kolkata')::date d, sum(predicted_m3) v from water_predictions
                         where granularity = 'day' and (v_zone is null or zone_id = v_zone) group by 1 order by 1 limit 7) q) z), '[]'::jsonb));

  elsif p_module = 'waste' then
    v_src := 'CivicOS bin sensors and models' || case when v_demo then ' (demonstration data)' else '' end;
    select count(*) as n, count(*) filter (where p.fill_now >= 95) as full_now, count(*) filter (where p.p_overflow_6h >= 0.5) as o6,
           count(*) filter (where p.p_overflow_12h >= 0.5) as o12, count(*) filter (where p.p_overflow_24h >= 0.5) as o24, max(p.generated_at) as at
      into r from waste_predictions p join waste_bins b on b.id = p.bin_id where v_zone is null or b.zone_id = v_zone;
    if r.n = 0 then
      return jsonb_build_object('facts', '[]'::jsonb, 'note',
        case when exists (select 1 from waste_bins) then 'There are bins but no overflow predictions yet: the waste models have not been trained.'
             else 'No bin sensors in this workspace.' end);
    end if;
    f := f || format('Bins, %s, at %s: %s in total, %s full now; likely (chance 50%% or more) to reach 95%% within 6 hours: %s, within 12 hours: %s, within 24 hours: %s, if not collected (XGBoost overflow model)',
                     v_scope, to_char(r.at at time zone 'Asia/Kolkata', 'DD Mon HH24:MI'), r.n, r.full_now, r.o6, r.o12, r.o24);
    select string_agg(format('%s (Ward %s, %s%% full now, %s%% chance within 12 h)', b.code, z.code, round(p.fill_now::numeric),
                             round((p.p_overflow_12h * 100)::numeric)), '; ' order by p.p_overflow_12h desc, p.fill_now desc) into v_txt
      from (select * from waste_predictions order by p_overflow_12h desc, fill_now desc) p join waste_bins b on b.id = p.bin_id
      left join city_zones z on z.id = b.zone_id
     where (v_zone is null or b.zone_id = v_zone) and p.p_overflow_12h >= 0.5;
    if v_txt is not null then f := f || ('Bins most urgently needing collection: ' || array_to_string((string_to_array(v_txt, '; '))[1:5], '; ')); end if;

    select sum(distance_km) filter (where kind = 'optimised') as opt, sum(distance_km) filter (where kind = 'fixed') as fix,
           sum(bins_visited) filter (where kind = 'optimised') as ob, sum(bins_visited) filter (where kind = 'fixed') as fb, max(planned_for) as d
      into r from collection_plans where planned_for = (select max(planned_for) from collection_plans) and (v_zone is null or zone_id = v_zone);
    if r.opt is not null then
      f := f || format('Collection plan for %s, %s: optimised routes %s km visiting %s bins, against %s km and %s bins on the fixed schedule',
                       to_char(r.d, 'DD Mon'), v_scope, round(r.opt::numeric, 1), r.ob, round(r.fix::numeric, 1), r.fb);
    end if;
    select round(avg(prev) filter (where collected)::numeric, 1) as at_coll, round((avg((fill_pct >= 95)::int) * 100)::numeric, 2) as full_pct
      into r from (select w.collected, w.fill_pct, lag(w.fill_pct) over (partition by w.bin_id order by w.ts) prev
                     from waste_readings w join waste_bins b on b.id = w.bin_id where v_zone is null or b.zone_id = v_zone) q;
    f := f || format('Collection efficiency, %s: bins were on average %s%% full when emptied, and full %s%% of the time', v_scope, r.at_coll, r.full_pct);

    v_chart := jsonb_build_object('type', 'bar', 'title', format('Bins likely to fill within 24 hours, by ward%s', case when v_zone is null then '' else ' (' || v_scope || ')' end),
      'x', 'ward', 'unit', 'bins', 'series', jsonb_build_array(jsonb_build_object('key', 'bins', 'label', 'Bins')),
      'data', coalesce((select jsonb_agg(jsonb_build_object('ward', code, 'bins', n) order by n desc, code) from (
                select z.code, count(*) filter (where p.p_overflow_24h >= 0.5) n from waste_predictions p join waste_bins b on b.id = p.bin_id
                  join city_zones z on z.id = b.zone_id where v_zone is null or b.zone_id = v_zone group by z.code
                having count(*) filter (where p.p_overflow_24h >= 0.5) > 0 order by 2 desc limit 12) q), '[]'::jsonb));

  elsif p_module = 'traffic' then
    v_src := 'CivicOS traffic detectors and models' || case when v_demo then ' (demonstration data)' else '' end;
    select max(ts) into v_last from traffic_readings;
    if v_last is null then return jsonb_build_object('facts', '[]'::jsonb, 'note', 'No traffic readings in this workspace.'); end if;
    select count(*) as n, avg(1 - t.speed_kmh / d.speed_limit) as c, count(*) filter (where 1 - t.speed_kmh / d.speed_limit >= 0.4) as heavy
      into r from traffic_readings t join roads d on d.id = t.road_id where t.ts = v_last and (v_zone is null or d.zone_id = v_zone);
    f := f || format('Traffic at %s, %s: average congestion %s%% (how far speeds fall below the limit) on %s monitored roads; %s heavy or severe',
                     to_char(v_last at time zone 'Asia/Kolkata', 'DD Mon HH24:MI'), v_scope, round((coalesce(r.c, 0) * 100)::numeric), r.n, r.heavy);
    select string_agg(format('%s (%s of %s km/h)', d.name, round(t.speed_kmh::numeric), d.speed_limit), '; ' order by t.speed_kmh / d.speed_limit) into v_txt
      from traffic_readings t join roads d on d.id = t.road_id where t.ts = v_last and (v_zone is null or d.zone_id = v_zone);
    if v_txt is not null then f := f || ('Slowest roads now: ' || array_to_string((string_to_array(v_txt, '; '))[1:5], '; ')); end if;
    select count(*) filter (where congestion >= 0.4) as heavy, string_agg(format('%s %s%%', d.name, round((tp.congestion * 100)::numeric)), '; '
             order by tp.congestion desc) as top
      into r from traffic_predictions tp join roads d on d.id = tp.road_id where tp.horizon_min = 60 and (v_zone is null or d.zone_id = v_zone);
    f := f || format('Forecast in 60 minutes, %s: %s roads heavy or severe; most congested: %s (XGBoost congestion model)', v_scope, r.heavy,
                     coalesce(array_to_string((string_to_array(r.top, '; '))[1:3], '; '), 'none'));
    select string_agg(format('%s:00 (%s%%)', h, round((c * 100)::numeric)), ', ' order by c desc) into v_txt
      from (select extract(hour from t.ts at time zone 'Asia/Kolkata')::int h, avg(1 - t.speed_kmh / d.speed_limit) c
              from traffic_readings t join roads d on d.id = t.road_id
             where extract(isodow from t.ts at time zone 'Asia/Kolkata') < 6 and (v_zone is null or d.zone_id = v_zone)
             group by 1 order by 2 desc limit 3) q;
    if v_txt is not null then f := f || ('Weekday peak hours by average congestion, ' || v_scope || ': ' || v_txt); end if;
    select count(*) filter (where i.occurred_at > now() - interval '30 days') as m, count(*) as y into r
      from traffic_incidents i left join roads d on d.id = i.road_id where v_zone is null or d.zone_id = v_zone;
    select string_agg(format('%s (%s)', name, n), '; ' order by n desc) into v_txt
      from (select d.name, count(*) n from traffic_incidents i join roads d on d.id = i.road_id
             where i.occurred_at > now() - interval '365 days' and (v_zone is null or d.zone_id = v_zone)
             group by d.name order by 2 desc limit 3) q;
    f := f || format('Traffic incidents, %s: %s in the last 30 days, %s in the last 12 months; most incidents: %s', v_scope, r.m, r.y, coalesce(v_txt, 'none'));

    v_chart := jsonb_build_object('type', 'line', 'title', format('Average congestion by hour of day, %s (%%)', v_scope), 'x', 'hour', 'unit', '%',
      'series', jsonb_build_array(jsonb_build_object('key', 'weekday', 'label', 'Weekdays'), jsonb_build_object('key', 'weekend', 'label', 'Weekends')),
      'data', coalesce((select jsonb_agg(jsonb_build_object('hour', lpad(h::text, 2, '0') || ':00', 'weekday', round((wd * 100)::numeric, 1),
                                                           'weekend', round((we * 100)::numeric, 1)) order by h) from (
                select extract(hour from t.ts at time zone 'Asia/Kolkata')::int h,
                       avg(1 - t.speed_kmh / d.speed_limit) filter (where extract(isodow from t.ts at time zone 'Asia/Kolkata') < 6) wd,
                       avg(1 - t.speed_kmh / d.speed_limit) filter (where extract(isodow from t.ts at time zone 'Asia/Kolkata') >= 6) we
                  from traffic_readings t join roads d on d.id = t.road_id where v_zone is null or d.zone_id = v_zone group by 1) q), '[]'::jsonb));
  else
    raise exception 'Unknown module %', p_module using errcode = 'P0001';
  end if;

  return jsonb_build_object('scope', v_scope, 'is_demo', v_demo, 'source', v_src,
                            'facts', to_jsonb(f), 'chart', v_chart);
end $$;

-- ------------------------------------------------------------------------------------------- places (PostGIS)
create or replace function public.assistant_nearby(p_lon float8, p_lat float8, p_radius_m int default 500) returns jsonb
language plpgsql stable set search_path = public, extensions as $$
declare
  v_pt    geography := st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography;
  v_r     int := least(greatest(coalesce(p_radius_m, 500), 50), 5000);
  v_demo  boolean := coalesce((select kind = 'demo' from ops_datasets where organization_id = app.org_id()), false);
  v_ward  record;
  f       jsonb := '[]'::jsonb;
  r       record;
  v_ops   text := 'CivicOS operations data' || case when v_demo then ' (demonstration data)' else '' end;
begin
  select code, name into v_ward from city_zones where st_contains(boundary, st_setsrid(st_makepoint(p_lon, p_lat), 4326)) limit 1;
  f := f || jsonb_build_object('text', format('The point %s, %s is %s', round(p_lat::numeric, 5), round(p_lon::numeric, 5),
                                              coalesce(format('in Ward %s (%s)', v_ward.code, v_ward.name), 'outside the city''s wards')),
                               'source', 'Ward boundaries (DataMeet, Municipal Spatial Data)');

  select count(*) as n, string_agg(format('%s %s, %s m, %s', c.reference, coalesce(cc.name, 'uncategorised'), d, replace(c.status, '_', ' ')), '; ' order by d) as list
    into r from (select c.*, round(st_distance(st_setsrid(st_makepoint(c.lon, c.lat), 4326)::geography, v_pt))::int d from complaints c
                  where c.lat is not null and c.resolved_at is null
                    and st_dwithin(st_setsrid(st_makepoint(c.lon, c.lat), 4326)::geography, v_pt, v_r)) c
    left join complaint_categories cc on cc.id = c.category_id;
  f := f || jsonb_build_object('text', format('Open complaints within %s m: %s%s', v_r, r.n,
                                              case when r.n > 0 then ': ' || array_to_string((string_to_array(r.list, '; '))[1:5], '; ') else '' end),
                               'source', 'CivicOS complaints (live, as visible to you)');

  select count(*) as n, string_agg(format('meter %s, %s, %s m: %s', s.code, a.level, round(st_distance(s.geom::geography, v_pt)), a.pattern), '; ') as list
    into r from water_anomalies a join water_sensors s on s.id = a.sensor_id
   where a.status in ('open', 'inspecting') and st_dwithin(s.geom::geography, v_pt, v_r);
  if r.n > 0 or exists (select 1 from water_sensors) then
    f := f || jsonb_build_object('text', format('Open water anomalies within %s m: %s%s', v_r, r.n, case when r.n > 0 then ': ' || r.list else '' end), 'source', v_ops);
  end if;

  select count(*) as n, string_agg(format('%s (%s, %s, %s%% chance of failure in 12 months, %s m)', p.code, p.material, p.installed_year,
                                          round((k.probability * 100)::numeric), round(st_distance(p.geom::geography, v_pt))), '; ' order by k.probability desc) as list
    into r from pipeline_risk k join water_pipelines p on p.id = k.pipeline_id
   where k.probability >= 0.5 and st_dwithin(p.geom::geography, v_pt, v_r);
  if exists (select 1 from water_pipelines) then
    f := f || jsonb_build_object('text', format('Pipes at high failure risk within %s m: %s%s', v_r, r.n, case when r.n > 0 then ': ' || r.list else '' end), 'source', v_ops);
  end if;

  select count(*) as n, string_agg(format('%s (%s%% full, %s%% chance of filling within 24 h, %s m)', b.code, round(p.fill_now::numeric),
                                          round((p.p_overflow_24h * 100)::numeric), round(st_distance(b.geom::geography, v_pt))), '; ' order by p.p_overflow_24h desc) as list
    into r from waste_predictions p join waste_bins b on b.id = p.bin_id
   where p.p_overflow_24h >= 0.5 and st_dwithin(b.geom::geography, v_pt, v_r);
  if exists (select 1 from waste_bins) then
    f := f || jsonb_build_object('text', format('Bins likely to fill within 24 hours within %s m: %s%s', v_r, r.n, case when r.n > 0 then ': ' || r.list else '' end), 'source', v_ops);
  end if;

  select string_agg(format('%s %s%% congested', d.name, round(((1 - t.speed_kmh / d.speed_limit) * 100)::numeric)), '; ' order by t.speed_kmh / d.speed_limit) as list,
         count(*) as n
    into r from roads d join traffic_readings t on t.road_id = d.id and t.ts = (select max(ts) from traffic_readings)
   where st_dwithin(d.geom::geography, v_pt, v_r);
  if r.n > 0 then f := f || jsonb_build_object('text', format('Monitored roads within %s m now: %s', v_r, r.list), 'source', v_ops); end if;

  select count(*) as n into r from traffic_incidents i where i.occurred_at > now() - interval '90 days' and st_dwithin(i.geom::geography, v_pt, v_r);
  if exists (select 1 from roads) then
    f := f || jsonb_build_object('text', format('Traffic incidents within %s m in the last 90 days: %s', v_r, r.n), 'source', v_ops);
  end if;

  return jsonb_build_object('ward', v_ward.code, 'radius_m', v_r, 'facts', f);
end $$;

revoke all on function public.assistant_ops(text, text), public.assistant_nearby(float8, float8, int) from public, anon;
grant execute on function public.assistant_ops(text, text), public.assistant_nearby(float8, float8, int) to authenticated;
