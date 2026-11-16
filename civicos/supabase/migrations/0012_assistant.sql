-- CivicOS 0012: knowledge base and assistant.
-- Documents are split into chunks and searched with Postgres full-text search. The assistant answers only
-- from what retrieval returns: document excerpts (cited by title and page) and published figures (cited by
-- report table). If nothing relevant is found it says so.

create table public.documents (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  title           text not null,
  category        text not null default 'Other',
  department_id   uuid references public.departments(id) on delete set null,
  version         text,
  source          text,                                   -- publisher or origin, as entered by the uploader
  storage_path    text,
  mime_type       text,
  access_level    text not null default 'staff' check (access_level in ('staff', 'public')),
  status          text not null default 'processing' check (status in ('processing', 'ready', 'failed')),
  error           text,
  page_count      int,
  chunk_count     int not null default 0,
  uploaded_by     uuid references public.users(id) on delete set null,
  created_at      timestamptz not null default now()
);
create index documents_org_idx on public.documents (organization_id);

create table public.document_chunks (
  id              bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  document_id     uuid not null references public.documents(id) on delete cascade,
  page_number     int,
  chunk_index     int not null,
  content         text not null,
  tsv             tsvector generated always as (to_tsvector('english', content)) stored
);
create index document_chunks_doc_idx on public.document_chunks (document_id);
create index document_chunks_tsv_idx on public.document_chunks using gin (tsv);

create table public.assistant_conversations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references public.users(id) on delete cascade,
  title           text not null,
  created_at      timestamptz not null default now()
);
create index assistant_conversations_user_idx on public.assistant_conversations (user_id, created_at desc);

create table public.assistant_messages (
  id              bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.assistant_conversations(id) on delete cascade,
  role            text not null check (role in ('user', 'assistant')),
  content         text not null,
  citations       jsonb not null default '[]'::jsonb,
  mode            text,                                   -- 'llm', 'extractive' or 'none'
  created_at      timestamptz not null default now()
);
create index assistant_messages_conv_idx on public.assistant_messages (conversation_id, id);

