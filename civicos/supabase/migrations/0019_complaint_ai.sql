-- CivicOS 0019: AI on complaints (apps/api/app/complaints).
--
-- After a complaint is submitted, the API adds to the rule-based suggestions of 0010:
--   * a category by meaning (Gemini embeddings compared with each category's description and examples),
--   * duplicates by meaning and distance (open complaints within 150 m whose text means the same),
--   * a photo check (Gemini vision: is there visible road damage, a pothole, how bad, does it match the text),
--   * an expected time to close from CivicOS's own resolved complaints once there are enough of them.
-- All of it stays a SUGGESTION: the officer still confirms category and priority when assigning.

alter table public.complaint_categories
  add column if not exists description text,          -- what belongs here, in words; the classifier compares with it
  add column if not exists examples    text[] not null default '{}';

-- default descriptions and examples for the standard categories (editable afterwards)
create or replace function app.category_defaults(p_code text, out description text, out examples text[])
language sql immutable as $$
  select v.d, v.e from (values
    ('road_damage', 'Damage to a road or footpath surface: potholes, cracks, broken paving, uneven or sunken road.',
     array['big pothole in the middle of the road', 'road surface broken and full of craters', 'footpath tiles broken, people tripping',
           'gaddha on the main road near the station', 'road has caved in after rain']),
    ('water_leakage', 'Problems with piped drinking water: leaks, bursts, no water, low pressure, dirty or contaminated water.',
     array['water pipeline burst and water flowing on the street', 'no water supply in our building since two days',
           'very low water pressure in the morning', 'dirty yellow water coming from the tap', 'paani nahi aa raha']),
    ('garbage_overflow', 'Garbage not collected, overflowing bins, dumping of waste or debris.',
     array['garbage bin overflowing and smelling', 'waste not lifted for three days', 'people dumping debris on the corner',
           'kachra not picked up', 'stray dogs spreading garbage from the dustbin']),
    ('drainage', 'Stormwater drains: choked or blocked drains, waterlogging and flooding of streets.',
     array['drain is choked and water is overflowing on the road', 'street floods every time it rains',
           'nala blocked with plastic', 'water logging outside the school']),
    ('streetlight', 'Street lighting: lamps not working, flickering, damaged poles, dark streets.',
     array['streetlight not working for a week', 'the whole lane is dark at night', 'light pole leaning and wires hanging',
           'lamp keeps flickering']),
    ('sewage', 'Sewers and manholes: sewage overflow, open or broken manholes, foul smell.',
     array['sewage overflowing from the manhole', 'open manhole without cover on the footpath', 'foul smell of gutter water in the lane',
           'sewer line blocked, dirty water entering homes']),
    ('public_infrastructure', 'Public facilities: parks, benches, public toilets, bus stops, walls, railings, playgrounds.',
     array['public toilet is broken and dirty', 'park bench broken and swings damaged', 'bus stop shelter roof fell',
           'railing on the bridge is broken']),
    ('other', 'Anything that does not fit another category.', array[]::text[])
  ) as v(code, d, e)
  where v.code = p_code
$$;

create or replace function app.complaint_category_defaults() returns trigger
language plpgsql as $$
declare d record;
begin
  if new.description is null then
    select * into d from app.category_defaults(new.code);
    new.description := d.description;
    if coalesce(array_length(new.examples, 1), 0) = 0 then new.examples := coalesce(d.examples, '{}'); end if;
  end if;
  return new;
end $$;
create trigger complaint_categories_defaults before insert on public.complaint_categories
  for each row execute function app.complaint_category_defaults();

update public.complaint_categories c
   set (description, examples) = (select d.description, coalesce(d.examples, '{}') from app.category_defaults(c.code) d)
 where c.description is null and (select d.description from app.category_defaults(c.code) d) is not null;

alter table public.complaints
  add column if not exists ai_category_id   uuid references public.complaint_categories(id) on delete set null,
  add column if not exists ai_similarity    real,      -- cosine similarity to the best category
  add column if not exists ai_scores        jsonb,     -- {category code: similarity}
  add column if not exists ai_duplicates    jsonb,     -- [{id, reference, distance_m, similarity}]
  add column if not exists image_analysis   jsonb,     -- Gemini vision result for the photo
  add column if not exists ai_model         text,
  add column if not exists ai_analysed_at   timestamptz;

create table public.complaint_embeddings (
  complaint_id    uuid primary key references public.complaints(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  model           text not null,
  embedding       vector(768) not null,
  created_at      timestamptz not null default now()
);
create index complaint_embeddings_org_idx on public.complaint_embeddings (organization_id);
grant select, insert, update, delete on public.complaint_embeddings to authenticated;
grant all on public.complaint_embeddings to service_role;
select app.apply_tenant_policies('public.complaint_embeddings', '{city_admin,dept_officer}', '{city_admin}');

-- Open complaints near a point whose text means the same, for duplicate detection. Distance on the local plane
-- (good to a few metres at city scale); similarity is cosine on the stored embeddings. Runs under RLS.
create or replace function public.complaint_similar(p_id uuid, p_embedding vector(768), p_radius_m int default 150, p_limit int default 5)
returns table (id uuid, reference text, status text, category text, distance_m int, similarity real)
language sql stable set search_path = public, extensions as $$
  select o.id, o.reference, o.status, cc.name,
         round(111320 * sqrt(power(o.lat - me.lat, 2) + power((o.lon - me.lon) * cos(radians(me.lat)), 2)))::int,
         (1 - (e.embedding <=> p_embedding))::real
    from complaints me
    join complaints o on o.organization_id = me.organization_id and o.id <> me.id
    join complaint_embeddings e on e.complaint_id = o.id
    left join complaint_categories cc on cc.id = o.category_id
   where me.id = p_id and me.lat is not null and o.lat is not null
     and o.resolved_at is null and o.created_at <= me.created_at
     and 111320 * sqrt(power(o.lat - me.lat, 2) + power((o.lon - me.lon) * cos(radians(me.lat)), 2)) <= p_radius_m
   order by e.embedding <=> p_embedding
   limit p_limit
$$;

-- Applies the API's analysis to one complaint. Only suggestions change: category_id is filled only when the
-- submitter left it empty and nothing matched by keywords; priority is raised one step only for clear, severe
-- road damage in the photo; the duplicate link only when none was set. Every change is written to the history.
create or replace function public.complaint_ai_apply(
  p_id uuid, p_model text, p_category uuid, p_similarity real, p_scores jsonb, p_duplicates jsonb, p_image jsonb
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  c        complaints;
  c_levels constant text[] := array['low', 'medium', 'high', 'critical'];
  v_notes  text[] := '{}';
  v_cat    complaint_categories;
  v_dup    jsonb;
  v_days   record;
begin
  if app.role() not in ('city_admin', 'dept_officer') then
    raise exception 'Only the analysis service or an officer can record an analysis' using errcode = 'P0001';
  end if;
  select * into c from complaints where id = p_id and organization_id = app.org_id() for update;
  if not found then raise exception 'Complaint not found' using errcode = 'P0001'; end if;

  -- category by meaning
  if p_category is not null then
    select * into v_cat from complaint_categories where id = p_category and organization_id = c.organization_id;
    v_notes := v_notes || format('Closest category by meaning: %s (similarity %s)', v_cat.name, round(p_similarity::numeric, 2));
    if c.suggested_category_id is null then
      c.suggested_category_id := p_category;
      if c.category_id is null then
        c.category_id := p_category;
        c.department_id := coalesce(c.department_id, v_cat.department_id);
      end if;
    elsif c.suggested_category_id <> p_category then
      v_notes := v_notes || 'differs from the keyword suggestion; the officer decides';
    end if;
  end if;

  -- duplicates by meaning within 150 m: linked only when the text means the same (similarity 0.915 or more, measured
  -- on Gemini embeddings) and the category matches, since one place can have several different problems
  v_dup := (select d from jsonb_array_elements(coalesce(p_duplicates, '[]')) d
             where (d ->> 'similarity')::real >= 0.915 and coalesce((d ->> 'same_category')::boolean, false)
             order by (d ->> 'similarity')::real desc limit 1);
  if v_dup is not null and c.duplicate_of is null then
    c.duplicate_of := (v_dup ->> 'id')::uuid;
    v_notes := v_notes || format('possible duplicate of %s: %s m away, same meaning (similarity %s)',
                                 v_dup ->> 'reference', v_dup ->> 'distance_m', round((v_dup ->> 'similarity')::numeric, 2));
  end if;

  -- photo
  if p_image is not null and coalesce(p_image ->> 'error', '') = '' then
    v_notes := v_notes || format('Photo: %s', coalesce(p_image ->> 'summary', 'analysed'));
    if (p_image ->> 'road_damage')::boolean and p_image ->> 'severity' = 'high' and not c.severity_confirmed
       and array_position(c_levels, c.suggested_severity) < 4 then
      c.suggested_severity := c_levels[array_position(c_levels, c.suggested_severity) + 1];
      c.severity := c.suggested_severity;
      v_notes := v_notes || format('priority raised to %s: the photo shows severe road damage', c.suggested_severity);
    end if;
    if (p_image ->> 'matches_description') = 'false' then
      v_notes := v_notes || 'the photo may not show the problem described';
    end if;
  end if;

  -- time to close from CivicOS's own history, once there are at least 10 resolved complaints of this category
  select percentile_cont(0.5) within group (order by extract(epoch from (o.resolved_at - o.created_at)) / 86400) as days, count(*) as n
    into v_days
    from complaints o
   where o.organization_id = c.organization_id and o.category_id = c.category_id and o.resolved_at is not null;
  if v_days.n >= 10 then
    c.expected_days := round(v_days.days::numeric, 1);
    c.expected_days_basis := format('Median of %s resolved CivicOS complaints in this category', v_days.n);
  end if;

  update complaints set
    suggested_category_id = c.suggested_category_id, category_id = c.category_id, department_id = c.department_id,
    duplicate_of = c.duplicate_of, suggested_severity = c.suggested_severity, severity = c.severity,
    expected_days = c.expected_days, expected_days_basis = c.expected_days_basis,
    ai_category_id = p_category, ai_similarity = p_similarity, ai_scores = p_scores, ai_duplicates = p_duplicates,
    image_analysis = p_image, ai_model = p_model, ai_analysed_at = now(),
    suggestion_reason = coalesce(c.suggestion_reason, '') ||
                        case when array_length(v_notes, 1) > 0 then ' AI: ' || array_to_string(v_notes, '; ') || '.' else '' end
   where id = p_id;

  if array_length(v_notes, 1) > 0 then
    insert into complaint_history (organization_id, complaint_id, from_status, to_status, actor_id, note)
    values (c.organization_id, c.id, c.status, c.status, null, 'AI analysis: ' || array_to_string(v_notes, '; ') || '.');
  end if;
  return jsonb_build_object('notes', to_jsonb(v_notes));
end $$;

-- complaint_detail gains the AI fields through to_jsonb(c); this adds the readable category name
create or replace function public.complaint_ai_view(p_id uuid) returns jsonb
language sql stable set search_path = public, extensions as $$
  select jsonb_build_object('ai_category', cc.name, 'ai_similarity', c.ai_similarity, 'ai_scores', c.ai_scores,
                            'ai_duplicates', c.ai_duplicates, 'image_analysis', c.image_analysis, 'ai_model', c.ai_model,
                            'ai_analysed_at', c.ai_analysed_at)
    from complaints c left join complaint_categories cc on cc.id = c.ai_category_id
   where c.id = p_id
$$;

revoke all on function public.complaint_similar(uuid, vector(768), int, int), public.complaint_ai_apply(uuid, text, uuid, real, jsonb, jsonb, jsonb),
  public.complaint_ai_view(uuid) from public, anon;
grant execute on function public.complaint_similar(uuid, vector(768), int, int), public.complaint_ai_apply(uuid, text, uuid, real, jsonb, jsonb, jsonb),
  public.complaint_ai_view(uuid) to authenticated;
