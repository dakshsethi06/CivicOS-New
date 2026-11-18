-- CivicOS 0021: field work, inspection reports, department scoping and email invitations.
--
-- * Work tasks: inspections and repairs assigned to staff, created by officers or automatically when a recommendation
--   is assigned; field workers start and complete the ones assigned to them.
-- * Inspection reports: what a field worker found (condition, findings, action taken, photo, location), on a task or
--   a complaint.
-- * Department scoping: a Department Officer who belongs to a department sees and acts on that department's
--   complaints and tasks (and those with no department). Officers without a department, and administrators, see all.
-- * Invitations: an administrator invites by email with a role and department; the person accepts by setting their
--   own name and password. The plan's staff limit counts pending invitations.

-- ------------------------------------------------------------------------------------------------ helpers
create or replace function app.in_my_department(p_department uuid) returns boolean
language sql stable as $$
  select app.role() is distinct from 'dept_officer' or app.department_id() is null or p_department is null
         or p_department = app.department_id()
$$;

create or replace function app.module_department(p_org uuid, p_module text) returns uuid
language sql stable security definer set search_path = public as $$
  select id from departments where organization_id = p_org
     and code = case p_module when 'water' then 'WATER' when 'waste' then 'WASTE' when 'traffic' then 'TRAFFIC' end
$$;

-- ------------------------------------------------------------------------------------------- department scope
create policy dept_scope on public.complaints as restrictive for all to authenticated
  using (app.in_my_department(department_id)) with check (app.in_my_department(department_id));

-- complaint_action is SECURITY DEFINER (it bypasses RLS), so it checks the department itself
alter function public.complaint_action(uuid, text, text, uuid, text, uuid) rename to complaint_action_core;
alter function public.complaint_action_core(uuid, text, text, uuid, text, uuid) set schema app;
revoke all on function app.complaint_action_core(uuid, text, text, uuid, text, uuid) from public, anon, authenticated;

create or replace function public.complaint_action(
  p_id uuid, p_action text, p_note text default null, p_assignee uuid default null,
  p_severity text default null, p_category uuid default null
) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_dept uuid;
  v_new  uuid;
begin
  select department_id into v_dept from complaints where id = p_id and organization_id = app.org_id();
  if not app.in_my_department(v_dept) then
    raise exception 'This complaint belongs to another department' using errcode = 'P0001';
  end if;
  if p_category is not null then
    select department_id into v_new from complaint_categories where id = p_category and organization_id = app.org_id();
    if not app.in_my_department(v_new) then
      raise exception 'You can only move a complaint to a category of your own department' using errcode = 'P0001';
    end if;
  end if;
  return app.complaint_action_core(p_id, p_action, p_note, p_assignee, p_severity, p_category);
end $$;
revoke all on function public.complaint_action(uuid, text, text, uuid, text, uuid) from public, anon;
grant execute on function public.complaint_action(uuid, text, text, uuid, text, uuid) to authenticated;

-- --------------------------------------------------------------------------------------------- work tasks
create table public.work_tasks (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  reference         text not null,
  kind              text not null check (kind in ('inspection', 'repair', 'collection', 'recommendation', 'other')),
  title             text not null,
  description       text,
  priority          text not null default 'medium' check (priority in ('low', 'medium', 'high', 'critical')),
  status            text not null default 'open' check (status in ('open', 'in_progress', 'done', 'cancelled')),
  department_id     uuid references public.departments(id) on delete set null,
  zone_id           uuid references public.city_zones(id) on delete set null,
  lat               double precision,
  lon               double precision,
  assignee_id       uuid references public.users(id) on delete set null,
  created_by        uuid references public.users(id) on delete set null,
  recommendation_id uuid references public.recommendations(id) on delete set null,
  anomaly_id        bigint references public.water_anomalies(id) on delete set null,
  complaint_id      uuid references public.complaints(id) on delete set null,
  due_at            timestamptz,
  started_at        timestamptz,
  completed_at      timestamptz,
  created_at        timestamptz not null default now(),
  unique (organization_id, reference)
);
create index work_tasks_org_idx on public.work_tasks (organization_id, status);
create index work_tasks_assignee_idx on public.work_tasks (assignee_id, status);
create sequence public.work_task_ref_seq;