create table public.retrieval_logs (
  id              bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid references public.users(id) on delete set null,
  query           text not null,
  chunk_ids       bigint[] not null default '{}',
  fact_count      int not null default 0,
  mode            text,
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Usage and plan limits
-- ---------------------------------------------------------------------------
create or replace function app.usage_this_month(p_org uuid, p_metric text) returns int
language sql stable security definer set search_path = public as $$
  select coalesce(sum(quantity), 0)::int from usage_records
   where organization_id = p_org and metric = p_metric and recorded_at >= date_trunc('month', now())
$$;

create or replace function app.enforce_document_limit() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_limit int := app.plan_limit(new.organization_id, 'max_documents');
begin
  if v_limit is not null and (select count(*) from documents where organization_id = new.organization_id) >= v_limit then
    raise exception 'Plan limit reached: this plan allows % documents', v_limit using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger documents_enforce_limit before insert on public.documents
  for each row execute function app.enforce_document_limit();

-- ---------------------------------------------------------------------------
-- Documents: register, add chunks, finish (run as the caller; RLS applies)
-- ---------------------------------------------------------------------------
create or replace function public.document_create(
  p_title text, p_category text, p_access text, p_storage_path text, p_mime text, p_source text default null, p_version text default null
) returns uuid
language sql set search_path = public as $$
  insert into documents (organization_id, title, category, access_level, storage_path, mime_type, source, version, uploaded_by)
  values (app.org_id(), trim(p_title), coalesce(nullif(trim(p_category), ''), 'Other'), p_access, p_storage_path, p_mime,
          nullif(trim(p_source), ''), nullif(trim(p_version), ''), auth.uid())
  returning id
$$;

create or replace function public.document_finish(p_document uuid, p_chunks jsonb, p_page_count int, p_error text default null)
returns int
language plpgsql set search_path = public as $$
declare
  n int := 0;
begin
  if p_error is null then
    insert into document_chunks (organization_id, document_id, page_number, chunk_index, content)
    select app.org_id(), p_document, (c ->> 'page')::int, (row_number() over ())::int, c ->> 'content'
      from jsonb_array_elements(p_chunks) c
     where length(trim(c ->> 'content')) > 0;
    get diagnostics n = row_count;
  end if;
  update documents
     set status = case when p_error is null and n > 0 then 'ready' else 'failed' end,
         error = case when p_error is not null then p_error when n = 0 then 'No text could be read from this file' end,
         page_count = p_page_count, chunk_count = n
   where id = p_document;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- Search: chunks that contain at least half of the question's distinct terms,
-- best coverage first. Returning nothing is a valid answer.
-- ---------------------------------------------------------------------------
create or replace function public.search_documents(p_query text, p_limit int default 6)
returns jsonb
language plpgsql stable set search_path = public as $$
declare
  v_terms text[] := tsvector_to_array(to_tsvector('english', coalesce(p_query, '')));
  v_or    tsquery;
  v_out   jsonb;
begin
  if coalesce(array_length(v_terms, 1), 0) = 0 then return '[]'::jsonb; end if;
  v_or := to_tsquery('english', (select string_agg(quote_literal(t), ' | ') from unnest(v_terms) t));

  select coalesce(jsonb_agg(to_jsonb(r) order by r.coverage desc, r.rank desc), '[]'::jsonb) into v_out
    from (
      select c.id as chunk_id, d.id as document_id, d.title, d.category, d.source, c.page_number as page,
             c.content,
             ts_headline('english', c.content, v_or, 'MaxWords=45, MinWords=20, StartSel=«, StopSel=», MaxFragments=1') as excerpt,
             round((cov.hits::numeric / array_length(v_terms, 1)), 2) as coverage,
             ts_rank_cd(c.tsv, v_or, 32) as rank
        from document_chunks c
        join documents d on d.id = c.document_id and d.status = 'ready'
       cross join lateral (
         select count(*) as hits from unnest(v_terms) t where c.tsv @@ to_tsquery('english', quote_literal(t))
       ) cov
       where c.tsv @@ v_or
         and cov.hits >= greatest(1, ceil(array_length(v_terms, 1) / 2.0))
       order by cov.hits desc, ts_rank_cd(c.tsv, v_or, 32) desc
       limit least(greatest(p_limit, 1), 12)
    ) r;
  return v_out;
end $$;

-- ---------------------------------------------------------------------------
-- Facts: published figures relevant to a question. Fixed, parameterised lookups:
-- the question only selects topics, wards and a year; it is never turned into SQL.
-- ---------------------------------------------------------------------------
create or replace function public.assistant_facts(p_question text)
returns jsonb
language plpgsql stable set search_path = public as $$
declare
  q        text := lower(coalesce(p_question, ''));
  v_wards  uuid[];
  v_year   int := (select (regexp_match(q, '\m(20[0-3][0-9])\M'))[1]::int);
  v_out    jsonb;
begin
  -- wards named as "ward K/W", "K/W ward" or "wards A and B"
  select array_agg(z.id) into v_wards
    from city_zones z
   where q ~ ('(\mward[s]?\s+([a-z/]+\s*(,|and|&)\s*)*' || lower(replace(z.code, '/', '\/')) || '\M)|(\m' || lower(replace(z.code, '/', '\/')) || '\s+ward\M)');

  with topics(metric, category, label, unit, pattern, forecastable) as (values
    ('complaints_registered', null, 'Complaints registered', '', '(complaint|grievance|issue)', true),
    ('complaints_closed', null, 'Complaints closed', '', '(closed|closure|resolved|unresolved|pending)', false),
    ('avg_days_to_close', null, 'Average days to close a complaint', 'days', '(days|slow|fast|time|resolution|resolve|delay)', false),
    ('complaints_registered', 'Solid Waste Management (SWM)', 'Solid-waste complaints registered', '', '(waste|garbage|swm)', true),
    ('complaints_registered', 'Drainage', 'Drainage complaints registered', '', '(drain|flood|waterlog)', true),
    ('waste_tonnes_per_day', null, 'Waste lifted', 'tonnes/day', '(waste|garbage|tonn|swm)', true),
    ('waste_per_capita', null, 'Waste per person', 'kg/day', '(waste|garbage|per person|per capita)', false),
    ('water_supply_hours', null, 'Water supply', 'hours/day', '(water|supply)', false),
    ('water_unfit_samples_pct', null, 'Drinking-water samples found unfit', '%', '(water|unfit|contamin|drinking)', false),
    ('water_supply_mld', null, 'Water supplied to the city', 'MLD', '(water|supply|demand|shortfall|shortage)', false),
    ('water_demand_mld', null, 'Water demand', 'MLD', '(water|demand|shortfall|shortage)', false),
    ('water_gap_mld', null, 'Water supply shortfall', 'MLD', '(water|shortfall|shortage|gap|deficit)', false),
    ('bwg_not_processing_on_site_pct', null, 'Bulk waste generators not processing on site', '%', '(bulk|societ|compost|processing)', false)
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
  forecasts as (
    select format('Forecast of %s, %s, %s: %s (80%% range %s to %s). A model estimate, not a published figure.',
                  lower(w.label), coalesce('Ward ' || z.code, 'Mumbai'), f.year,
                  to_char(f.value, 'FM99,99,99,990'), to_char(f.lower, 'FM99,99,99,990'), to_char(f.upper, 'FM99,99,99,990'))
             || case when w.unit = '' then '' else ' ' || w.unit end as text,
           case f.metric when 'waste_tonnes_per_day' then 'CivicOS waste forecast model' else 'CivicOS complaint forecast model' end as source, 4 as ord
      from wanted w
      join ml_forecasts f on f.metric = w.metric and f.category is not distinct from w.category and f.month is null
      left join city_zones z on z.id = f.zone_id
     where w.forecastable and q ~ '(forecast|predict|next year|2026|expect|will)'
       and (f.zone_id is null or f.zone_id = any (coalesce(v_wards, '{}')))
  ),
  air as (       -- monthly air-quality forecast, asked about air and the future
    select format('Forecast average AQI, Mumbai, %s %s: %s (80%% range %s to %s). A model estimate, not a published figure.',
                  to_char(make_date(f.year, f.month, 1), 'FMMonth'), f.year, f.value::int, f.lower::int, f.upper::int) as text,
           'CivicOS air-quality forecast model' as source, 4 as ord, f.month as k
      from ml_forecasts f
     where f.metric = 'aqi_monthly_avg' and q ~ '(air|aqi|pollut|smog)' and q ~ '(forecast|predict|next year|2026|expect|will)'
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
    union all select text, source, ord, 0 from forecasts
    union all select text, source, ord, k from air
    union all select text, source, ord, 0 from health
  )
  select coalesce(jsonb_agg(jsonb_build_object('text', text, 'source', source) order by ord, k, text), '[]'::jsonb) into v_out
    from (select * from allf order by ord, k, text limit 24) t;
  return v_out;
end $$;

-- ---------------------------------------------------------------------------
-- One retrieval call per question: checks the plan's monthly limit, records the
-- query, and returns facts and document excerpts.
-- ---------------------------------------------------------------------------
create or replace function public.assistant_retrieve(p_question text)
returns jsonb
language plpgsql set search_path = public as $$
declare
  v_org   uuid := app.org_id();
  v_limit int  := app.plan_limit(v_org, 'ai_queries_per_month');
  v_used  int  := app.usage_this_month(v_org, 'ai_query');
begin
  if v_org is null then raise exception 'Not signed in' using errcode = 'P0001'; end if;
  if v_limit is not null and v_used >= v_limit then
    return jsonb_build_object('allowed', false, 'limit', v_limit, 'used', v_used);
  end if;
  insert into usage_records (organization_id, user_id, metric) values (v_org, auth.uid(), 'ai_query');
  return jsonb_build_object(
    'allowed', true, 'limit', v_limit, 'used', v_used + 1,
    'facts', public.assistant_facts(p_question),
    'chunks', public.search_documents(p_question, 6));
end $$;

create or replace function public.assistant_save(
  p_conversation uuid, p_question text, p_answer text, p_citations jsonb, p_chunk_ids bigint[], p_fact_count int, p_mode text
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
  insert into assistant_messages (organization_id, conversation_id, role, content, citations, mode)
  values (app.org_id(), v_conv, 'assistant', p_answer, coalesce(p_citations, '[]'::jsonb), p_mode);
  insert into retrieval_logs (organization_id, user_id, query, chunk_ids, fact_count, mode)
  values (app.org_id(), auth.uid(), p_question, coalesce(p_chunk_ids, '{}'), coalesce(p_fact_count, 0), p_mode);
  return v_conv;
end $$;

create or replace function public.assistant_history(p_conversation uuid default null)
returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object(
    'conversations', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'title', title, 'created_at', created_at) order by created_at desc)
        from (select * from assistant_conversations where user_id = auth.uid() order by created_at desc limit 20) c), '[]'::jsonb),
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object('role', role, 'content', content, 'citations', citations, 'mode', mode, 'at', created_at) order by id)
        from assistant_messages where conversation_id = p_conversation), '[]'::jsonb),
    'documents', (select count(*) from documents where status = 'ready'),
    'usage', jsonb_build_object('used', app.usage_this_month(app.org_id(), 'ai_query'),
                                'limit', app.plan_limit(app.org_id(), 'ai_queries_per_month')))
