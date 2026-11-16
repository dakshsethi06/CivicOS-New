-- CivicOS 0014: plans and usage, API keys with a rate-limited public API, audit log view, platform overview.

-- ---------------------------------------------------------------------------
-- Plans. No payment provider is connected: changing plan is a TEST-MODE switch,
-- recorded as such, so limits and feature flags can be tried.
-- ---------------------------------------------------------------------------
create or replace function public.change_plan(p_plan text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_org uuid := app.org_id();
begin
  if app.role() <> 'city_admin' then raise exception 'Only a City Administrator can change the plan' using errcode = 'P0001'; end if;
  if not exists (select 1 from plans where code = p_plan) then raise exception 'Unknown plan' using errcode = 'P0001'; end if;
  update subscriptions set status = 'canceled' where organization_id = v_org and status = 'active';
  insert into subscriptions (organization_id, plan_code, status, provider, provider_ref, current_period_end)
  values (v_org, p_plan, 'active', 'test_mode', 'no payment taken', now() + interval '30 days');
  update organizations set plan_code = p_plan where id = v_org;
  return p_plan;
end $$;

create or replace function public.usage_summary() returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_org uuid := app.org_id();
  v_plan plans;
begin
  if app.role() not in ('city_admin', 'super_admin') then raise exception 'Only a City Administrator can view usage' using errcode = 'P0001'; end if;
  select p.* into v_plan from organizations o join plans p on p.code = o.plan_code where o.id = v_org;
  return jsonb_build_object(
    'plan', jsonb_build_object('code', v_plan.code, 'name', v_plan.name, 'limits', v_plan.limits),
    'plans', (select jsonb_agg(jsonb_build_object('code', code, 'name', name, 'limits', limits) order by sort) from plans),
    'subscription', (select jsonb_build_object('status', status, 'provider', provider, 'since', created_at)
                       from subscriptions where organization_id = v_org and status = 'active' order by created_at desc limit 1),
    'usage', jsonb_build_object(
      'staff_users', (select count(*) from users where organization_id = v_org and role <> 'citizen'),
      'residents',   (select count(*) from users where organization_id = v_org and role = 'citizen'),
      'documents',   (select count(*) from documents where organization_id = v_org),
      'ai_queries',  app.usage_this_month(v_org, 'ai_query'),
      'api_calls',   app.usage_this_month(v_org, 'api_call')));
end $$;

-- ---------------------------------------------------------------------------
-- API keys. The key is shown once; only its SHA-256 hash is stored.
-- ---------------------------------------------------------------------------
create or replace function public.create_api_key(p_name text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_key text := 'civ_' || replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  v_id  uuid;
begin
  if app.role() <> 'city_admin' then raise exception 'Only a City Administrator can create API keys' using errcode = 'P0001'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Give the key a name' using errcode = 'P0001'; end if;
  insert into api_keys (organization_id, name, key_prefix, key_hash, created_by)
  values (app.org_id(), trim(p_name), left(v_key, 12), encode(sha256(convert_to(v_key, 'utf8')), 'hex'), auth.uid())
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'key', v_key);
end $$;

create or replace function public.revoke_api_key(p_id uuid) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
begin
  if app.role() <> 'city_admin' then raise exception 'Only a City Administrator can revoke API keys' using errcode = 'P0001'; end if;
  update api_keys set revoked_at = now() where id = p_id and organization_id = app.org_id() and revoked_at is null;
  return found;
end $$;

-- Called by the web server (service role) for each public API request: authenticates the key,
-- applies the rate limit (60 requests a minute per organization), records the call, returns the data.
create or replace function public.api_indicators(p_key text, p_metric text default null, p_year int default null, p_ward text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  k api_keys;
  v_recent int;
begin
  select * into k from api_keys where key_hash = encode(sha256(convert_to(coalesce(p_key, ''), 'utf8')), 'hex') and revoked_at is null;
  if not found then return jsonb_build_object('status', 401, 'error', 'Invalid or revoked API key'); end if;

  select count(*) into v_recent from usage_records
   where organization_id = k.organization_id and metric = 'api_call' and recorded_at > now() - interval '1 minute';
  if v_recent >= 60 then return jsonb_build_object('status', 429, 'error', 'Rate limit exceeded: 60 requests a minute'); end if;

  insert into usage_records (organization_id, metric) values (k.organization_id, 'api_call');
  update api_keys set last_used_at = now() where id = k.id;

  if p_metric is null then
    return jsonb_build_object('status', 200, 'metrics', (
      select jsonb_agg(jsonb_build_object('metric', metric, 'unit', unit, 'years', years) order by metric)
        from (select metric, min(unit) as unit, jsonb_agg(distinct year order by year) as years
                from civic_indicators where organization_id = k.organization_id group by metric) t));
  end if;
  return jsonb_build_object('status', 200, 'metric', p_metric, 'data', coalesce((
    select jsonb_agg(jsonb_build_object('ward', z.code, 'year', ci.year, 'month', ci.month, 'category', ci.category,
                                        'value', ci.value, 'unit', ci.unit,
                                        'source', format('%s, %s, p. %s', s.publisher, s.table_ref, s.page))
                     order by ci.year, z.code, ci.month)
      from civic_indicators ci
      left join city_zones z on z.id = ci.zone_id
      left join data_sources s on s.organization_id = ci.organization_id and s.id = ci.source_id
     where ci.organization_id = k.organization_id and ci.metric = p_metric
       and (p_year is null or ci.year = p_year)
       and (p_ward is null or z.code = upper(p_ward))), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------
-- Audit log (runs as the caller: only a City Administrator's RLS lets rows through)
-- ---------------------------------------------------------------------------
create or replace function public.audit_recent(p_limit int default 50) returns jsonb
language sql stable set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object('at', a.created_at, 'action', a.action, 'entity', a.entity,
                                               'actor', coalesce(u.full_name, 'System'),
                                               'summary', coalesce(a.diff -> 'new' ->> 'name', a.diff -> 'new' ->> 'full_name',
                                                                   a.diff -> 'new' ->> 'email', a.diff -> 'new' ->> 'plan_code',
                                                                   a.diff -> 'old' ->> 'name', a.diff -> 'old' ->> 'full_name', a.entity_id))
                            order by a.created_at desc, a.id desc), '[]'::jsonb)
    from (select * from audit_logs order by created_at desc, id desc limit least(greatest(p_limit, 1), 200)) a
    left join users u on u.id = a.actor_id
$$;

-- ---------------------------------------------------------------------------
-- Platform overview for Super Administrators
-- ---------------------------------------------------------------------------
create or replace function public.platform_overview() returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not app.is_super_admin() then raise exception 'Super Administrators only' using errcode = 'P0001'; end if;
  return jsonb_build_object(
    'totals', jsonb_build_object(
      'organizations', (select count(*) from organizations),
      'staff_users', (select count(*) from users where role <> 'citizen'),
      'residents', (select count(*) from users where role = 'citizen'),
      'complaints', (select count(*) from complaints),
      'ai_queries_this_month', (select coalesce(sum(quantity), 0) from usage_records where metric = 'ai_query' and recorded_at >= date_trunc('month', now())),
      'api_calls_this_month', (select coalesce(sum(quantity), 0) from usage_records where metric = 'api_call' and recorded_at >= date_trunc('month', now()))),
    'organizations', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', o.name, 'slug', o.slug, 'plan', o.plan_code, 'status', o.status, 'created_at', o.created_at,
               'staff_users', (select count(*) from users u where u.organization_id = o.id and u.role <> 'citizen'),
               'residents', (select count(*) from users u where u.organization_id = o.id and u.role = 'citizen'),
               'complaints', (select count(*) from complaints c where c.organization_id = o.id),
               'documents', (select count(*) from documents d where d.organization_id = o.id),
               'ai_queries', app.usage_this_month(o.id, 'ai_query'),
               'api_calls', app.usage_this_month(o.id, 'api_call')) order by o.created_at)
        from organizations o), '[]'::jsonb),
    'plans', (select jsonb_agg(jsonb_build_object('code', code, 'name', name, 'limits', limits,
                                                  'organizations', (select count(*) from organizations o where o.plan_code = p.code)) order by sort)
                from plans p));
end $$;

do $$
declare f text;
begin
  foreach f in array array['public.change_plan(text)', 'public.usage_summary()', 'public.create_api_key(text)',
                           'public.revoke_api_key(uuid)', 'public.audit_recent(int)', 'public.platform_overview()']
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
revoke all on function public.api_indicators(text, text, int, text) from public, anon, authenticated;
grant execute on function public.api_indicators(text, text, int, text) to service_role;
