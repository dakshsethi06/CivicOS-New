-- CivicOS 0010: complaints submitted through CivicOS.
-- Flow: Submitted -> Classified -> Assigned -> In progress -> Resolved -> Verified.
-- On submission the system only SUGGESTS: a category (keyword rules), a priority (rules), a possible
-- duplicate, and an expected time to close taken from the published BMC averages. An officer
-- confirms or changes them when assigning. Nothing consequential happens without a person.

create extension if not exists pg_trgm with schema extensions;

alter table public.complaint_categories
  add column published_issue text,                          -- matching issue name in the published complaint statistics
  add column keywords        text[] not null default '{}',
  add column base_severity   text   not null default 'medium' check (base_severity in ('low', 'medium', 'high', 'critical'));

alter table public.complaints
  add column suggested_category_id uuid references public.complaint_categories(id) on delete set null,
  add column suggested_severity    text check (suggested_severity in ('low', 'medium', 'high', 'critical')),
  add column suggestion_reason     text,
  add column severity_confirmed    boolean not null default false,
  add column expected_days         numeric,
  add column expected_days_basis   text,
  add column duplicate_of          uuid references public.complaints(id) on delete set null,
  add column photo_path            text,
  add column assignee_id           uuid references public.users(id) on delete set null,
  add column verified_at           timestamptz;
create index complaints_assignee_idx on public.complaints (assignee_id);
create unique index complaints_reference_idx on public.complaints (organization_id, reference);

create sequence public.complaint_ref_seq;

create table public.complaint_history (
  id              bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  complaint_id    uuid not null references public.complaints(id) on delete cascade,
  from_status     text,
  to_status       text not null,
  actor_id        uuid,                                     -- null = the system
  note            text,
  created_at      timestamptz not null default now()
);
create index complaint_history_complaint_idx on public.complaint_history (complaint_id, created_at);

-- ---------------------------------------------------------------------------
-- Categories for a tenant. Keywords and base priority are editable settings.
-- ---------------------------------------------------------------------------
create or replace function app.seed_complaint_categories(p_org uuid) returns void
language sql security definer set search_path = public, extensions as $$
  insert into complaint_categories (organization_id, code, name, department_id, published_issue, base_severity, keywords)
  select p_org, v.code, v.name, d.id, v.issue, v.sev, v.kw
    from (values
      ('road_damage',           'Road damage',             'ROADS', 'Roads',                         'medium', array['pothole','road','crater','footpath','asphalt','speed breaker','paver']),
      ('water_leakage',         'Water leakage',           'WATER', 'Water Supply',                  'high',   array['leak','pipeline','burst','water line','water supply','no water','low pressure','contaminated','dirty water','tap']),
      ('garbage_overflow',      'Garbage overflow',        'WASTE', 'Solid Waste Management (SWM)',  'medium', array['garbage','waste','bin','dustbin','trash','litter','dump','not lifted','debris']),
      ('drainage',              'Drainage',                'DRAIN', 'Drainage',                      'medium', array['drain','choked','water logging','waterlogging','flood','gutter','nala','nullah']),
      ('streetlight',           'Streetlight malfunction', 'ELEC',  null,                            'low',    array['streetlight','street light','lamp','light pole','dark at night','not working light']),
      ('sewage',                'Sewage',                  'DRAIN', 'Drainage',                      'high',   array['sewage','sewer','manhole','septic','foul smell']),
      ('public_infrastructure', 'Public infrastructure',   'ROADS', 'Buildings',                     'low',    array['park','bench','garden','toilet','bus stop','wall','playground','railing']),
      ('other',                 'Other',                   null,    null,                            'low',    array[]::text[])
    ) as v(code, name, dept, issue, sev, kw)
    left join departments d on d.organization_id = p_org and d.code = v.dept
  on conflict (organization_id, code) do nothing
$$;