create table public.inspection_reports (
  id              bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  task_id         uuid references public.work_tasks(id) on delete cascade,
  complaint_id    uuid references public.complaints(id) on delete cascade,
  author_id       uuid references public.users(id) on delete set null,
  condition       text not null check (condition in ('good', 'minor', 'major', 'critical')),
  findings        text not null,
  action_taken    text,
  needs_followup  boolean not null default false,
  photo_path      text,
  lat             double precision,
  lon             double precision,
  created_at      timestamptz not null default now(),
  check (task_id is not null or complaint_id is not null)
);
create index inspection_reports_task_idx on public.inspection_reports (task_id);
create index inspection_reports_complaint_idx on public.inspection_reports (complaint_id);

grant select on public.work_tasks, public.inspection_reports to authenticated;
grant all on public.work_tasks, public.inspection_reports to service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;
revoke all on public.work_tasks, public.inspection_reports from anon;
-- reads: officers (department-scoped below) and the assignee; all writes go through the functions below
select app.apply_tenant_policies('public.work_tasks', '{city_admin,dept_officer}', '{}');
create policy assignee_read on public.work_tasks for select to authenticated
  using (organization_id = (select app.org_id()) and assignee_id = (select auth.uid()));
create policy dept_scope on public.work_tasks as restrictive for select to authenticated
  using (app.in_my_department(department_id) or assignee_id = (select auth.uid()));
select app.apply_tenant_policies('public.inspection_reports', '{city_admin,dept_officer}', '{}');
create policy author_read on public.inspection_reports for select to authenticated
  using (organization_id = (select app.org_id()) and author_id = (select auth.uid()));