$$;

-- ---------------------------------------------------------------------------
-- Grants and RLS
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on public.documents, public.document_chunks, public.assistant_conversations,
  public.assistant_messages, public.retrieval_logs to authenticated;
grant all on public.documents, public.document_chunks, public.assistant_conversations, public.assistant_messages,
  public.retrieval_logs to service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;
revoke all on public.documents, public.document_chunks, public.assistant_conversations, public.assistant_messages,
  public.retrieval_logs from anon;

-- documents: staff manage; residents read only documents marked public
alter table public.documents enable row level security;
create policy documents_read on public.documents for select to authenticated using (
  (select app.is_super_admin())
  or (organization_id = (select app.org_id())
      and ((select app.role()) in ('city_admin', 'dept_officer', 'field_worker') or access_level = 'public')));
create policy documents_insert on public.documents for insert to authenticated with check (
  organization_id = (select app.org_id()) and (select app.role()) in ('city_admin', 'dept_officer'));
create policy documents_update on public.documents for update to authenticated
  using (organization_id = (select app.org_id()) and (select app.role()) in ('city_admin', 'dept_officer'))
  with check (organization_id = (select app.org_id()) and (select app.role()) in ('city_admin', 'dept_officer'));
create policy documents_delete on public.documents for delete to authenticated using (
  organization_id = (select app.org_id()) and (select app.role()) in ('city_admin', 'dept_officer'));

