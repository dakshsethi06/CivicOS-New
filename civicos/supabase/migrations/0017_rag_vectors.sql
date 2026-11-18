-- CivicOS 0017: semantic retrieval for the assistant (RAG).
-- The backend (apps/api) extracts and chunks each uploaded document, embeds every chunk and stores the vector here.
-- Retrieval fuses vector similarity with the existing full-text match (reciprocal rank fusion), so exact terms
-- (a rule number, a ward code) and paraphrases both find the right passage.
-- Every function runs as the caller (SECURITY INVOKER) and the backend connects as the signed-in user, so RLS keeps
-- each municipality's documents, and staff-only documents, out of everyone else's results.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.document_embeddings (
  chunk_id        bigint primary key references public.document_chunks(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  document_id     uuid not null references public.documents(id) on delete cascade,
  model           text not null,                         -- e.g. gemini-embedding-001@768; a model change means re-embedding
  embedding       vector(768) not null,
  created_at      timestamptz not null default now()
);
create index document_embeddings_doc_idx on public.document_embeddings (document_id);
create index document_embeddings_hnsw on public.document_embeddings using hnsw (embedding vector_cosine_ops);

alter table public.document_chunks add column if not exists section text;         -- nearest heading above the chunk
alter table public.documents add column if not exists embedding_model text;
alter table public.documents add column if not exists processed_at timestamptz;
alter table public.retrieval_logs add column if not exists tools jsonb not null default '[]'::jsonb;  -- which tools answered

grant select, insert, delete on public.document_embeddings to authenticated;
grant all on public.document_embeddings to service_role;
revoke all on public.document_embeddings from anon;

-- embeddings are visible exactly when their document is (the subquery runs under the caller's RLS)
alter table public.document_embeddings enable row level security;
create policy embeddings_read on public.document_embeddings for select to authenticated using (
  organization_id = (select app.org_id()) and exists (select 1 from public.documents d where d.id = document_embeddings.document_id));
create policy embeddings_insert on public.document_embeddings for insert to authenticated with check (
  organization_id = (select app.org_id()) and (select app.role()) in ('city_admin', 'dept_officer')
  and exists (select 1 from public.documents d where d.id = document_embeddings.document_id));
create policy embeddings_delete on public.document_embeddings for delete to authenticated using (
  organization_id = (select app.org_id()) and (select app.role()) in ('city_admin', 'dept_officer'));

-- re-processing a document replaces its chunks
create policy chunks_delete on public.document_chunks for delete to authenticated using (
  organization_id = (select app.org_id()) and (select app.role()) in ('city_admin', 'dept_officer'));

-- ---------------------------------------------------------------------------
-- Hybrid retrieval. p_embedding null = keyword search only (no embedding provider configured).
-- Vector hits below p_min_similarity are dropped unless the passage also matches the words of the question.
-- ---------------------------------------------------------------------------
create or replace function public.match_document_chunks(
  p_query          text,
  p_embedding      vector(768) default null,
  p_limit          int default 8,
  p_min_similarity float8 default 0,
  p_category       text default null
) returns jsonb
language plpgsql stable set search_path = public, extensions as $$
declare
  v_terms text[] := tsvector_to_array(to_tsvector('english', coalesce(p_query, '')));
  v_or    tsquery;
  v_out   jsonb;
begin
  if coalesce(array_length(v_terms, 1), 0) > 0 then
    v_or := to_tsquery('english', (select string_agg(quote_literal(t), ' | ') from unnest(v_terms) t));
  end if;

  with vec_raw as (
    select e.chunk_id, e.embedding <=> p_embedding as distance
      from document_embeddings e
      join documents d on d.id = e.document_id and d.status = 'ready'
     where p_embedding is not null and (p_category is null or d.category = p_category)
     order by e.embedding <=> p_embedding
     limit 40
  ),
  vec as (
    select chunk_id, 1 - distance as similarity, row_number() over (order by distance) as rnk from vec_raw
  ),
  kw as (
    select c.id as chunk_id, ts_rank_cd(c.tsv, v_or, 32) as krank,
           row_number() over (order by ts_rank_cd(c.tsv, v_or, 32) desc) as rnk
      from document_chunks c
      join documents d on d.id = c.document_id and d.status = 'ready'
     where v_or is not null and c.tsv @@ v_or and (p_category is null or d.category = p_category)
     order by ts_rank_cd(c.tsv, v_or, 32) desc
     limit 40
  ),
  fused as (     -- reciprocal rank fusion, k = 60
    select coalesce(vec.chunk_id, kw.chunk_id) as chunk_id,
           coalesce(1.0 / (60 + vec.rnk), 0) + coalesce(1.0 / (60 + kw.rnk), 0) as score,
           vec.similarity, kw.krank
      from vec full outer join kw on kw.chunk_id = vec.chunk_id
  ),
  top as (
    select f.*
      from fused f
     where f.krank is not null or f.similarity >= p_min_similarity
     order by f.score desc
     limit least(greatest(p_limit, 1), 12)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'chunk_id', c.id, 'document_id', d.id, 'title', d.title, 'category', d.category, 'source', d.source,
           'version', d.version, 'department', dep.name, 'uploaded_at', d.created_at, 'access_level', d.access_level,
           'page', c.page_number, 'section', c.section, 'content', c.content,
           'excerpt', case when v_or is not null and c.tsv @@ v_or
                           then ts_headline('english', c.content, v_or, 'MaxWords=45, MinWords=20, StartSel=«, StopSel=», MaxFragments=1')
                           else left(c.content, 320) end,
           'score', round(t.score::numeric, 5), 'similarity', round(t.similarity::numeric, 4), 'keyword_rank', round(t.krank::numeric, 4))
         order by t.score desc), '[]'::jsonb)
    into v_out
    from top t
    join document_chunks c on c.id = t.chunk_id
    join documents d on d.id = c.document_id
    left join departments dep on dep.id = d.department_id;
  return v_out;