create or replace function app.seed_city_defaults(p_org uuid, p_city text default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  insert into departments (organization_id, name, code) values
    (p_org, 'Water Supply',              'WATER'),
    (p_org, 'Solid Waste Management',    'WASTE'),
    (p_org, 'Roads & Public Works',      'ROADS'),
    (p_org, 'Traffic & Mobility',        'TRAFFIC'),
    (p_org, 'Electrical & Streetlights', 'ELEC'),
    (p_org, 'Drainage & Sewerage',       'DRAIN')
  on conflict (organization_id, code) do nothing;

  perform app.seed_complaint_categories(p_org);

  if p_city = 'mumbai' then
    perform app.load_mumbai_data(p_org);
  end if;
end $$;
revoke all on function app.seed_city_defaults(uuid, text) from public, anon, authenticated;
revoke all on function app.seed_complaint_categories(uuid) from public, anon, authenticated;

-- categories for organizations that already exist
select app.seed_complaint_categories(id) from public.organizations;

-- ---------------------------------------------------------------------------
-- Expected days to close, from the published averages. Most specific first:
-- this ward and issue, then the city for this issue, then this ward overall, then the city overall.
-- ---------------------------------------------------------------------------
create or replace function app.expected_days(p_org uuid, p_zone uuid, p_issue text, out days numeric, out basis text)
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  r record;
begin
  for r in
    select ci.value, ci.year, ci.zone_id, ci.category, z.name as zone_name, s.publisher, s.table_ref, s.page
      from civic_indicators ci
      left join city_zones z on z.id = ci.zone_id
      left join data_sources s on s.organization_id = ci.organization_id and s.id = ci.source_id
     where ci.organization_id = p_org and ci.metric = 'avg_days_to_close'
       and (ci.zone_id = p_zone or ci.zone_id is null)
       and (ci.category = p_issue or ci.category is null)
     order by (ci.zone_id is not null and ci.category is not null) desc,
              (ci.category is not null) desc, (ci.zone_id is not null) desc, ci.year desc
     limit 1
  loop
    days := r.value;
    basis := format('Average for %s in %s, %s (%s, %s, p. %s)',
      coalesce(r.category || ' complaints', 'all complaints'), coalesce(r.zone_name, 'the city'), r.year,
      r.publisher, r.table_ref, r.page);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- On submission: fix the fields a submitter may not set, then compute suggestions.
-- ---------------------------------------------------------------------------
create or replace function app.complaint_before_insert() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  c_levels constant text[] := array['low', 'medium', 'high', 'critical'];
  v_cat    complaint_categories;
  v_sugg   record;
  v_level  int;
  v_reason text[] := '{}';
  v_nearby int := 0;
  v_dup    record;
begin
  -- a submitter controls only: category, description, ward, location, photo
  new.status := 'submitted';
  new.reference := 'CMP-' || lpad(nextval('public.complaint_ref_seq')::text, 6, '0');
  new.created_at := now();
  new.assigned_at := null; new.resolved_at := null; new.verified_at := null;
  new.assignee_id := null; new.severity_confirmed := false; new.duplicate_of := null;
  new.description := trim(new.description);
  if length(new.description) < 10 then
    raise exception 'Please describe the problem in at least 10 characters' using errcode = 'P0001';
  end if;

  -- category suggestion: the category whose keywords appear most often in the description
  select c.id, c.name, h.hits into v_sugg
    from complaint_categories c
   cross join lateral (select count(*) as hits from unnest(c.keywords) k where lower(new.description) like '%' || k || '%') h
   where c.organization_id = new.organization_id
   order by h.hits desc, c.code limit 1;
  if v_sugg.hits > 0 then
    new.suggested_category_id := v_sugg.id;
    v_reason := v_reason || format('Wording matches "%s" (%s keyword%s)', v_sugg.name, v_sugg.hits, case when v_sugg.hits = 1 then '' else 's' end);
  end if;
  if new.category_id is null then new.category_id := new.suggested_category_id; end if;

  select * into v_cat from complaint_categories where id = new.category_id and organization_id = new.organization_id;
  if new.department_id is null then new.department_id := v_cat.department_id; end if;

  -- priority suggestion: category default, raised one step for safety wording and for a cluster of open reports nearby
  v_level := coalesce(array_position(c_levels, v_cat.base_severity), 2);
  v_reason := v_reason || format('Default priority for %s is %s', coalesce(v_cat.name, 'this category'), c_levels[v_level]);
  if new.description ~* '(accident|injur|danger|electric|spark|shock|open manhole|collapse|flood|burst|hospital|school|child|fire)' then
    v_level := least(4, v_level + 1);
    v_reason := array_append(v_reason, 'raised one step: the description mentions a safety risk');
  end if;
  if new.lon is not null and new.lat is not null then
    select count(*) into v_nearby
      from complaints o
     where o.organization_id = new.organization_id and o.category_id = new.category_id
       and o.resolved_at is null and o.lon is not null
       and 111320 * sqrt(power(o.lat - new.lat, 2) + power((o.lon - new.lon) * cos(radians(new.lat)), 2)) <= 150;
    if v_nearby >= 2 then
      v_level := least(4, v_level + 1);
      v_reason := v_reason || format('raised one step: %s open reports of the same kind within 150 m', v_nearby);
    end if;

    -- possible duplicate: same category, open, within 150 m, similar wording
    select o.id, o.reference into v_dup
      from complaints o
     where o.organization_id = new.organization_id and o.category_id = new.category_id
       and o.resolved_at is null and o.lon is not null
       and 111320 * sqrt(power(o.lat - new.lat, 2) + power((o.lon - new.lon) * cos(radians(new.lat)), 2)) <= 150
       and similarity(lower(o.description), lower(new.description)) >= 0.25
     order by similarity(lower(o.description), lower(new.description)) desc limit 1;
    if v_dup.id is not null then
      new.duplicate_of := v_dup.id;
      v_reason := v_reason || format('possible duplicate of %s', v_dup.reference);
    end if;
  end if;
  new.suggested_severity := c_levels[v_level];
  new.severity := new.suggested_severity;          -- provisional until an officer confirms
  new.suggestion_reason := array_to_string(v_reason, '; ') || '.';

  select e.days, e.basis into new.expected_days, new.expected_days_basis
    from app.expected_days(new.organization_id, new.zone_id, v_cat.published_issue) e;
  return new;
end $$;

create trigger complaints_before_insert before insert on public.complaints
  for each row execute function app.complaint_before_insert();

-- history: one row per status change; the note comes from a transaction-local setting
create or replace function app.complaint_history_row() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if tg_op = 'INSERT' then
    insert into complaint_history (organization_id, complaint_id, from_status, to_status, actor_id, note)
    values (new.organization_id, new.id, null, 'submitted', auth.uid(), 'Complaint submitted');
    -- the suggestions are ready as soon as the row exists
    perform set_config('app.history_note', 'System suggestions: ' || new.suggestion_reason, true);
    perform set_config('app.history_system', 'on', true);
    update complaints set status = 'classified' where id = new.id;
    perform set_config('app.history_system', 'off', true);
  elsif new.status is distinct from old.status then
    insert into complaint_history (organization_id, complaint_id, from_status, to_status, actor_id, note)
    values (new.organization_id, new.id, old.status, new.status,
            case when current_setting('app.history_system', true) = 'on' then null else auth.uid() end,
            nullif(current_setting('app.history_note', true), ''));
    perform set_config('app.history_note', '', true);
  end if;
  return null;
end $$;

create trigger complaints_history after insert or update of status on public.complaints
  for each row execute function app.complaint_history_row();

-- ---------------------------------------------------------------------------
-- Submit (runs as the caller: RLS decides whether the insert is allowed)
-- ---------------------------------------------------------------------------
create or replace function public.submit_complaint(
  p_category uuid, p_description text, p_zone uuid default null,
  p_lon double precision default null, p_lat double precision default null, p_photo_path text default null
) returns jsonb
language plpgsql set search_path = public, extensions as $$
declare
  v_id uuid;
begin
  insert into complaints (organization_id, citizen_id, category_id, description, zone_id, lon, lat, photo_path, reference)
  values (app.org_id(), auth.uid(), p_category, p_description, p_zone, p_lon, p_lat, p_photo_path, 'pending')
  returning id into v_id;
  return (select jsonb_build_object('id', id, 'reference', reference) from complaints where id = v_id);
end $$;

-- ---------------------------------------------------------------------------
-- Workflow actions. SECURITY DEFINER with explicit checks, because who may do
-- what depends on role AND on the complaint's state.
-- ---------------------------------------------------------------------------
create or replace function public.complaint_action(
  p_id uuid, p_action text, p_note text default null, p_assignee uuid default null,
  p_severity text default null, p_category uuid default null
) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_role  text := app.role();
  v_org   uuid := app.org_id();
  v_uid   uuid := auth.uid();
  c       complaints;
  v_staff boolean;
  v_mine  boolean;
  v_dept  uuid;
begin
  if v_uid is null or v_org is null then raise exception 'Not signed in' using errcode = 'P0001'; end if;
  select * into c from complaints where id = p_id and organization_id = v_org for update;
  if not found then raise exception 'Complaint not found' using errcode = 'P0001'; end if;
  v_staff := v_role in ('city_admin', 'dept_officer');
  v_mine  := v_role = 'field_worker' and c.assignee_id = v_uid;
  perform set_config('app.history_note', coalesce(nullif(trim(p_note), ''), ''), true);

  if p_action = 'assign' then
    if not v_staff then raise exception 'Only officers can assign complaints' using errcode = 'P0001'; end if;
    if c.status not in ('submitted', 'classified', 'assigned') then
      raise exception 'A complaint that is % cannot be assigned', replace(c.status, '_', ' ') using errcode = 'P0001';
    end if;
    if p_assignee is null or not exists (
         select 1 from users u where u.id = p_assignee and u.organization_id = v_org
            and u.role in ('city_admin', 'dept_officer', 'field_worker') and u.is_active) then
      raise exception 'Choose a staff member of this organization to assign to' using errcode = 'P0001';
    end if;
    if p_category is not null then
      select department_id into v_dept from complaint_categories where id = p_category and organization_id = v_org;
      if not found then raise exception 'Unknown category' using errcode = 'P0001'; end if;
    end if;
    update complaints
       set status = 'assigned', assignee_id = p_assignee, assigned_at = now(),
           severity = coalesce(p_severity, severity), severity_confirmed = true,
           category_id = coalesce(p_category, category_id),
           department_id = case when p_category is not null then v_dept else department_id end
     where id = p_id;

  elsif p_action = 'start' then
    if not (v_staff or v_mine) then raise exception 'Only the assignee or an officer can start work' using errcode = 'P0001'; end if;
    if c.status <> 'assigned' then raise exception 'Only an assigned complaint can be started' using errcode = 'P0001'; end if;
    update complaints set status = 'in_progress' where id = p_id;

  elsif p_action = 'resolve' then
    if not (v_staff or v_mine) then raise exception 'Only the assignee or an officer can resolve' using errcode = 'P0001'; end if;
    if c.status <> 'in_progress' then raise exception 'Only a complaint in progress can be resolved' using errcode = 'P0001'; end if;
    update complaints set status = 'resolved', resolved_at = now() where id = p_id;

  elsif p_action = 'verify' then
    if not v_staff then raise exception 'Only officers can verify a resolution' using errcode = 'P0001'; end if;
    if c.status <> 'resolved' then raise exception 'Only a resolved complaint can be verified' using errcode = 'P0001'; end if;
    update complaints set status = 'verified', verified_at = now() where id = p_id;

  elsif p_action = 'reopen' then
    if not v_staff then raise exception 'Only officers can reopen a complaint' using errcode = 'P0001'; end if;
    if c.status <> 'resolved' then raise exception 'Only a resolved complaint can be reopened' using errcode = 'P0001'; end if;
    if coalesce(trim(p_note), '') = '' then raise exception 'Say why the complaint is being reopened' using errcode = 'P0001'; end if;
    update complaints set status = 'in_progress', resolved_at = null where id = p_id;

  else
    raise exception 'Unknown action %', p_action using errcode = 'P0001';
  end if;

  return (select status from complaints where id = p_id);
end $$;

-- ---------------------------------------------------------------------------
-- Reads (run as the caller, so RLS decides which complaints are visible)
-- ---------------------------------------------------------------------------
create or replace function public.complaint_list(p_status text default null)
returns jsonb
language sql stable set search_path = public, extensions as $$
  select jsonb_build_object(
    'counts', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) as n from complaints group by status) t), '{}'::jsonb),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'reference', c.reference, 'category', cc.name, 'ward', z.code, 'status', c.status,
               'severity', c.severity, 'severity_confirmed', c.severity_confirmed, 'created_at', c.created_at,
               'description', left(c.description, 140), 'expected_days', c.expected_days,
               'assignee', u.full_name, 'is_duplicate', c.duplicate_of is not null) order by c.created_at desc)
        from complaints c
        left join complaint_categories cc on cc.id = c.category_id
        left join city_zones z on z.id = c.zone_id
        left join users u on u.id = c.assignee_id
       where p_status is null or c.status = p_status), '[]'::jsonb))