create or replace function public.task_create(
  p_title text, p_description text default null, p_kind text default 'inspection', p_priority text default 'medium',
  p_assignee uuid default null, p_due timestamptz default null, p_recommendation uuid default null,
  p_anomaly bigint default null, p_complaint uuid default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_org  uuid := app.org_id();
  v_dept uuid; v_zone uuid; v_lat float8; v_lon float8;
  v_id   uuid;
  v_ref  text;
begin
  if app.role() not in ('city_admin', 'dept_officer') then
    raise exception 'Only officers can create tasks' using errcode = 'P0001';
  end if;
  if coalesce(trim(p_title), '') = '' then raise exception 'Give the task a title' using errcode = 'P0001'; end if;
  if p_assignee is not null and not exists (select 1 from users where id = p_assignee and organization_id = v_org
                                             and role in ('city_admin', 'dept_officer', 'field_worker') and is_active) then
    raise exception 'Choose a staff member of this organization' using errcode = 'P0001';
  end if;
  -- where and which department, from what the task is about
  if p_complaint is not null then
    select department_id, zone_id, lat, lon into v_dept, v_zone, v_lat, v_lon from complaints where id = p_complaint and organization_id = v_org;
    if not found then raise exception 'Complaint not found' using errcode = 'P0001'; end if;
  elsif p_anomaly is not null then
    select a.zone_id, (st_asgeojson(s.geom)::jsonb #>> '{coordinates,1}')::float8, (st_asgeojson(s.geom)::jsonb #>> '{coordinates,0}')::float8
      into v_zone, v_lat, v_lon
      from water_anomalies a join water_sensors s on s.id = a.sensor_id where a.id = p_anomaly and a.organization_id = v_org;
    if not found then raise exception 'Anomaly not found' using errcode = 'P0001'; end if;
    v_dept := app.module_department(v_org, 'water');
    update water_anomalies set status = 'inspecting', reviewed_by = auth.uid(), reviewed_at = now()
     where id = p_anomaly and status = 'open';
  elsif p_recommendation is not null then
    select zone_id, app.module_department(v_org, module) into v_zone, v_dept from recommendations where id = p_recommendation and organization_id = v_org;
    if not found then raise exception 'Recommendation not found' using errcode = 'P0001'; end if;
  end if;
  v_dept := coalesce(v_dept, app.department_id());
  if not app.in_my_department(v_dept) then raise exception 'This belongs to another department' using errcode = 'P0001'; end if;

  v_ref := 'TSK-' || lpad(nextval('public.work_task_ref_seq')::text, 6, '0');
  insert into work_tasks (organization_id, reference, kind, title, description, priority, department_id, zone_id, lat, lon,
                          assignee_id, created_by, recommendation_id, anomaly_id, complaint_id, due_at)
  values (v_org, v_ref, coalesce(p_kind, 'inspection'), trim(p_title), nullif(trim(coalesce(p_description, '')), ''),
          coalesce(p_priority, 'medium'), v_dept, v_zone, v_lat, v_lon, p_assignee, auth.uid(), p_recommendation, p_anomaly,
          p_complaint, p_due)
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'reference', v_ref);
end $$;

create or replace function public.task_action(p_id uuid, p_action text, p_assignee uuid default null) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare
  t       work_tasks;
  v_staff boolean := app.role() in ('city_admin', 'dept_officer');
  v_mine  boolean;
begin
  select * into t from work_tasks where id = p_id and organization_id = app.org_id() for update;
  if not found then raise exception 'Task not found' using errcode = 'P0001'; end if;
  v_mine := t.assignee_id = auth.uid();
  if v_staff and not v_mine and not app.in_my_department(t.department_id) then
    raise exception 'This task belongs to another department' using errcode = 'P0001';
  end if;
  if p_action = 'start' then
    if not (v_staff or v_mine) then raise exception 'Only the assignee or an officer can start this task' using errcode = 'P0001'; end if;
    if t.status <> 'open' then raise exception 'Only an open task can be started' using errcode = 'P0001'; end if;
    update work_tasks set status = 'in_progress', started_at = now() where id = p_id;
  elsif p_action = 'complete' then
    if not (v_staff or v_mine) then raise exception 'Only the assignee or an officer can complete this task' using errcode = 'P0001'; end if;
    if t.status not in ('open', 'in_progress') then raise exception 'This task is already closed' using errcode = 'P0001'; end if;
    update work_tasks set status = 'done', completed_at = now(), started_at = coalesce(started_at, now()) where id = p_id;
  elsif p_action = 'cancel' then
    if not v_staff then raise exception 'Only officers can cancel tasks' using errcode = 'P0001'; end if;
    update work_tasks set status = 'cancelled', completed_at = now() where id = p_id;
  elsif p_action = 'reopen' then
    if not v_staff then raise exception 'Only officers can reopen tasks' using errcode = 'P0001'; end if;
    update work_tasks set status = 'open', completed_at = null where id = p_id;
  elsif p_action = 'reassign' then
    if not v_staff then raise exception 'Only officers can reassign tasks' using errcode = 'P0001'; end if;
    if not exists (select 1 from users where id = p_assignee and organization_id = t.organization_id
                    and role in ('city_admin', 'dept_officer', 'field_worker') and is_active) then
      raise exception 'Choose a staff member of this organization' using errcode = 'P0001';
    end if;
    update work_tasks set assignee_id = p_assignee where id = p_id;
  else
    raise exception 'Unknown action %', p_action using errcode = 'P0001';
  end if;
  return (select status from work_tasks where id = p_id);
end $$;

-- a recommendation assigned to someone becomes their task (or moves the existing open one to them)
create or replace function app.recommendation_task() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if new.status = 'assigned' and new.assignee_id is not null
     and (old.status is distinct from 'assigned' or old.assignee_id is distinct from new.assignee_id) then
    update work_tasks set assignee_id = new.assignee_id
     where recommendation_id = new.id and status in ('open', 'in_progress');
    if not found then
      insert into work_tasks (organization_id, reference, kind, title, description, priority, department_id, zone_id,
                              assignee_id, created_by, recommendation_id)
      values (new.organization_id, 'TSK-' || lpad(nextval('public.work_task_ref_seq')::text, 6, '0'), 'recommendation',
              left(new.problem, 160), new.action, new.priority, app.module_department(new.organization_id, new.module),
              new.zone_id, new.assignee_id, auth.uid(), new.id);
    end if;
  elsif new.status in ('completed', 'rejected') and old.status is distinct from new.status then
    update work_tasks set status = case when new.status = 'completed' then 'done' else 'cancelled' end, completed_at = now()
     where recommendation_id = new.id and status in ('open', 'in_progress');
  end if;
  return new;
end $$;
create trigger recommendations_task after update of status, assignee_id on public.recommendations
  for each row execute function app.recommendation_task();

-- ----------------------------------------------------------------------------------------- inspection reports
create or replace function public.submit_inspection(
  p_task uuid, p_complaint uuid, p_condition text, p_findings text, p_action text default null,
  p_followup boolean default false, p_photo text default null, p_lat float8 default null, p_lon float8 default null,
  p_complete boolean default false
) returns bigint
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_org   uuid := app.org_id();
  v_staff boolean := app.role() in ('city_admin', 'dept_officer');
  v_ok    boolean := false;
  v_id    bigint;
  v_dept  uuid;
begin
  if p_task is null and p_complaint is null then raise exception 'Say which task or complaint this report is for' using errcode = 'P0001'; end if;
  if coalesce(trim(p_findings), '') = '' then raise exception 'Describe what you found' using errcode = 'P0001'; end if;
  if p_condition not in ('good', 'minor', 'major', 'critical') then raise exception 'Choose the condition' using errcode = 'P0001'; end if;
  if p_photo is not null and split_part(p_photo, '/', 1) <> v_org::text then raise exception 'Invalid photo path' using errcode = 'P0001'; end if;
  if p_task is not null then
    select assignee_id = auth.uid(), department_id into v_ok, v_dept from work_tasks where id = p_task and organization_id = v_org;
    if not found then raise exception 'Task not found' using errcode = 'P0001'; end if;
  else
    select assignee_id = auth.uid(), department_id into v_ok, v_dept from complaints where id = p_complaint and organization_id = v_org;
    if not found then raise exception 'Complaint not found' using errcode = 'P0001'; end if;
  end if;
  if not (coalesce(v_ok, false) or (v_staff and app.in_my_department(v_dept))) then
    raise exception 'Only the assigned person or an officer can file this report' using errcode = 'P0001';
  end if;
  insert into inspection_reports (organization_id, task_id, complaint_id, author_id, condition, findings, action_taken,
                                  needs_followup, photo_path, lat, lon)
  values (v_org, p_task, p_complaint, auth.uid(), p_condition, trim(p_findings), nullif(trim(coalesce(p_action, '')), ''),
          coalesce(p_followup, false), p_photo, p_lat, p_lon)
  returning id into v_id;
  if p_complete and p_task is not null then
    update work_tasks set status = 'done', completed_at = now(), started_at = coalesce(started_at, now())
     where id = p_task and status in ('open', 'in_progress');
  end if;
  return v_id;
end $$;

-- ------------------------------------------------------------------------------------------------ reads
-- My work: open tasks and assigned complaints for the caller; officers also see all open tasks they may see (RLS).
create or replace function public.work_list(p_scope text default 'mine') returns jsonb
language sql stable set search_path = public, extensions as $$
  select jsonb_build_object(
    'tasks', coalesce((select jsonb_agg(jsonb_build_object(
               'id', t.id, 'reference', t.reference, 'kind', t.kind, 'title', t.title, 'priority', t.priority, 'status', t.status,
               'ward', z.code, 'assignee', u.full_name, 'department', d.name, 'due_at', t.due_at, 'created_at', t.created_at,
               'reports', (select count(*) from inspection_reports r where r.task_id = t.id))
               order by case t.status when 'in_progress' then 1 when 'open' then 2 else 3 end,
                        case t.priority when 'critical' then 1 when 'high' then 2 when 'medium' then 3 else 4 end, t.created_at)
             from work_tasks t left join city_zones z on z.id = t.zone_id left join users u on u.id = t.assignee_id
             left join departments d on d.id = t.department_id
            where (p_scope = 'all' or t.assignee_id = auth.uid())
              and (p_scope = 'all' or t.status in ('open', 'in_progress'))), '[]'::jsonb),
    'complaints', coalesce((select jsonb_agg(jsonb_build_object(
               'id', c.id, 'reference', c.reference, 'category', cc.name, 'status', c.status, 'severity', c.severity,
               'ward', z.code, 'description', left(c.description, 120), 'created_at', c.created_at)
               order by case c.severity when 'critical' then 1 when 'high' then 2 when 'medium' then 3 else 4 end, c.created_at)
             from complaints c left join complaint_categories cc on cc.id = c.category_id left join city_zones z on z.id = c.zone_id
            where c.assignee_id = auth.uid() and c.status in ('assigned', 'in_progress')), '[]'::jsonb))
$$;

create or replace function public.task_detail(p_id uuid) returns jsonb
language sql stable set search_path = public, extensions as $$
  select jsonb_build_object(
    'task', (select to_jsonb(t) - 'organization_id' || jsonb_build_object(
                      'ward', z.name, 'assignee', u.full_name, 'department', d.name, 'created_by_name', cb.full_name,
                      'recommendation', (select jsonb_build_object('id', r.id, 'problem', r.problem, 'action', r.action, 'basis', r.basis)
                                           from recommendations r where r.id = t.recommendation_id),
                      'anomaly', (select jsonb_build_object('id', a.id, 'pattern', a.pattern, 'level', a.level, 'status', a.status,
                                                            'sensor', s.code, 'evidence', a.evidence)
                                    from water_anomalies a join water_sensors s on s.id = a.sensor_id where a.id = t.anomaly_id),
                      'complaint', (select jsonb_build_object('id', c.id, 'reference', c.reference, 'description', c.description)
                                      from complaints c where c.id = t.complaint_id))
               from work_tasks t left join city_zones z on z.id = t.zone_id left join users u on u.id = t.assignee_id
               left join departments d on d.id = t.department_id left join users cb on cb.id = t.created_by
              where t.id = p_id),
    'reports', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'condition', r.condition, 'findings', r.findings,
                                                             'action_taken', r.action_taken, 'needs_followup', r.needs_followup,
                                                             'photo_path', r.photo_path, 'lat', r.lat, 'lon', r.lon,
                                                             'author', u.full_name, 'created_at', r.created_at) order by r.created_at)
                           from inspection_reports r left join users u on u.id = r.author_id where r.task_id = p_id), '[]'::jsonb),
    'staff', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', full_name, 'role', role) order by full_name)
                         from users where role in ('city_admin', 'dept_officer', 'field_worker') and is_active), '[]'::jsonb))
