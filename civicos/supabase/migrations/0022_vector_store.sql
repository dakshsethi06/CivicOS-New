-- CivicOS 0022: a separate vector database (Qdrant) for document search, and a small wording fix.
--
-- With VECTOR_STORE=qdrant the API finds the nearest chunks in Qdrant, then reads them here, AS THE SIGNED-IN USER:
-- Row Level Security drops any chunk the caller may not see (another municipality's, or a staff-only document for a
-- resident), whatever the vector database returned. Postgres remains the system of record for chunks and vectors.

create or replace function public.document_chunks_by_ids(p_ids bigint[], p_query text default null) returns jsonb
language plpgsql stable set search_path = public, extensions as $$
declare
  v_terms text[] := tsvector_to_array(to_tsvector('english', coalesce(p_query, '')));
  v_or    tsquery;
begin
  if coalesce(array_length(v_terms, 1), 0) > 0 then
    v_or := to_tsquery('english', (select string_agg(quote_literal(t), ' | ') from unnest(v_terms) t));
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'chunk_id', c.id, 'document_id', d.id, 'title', d.title, 'category', d.category, 'source', d.source,
             'version', d.version, 'department', dep.name, 'uploaded_at', d.created_at, 'access_level', d.access_level,
             'page', c.page_number, 'section', c.section, 'content', c.content,
             'excerpt', case when v_or is not null and c.tsv @@ v_or
                             then ts_headline('english', c.content, v_or, 'MaxWords=45, MinWords=20, StartSel=«, StopSel=», MaxFragments=1')
                             else left(c.content, 320) end)
           order by array_position(p_ids, c.id))
      from document_chunks c
      join documents d on d.id = c.document_id and d.status = 'ready'
      left join departments dep on dep.id = d.department_id
     where c.id = any (p_ids)), '[]'::jsonb);
end $$;
revoke all on function public.document_chunks_by_ids(bigint[], text) from public, anon;
grant execute on function public.document_chunks_by_ids(bigint[], text) to authenticated;

-- "in Ward K/W" rather than "in Ward K/W (Ward K/W)" when the ward's name is its code
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
                                              coalesce(case when v_ward.name is null or v_ward.name ilike '%' || v_ward.code || '%' then format('in Ward %s', v_ward.code)
                                                   else format('in Ward %s (%s)', v_ward.code, v_ward.name) end,
                                              'outside the city''s wards')),
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