$$;

create or replace function public.complaint_detail(p_id uuid)
returns jsonb
language sql stable set search_path = public, extensions as $$
  select jsonb_build_object(
    'complaint', (
      select to_jsonb(c) - 'geom' - 'organization_id' || jsonb_build_object(
               'category', cc.name, 'suggested_category', sc.name, 'ward', z.name, 'department', d.name,
               'citizen', cu.full_name, 'assignee', au.full_name,
               'duplicate', (select jsonb_build_object('id', o.id, 'reference', o.reference, 'status', o.status)
                               from complaints o where o.id = c.duplicate_of))
        from complaints c
        left join complaint_categories cc on cc.id = c.category_id
        left join complaint_categories sc on sc.id = c.suggested_category_id
        left join city_zones z on z.id = c.zone_id
        left join departments d on d.id = c.department_id
        left join users cu on cu.id = c.citizen_id
        left join users au on au.id = c.assignee_id
       where c.id = p_id),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object('from', h.from_status, 'to', h.to_status, 'note', h.note, 'at', h.created_at,
                                          'actor', case when h.actor_id is null then 'System' else coalesce(u.full_name, 'Staff') end)
                       order by h.created_at, h.id)
        from complaint_history h left join users u on u.id = h.actor_id
       where h.complaint_id = p_id), '[]'::jsonb),
    'staff', coalesce((
      select jsonb_agg(jsonb_build_object('id', u.id, 'name', u.full_name, 'role', u.role) order by u.full_name)
        from users u where u.role in ('city_admin', 'dept_officer', 'field_worker') and u.is_active), '[]'::jsonb),
    'categories', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name) from complaint_categories), '[]'::jsonb))