$$;

create or replace function public.complaint_reports(p_complaint uuid) returns jsonb
language sql stable set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'condition', r.condition, 'findings', r.findings,
                                               'action_taken', r.action_taken, 'needs_followup', r.needs_followup,
                                               'photo_path', r.photo_path, 'author', u.full_name, 'created_at', r.created_at)
                            order by r.created_at), '[]'::jsonb)
    from inspection_reports r left join users u on u.id = r.author_id
   where r.complaint_id = p_complaint
$$;

-- ------------------------------------------------------------------------------------------------ invitations
create or replace function public.invitation_create(p_email text, p_role text, p_department uuid default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_org   uuid := app.org_id();
  v_email text := lower(trim(p_email));
  v_limit int  := app.plan_limit(v_org, 'max_users');
  v_used  int;
  v_inv   invitations;
begin
  if app.role() <> 'city_admin' then raise exception 'Only a City Administrator can invite people' using errcode = 'P0001'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email address' using errcode = 'P0001'; end if;
  if p_role not in ('city_admin', 'dept_officer', 'field_worker') then raise exception 'Choose a staff role' using errcode = 'P0001'; end if;
  if p_department is not null and not exists (select 1 from departments where id = p_department and organization_id = v_org) then
    raise exception 'Unknown department' using errcode = 'P0001';
  end if;
  if exists (select 1 from users where lower(email) = v_email and organization_id = v_org) then
    raise exception '% is already a member of this workspace', v_email using errcode = 'P0001';
  end if;
  select count(*) into v_used from (
    select id from users where organization_id = v_org and role <> 'citizen' and is_active
    union all
    select id from invitations where organization_id = v_org and accepted_at is null and expires_at > now() and lower(email) <> v_email) s;
  if v_limit is not null and v_used >= v_limit then
    raise exception 'Plan limit reached: this plan allows % staff users, counting pending invitations', v_limit using errcode = 'P0001';
  end if;
  delete from invitations where organization_id = v_org and lower(email) = v_email and accepted_at is null;
  insert into invitations (organization_id, email, role, department_id, invited_by)
  values (v_org, v_email, p_role, p_department, auth.uid()) returning * into v_inv;
  return jsonb_build_object('id', v_inv.id, 'email', v_inv.email, 'expires_at', v_inv.expires_at);
end $$;

-- the invited person, signed in from the invitation email, joins the organization that invited them
create or replace function public.accept_invitation(p_full_name text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid   uuid := auth.uid();
  v_email text;
  v_inv   invitations;
begin
  if v_uid is null then raise exception 'Sign in from the invitation email first' using errcode = 'P0001'; end if;
  if coalesce(trim(p_full_name), '') = '' then raise exception 'Enter your name' using errcode = 'P0001'; end if;
  select lower(email) into v_email from auth.users where id = v_uid;
  if exists (select 1 from users where id = v_uid) then raise exception 'This account already belongs to a workspace' using errcode = 'P0001'; end if;
  select * into v_inv from invitations
   where lower(email) = v_email and accepted_at is null and expires_at > now()
   order by created_at desc limit 1;
  if not found then raise exception 'No open invitation for %. Ask your administrator to invite you again.', v_email using errcode = 'P0001'; end if;
  insert into users (id, organization_id, role, department_id, full_name, email)
  values (v_uid, v_inv.organization_id, v_inv.role, v_inv.department_id, trim(p_full_name), v_email);
  update invitations set accepted_at = now() where id = v_inv.id;
  return jsonb_build_object('organization_id', v_inv.organization_id, 'role', v_inv.role);
end $$;

create or replace function public.invitation_revoke(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if app.role() <> 'city_admin' then raise exception 'Only a City Administrator can revoke invitations' using errcode = 'P0001'; end if;
  delete from invitations where id = p_id and organization_id = app.org_id() and accepted_at is null;
end $$;

revoke all on function public.task_create(text, text, text, text, uuid, timestamptz, uuid, bigint, uuid), public.task_action(uuid, text, uuid),
  public.submit_inspection(uuid, uuid, text, text, text, boolean, text, float8, float8, boolean), public.work_list(text),
  public.task_detail(uuid), public.complaint_reports(uuid), public.invitation_create(text, text, uuid),
  public.accept_invitation(text), public.invitation_revoke(uuid) from public, anon;
grant execute on function public.task_create(text, text, text, text, uuid, timestamptz, uuid, bigint, uuid), public.task_action(uuid, text, uuid),
  public.submit_inspection(uuid, uuid, text, text, text, boolean, text, float8, float8, boolean), public.work_list(text),
  public.task_detail(uuid), public.complaint_reports(uuid), public.invitation_create(text, text, uuid),
  public.accept_invitation(text), public.invitation_revoke(uuid) to authenticated;
revoke all on function app.module_department(uuid, text) from public, anon, authenticated;