end $$;

-- ---------------------------------------------------------------------------
-- Assistant quota: checks the plan's monthly limit and records one question. Called once per question.
-- ---------------------------------------------------------------------------
create or replace function public.assistant_quota()
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
  return jsonb_build_object('allowed', true, 'limit', v_limit, 'used', v_used + 1);
end $$;

-- ---------------------------------------------------------------------------
-- Save a question and its answer; now also records which tools the assistant used.
-- ---------------------------------------------------------------------------
drop function if exists public.assistant_save(uuid, text, text, jsonb, bigint[], int, text);
create or replace function public.assistant_save(
  p_conversation uuid, p_question text, p_answer text, p_citations jsonb, p_chunk_ids bigint[], p_fact_count int, p_mode text,
  p_tools jsonb default '[]'::jsonb
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
  insert into retrieval_logs (organization_id, user_id, query, chunk_ids, fact_count, mode, tools)
  values (app.org_id(), auth.uid(), p_question, coalesce(p_chunk_ids, '{}'), coalesce(p_fact_count, 0), p_mode, coalesce(p_tools, '[]'::jsonb));
  return v_conv;
end $$;

-- ---------------------------------------------------------------------------
-- Live CivicOS complaints for the assistant, as the caller sees them (RLS: residents see only their own).
-- ---------------------------------------------------------------------------
create or replace function public.complaint_summary(p_ward text default null)
returns jsonb
language sql stable set search_path = public, extensions as $$
  with c as (
    select c.status, cc.name as category, z.code as ward, c.created_at, c.resolved_at
      from complaints c
      left join complaint_categories cc on cc.id = c.category_id
      left join city_zones z on z.id = c.zone_id
     where p_ward is null or upper(z.code) = upper(p_ward)
  )
  select jsonb_build_object(
    'ward', upper(p_ward),
    'total', (select count(*) from c),
    'open', (select count(*) from c where resolved_at is null),
    'by_status', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from c group by status) t), '{}'::jsonb),
    'by_category', coalesce((select jsonb_object_agg(coalesce(category, 'Uncategorised'), n) from (select category, count(*) n from c group by category) t), '{}'::jsonb),
    'open_by_ward', coalesce((select jsonb_object_agg(coalesce(ward, 'No ward'), n)
                                from (select ward, count(*) n from c where resolved_at is null group by ward order by count(*) desc limit 10) t), '{}'::jsonb),
    'oldest_open', (select min(created_at) from c where resolved_at is null))
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.match_document_chunks(text, vector(768), int, float8, text)', 'public.assistant_quota()',
    'public.assistant_save(uuid, text, text, jsonb, bigint[], int, text, jsonb)', 'public.complaint_summary(text)']
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