$$;

-- ---------------------------------------------------------------------------
-- Grants and RLS
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on public.complaint_history to authenticated;
grant all on public.complaint_history to service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;
revoke all on public.complaint_history from anon;
revoke insert, update, delete on public.complaint_history from authenticated;   -- written by triggers only

-- any member may report a problem as themselves; the trigger fixes every other field
create policy member_submit on public.complaints for insert to authenticated
  with check (organization_id = (select app.org_id()) and citizen_id = (select auth.uid()));

-- field workers see what is assigned to them
create policy field_read_assigned on public.complaints for select to authenticated
  using (organization_id = (select app.org_id()) and assignee_id = (select auth.uid()));

-- history is visible exactly when its complaint is (the subquery runs under the caller's RLS)
alter table public.complaint_history enable row level security;
create policy history_read on public.complaint_history for select to authenticated
  using ((select app.is_super_admin())
         or (organization_id = (select app.org_id())
             and exists (select 1 from public.complaints c where c.id = complaint_history.complaint_id)));

revoke all on function public.submit_complaint(uuid, text, uuid, double precision, double precision, text) from public, anon;
revoke all on function public.complaint_action(uuid, text, text, uuid, text, uuid) from public, anon;
revoke all on function public.complaint_list(text) from public, anon;
revoke all on function public.complaint_detail(uuid) from public, anon;
grant execute on function public.submit_complaint(uuid, text, uuid, double precision, double precision, text) to authenticated;
grant execute on function public.complaint_action(uuid, text, text, uuid, text, uuid) to authenticated;
grant execute on function public.complaint_list(text) to authenticated;
grant execute on function public.complaint_detail(uuid) to authenticated;
revoke all on function app.expected_days(uuid, uuid, text) from public, anon, authenticated;