-- chunks are visible exactly when their document is
alter table public.document_chunks enable row level security;
create policy chunks_read on public.document_chunks for select to authenticated using (
  organization_id = (select app.org_id()) and exists (select 1 from public.documents d where d.id = document_chunks.document_id));
create policy chunks_insert on public.document_chunks for insert to authenticated with check (
  organization_id = (select app.org_id()) and (select app.role()) in ('city_admin', 'dept_officer')
  and exists (select 1 from public.documents d where d.id = document_chunks.document_id));

-- conversations, messages and logs are private to the person who asked
alter table public.assistant_conversations enable row level security;
create policy conv_own on public.assistant_conversations for all to authenticated
  using (organization_id = (select app.org_id()) and user_id = (select auth.uid()))
  with check (organization_id = (select app.org_id()) and user_id = (select auth.uid()));
alter table public.assistant_messages enable row level security;
create policy msg_own on public.assistant_messages for all to authenticated
  using (organization_id = (select app.org_id())
         and exists (select 1 from public.assistant_conversations c where c.id = assistant_messages.conversation_id))
  with check (organization_id = (select app.org_id())
         and exists (select 1 from public.assistant_conversations c where c.id = assistant_messages.conversation_id));
alter table public.retrieval_logs enable row level security;
create policy logs_own on public.retrieval_logs for all to authenticated
  using (organization_id = (select app.org_id()) and (user_id = (select auth.uid()) or (select app.role()) = 'city_admin'))
  with check (organization_id = (select app.org_id()) and user_id = (select auth.uid()));

do $$
declare f text;
begin
  foreach f in array array[
    'public.document_create(text, text, text, text, text, text, text)', 'public.document_finish(uuid, jsonb, int, text)',
    'public.search_documents(text, int)', 'public.assistant_facts(text)', 'public.assistant_retrieve(text)',
    'public.assistant_save(uuid, text, text, jsonb, bigint[], int, text)', 'public.assistant_history(uuid)']
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
