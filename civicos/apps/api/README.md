# CivicOS API (`apps/api`)

The Python backend of CivicOS (FastAPI). It owns the AI layer: retrieval-augmented generation (RAG) over each
municipality's documents, the hybrid assistant, and the water, waste and traffic models with their background jobs.

```
Browser ──► Next.js (apps/web, Vercel) ──► CivicOS API (this, Render) ──► Supabase Postgres (RLS, pgvector)
                    user's access token ─────────┘            │
                                                              └──► Gemini (embeddings, answers)
```

## How tenancy is kept

The web server forwards the signed-in user's Supabase access token. The API verifies it (the project's JWKS, or the
legacy HS256 secret) and, inside every database transaction, switches to the `authenticated` role with the user's
claims. Supabase's own REST layer works the same way. Row Level Security therefore decides every read and write.
A user of one municipality cannot retrieve another's passages, and a resident cannot retrieve staff-only documents,
whatever this code does. `supabase/tests/rls_isolation.sql` (section 5e) tests exactly that for vector search.

## RAG pipeline

| Step | Where |
| --- | --- |
| Upload (browser → private Storage bucket) | `apps/web/components/assistant/upload-form.tsx` |
| Text extraction: PDF (per page), DOCX (headings kept), TXT, CSV (rows as `column: value`) | `app/rag/extract.py` |
| Cleaning: NULs, soft hyphens, words split across lines, running headers and footers | `app/rag/extract.py` |
| Chunking: paragraph and sentence aware, ~1,100 characters, 160 overlap, never mixing two sections | `app/rag/chunking.py` |
| Metadata: page, nearest section heading, plus the document's title, category, department, version, source, access level, upload date | `document_chunks`, `documents` |
| Embeddings: `gemini-embedding-001` at 768 dimensions, document and query task types, normalised | `app/providers.py` |
| Vector store: pgvector, HNSW cosine index, one row per chunk with the model name | `document_embeddings` (migration 0017) |
| Retrieval: vector similarity fused with full-text match (reciprocal rank fusion), similarity floor | `match_document_chunks` (SQL) |
| Context, generation, citations | `app/assistant/` |

## Vector database: pgvector or Qdrant

`VECTOR_STORE=pgvector` (default) searches vectors inside Supabase, in `match_document_chunks`. `VECTOR_STORE=qdrant`
uses a separate Qdrant database (`app/rag/vectorstore.py`, over Qdrant's REST API):

1. Ingestion stores chunks and vectors in Postgres as always, then writes the same vectors to Qdrant with the
   organization, document, access level and category as payload. Postgres stays the system of record.
2. A question is embedded once; Qdrant returns the nearest chunks, **filtered to the caller's organization** (and to
   public documents for residents); Postgres full-text search returns keyword matches; the two rankings are fused
   (reciprocal rank fusion, as in the SQL path).
3. The fused chunk ids are read back through `document_chunks_by_ids` **as the signed-in user**, so Row Level Security
   drops anything the caller may not see, whatever the vector database returned (tested in `rls_isolation.sql` 5j).
4. `POST /v1/vector/sync` rebuilds an organization's points from the vectors in Postgres (no Gemini calls);
   `POST /v1/documents/{id}/forget` removes a deleted document's points.

Local Qdrant: `docker compose --profile vector up` (from `civicos/`), then `QDRANT_URL=http://qdrant:6333`.
Hosted: Qdrant Cloud's free cluster, with `QDRANT_URL` and `QDRANT_API_KEY`.

## Hybrid assistant

The model (Gemini 3.8 Flash) gets four tools and must call at least one before answering:

| Tool | Answers from |
| --- | --- |
| `search_documents` | the RAG retrieval above: policies, regulations, reports, notices |
| `city_figures` | published statistics, 2026 to 2028 forecasts, City Health Index (`assistant_facts`) |
| `ward_profile` | every published figure for one ward (`ward_stats`) |
| `live_complaints` | complaints submitted through CivicOS, as the user may see them |

Every result carries markers, `[D#]` for passages and `[F#]` for figures. The model may cite only those. Afterwards
the answer is checked: a sentence whose only citations were never retrieved is removed, an uncited answer is replaced
by the sources themselves, and if nothing relevant was retrieved the answer is *"The available documents and published
figures do not establish this."* Without `GEMINI_API_KEY` (or if Gemini fails), the assistant still answers by showing
the retrieved passages and figures, and search falls back to keywords.

## Operations models (`app/ops/`)

Mumbai publishes no sensor-level data, so these run on a demonstration dataset (`demo.py`) unless a city loads its
own readings into the same tables. The generator places pipes, meters, reservoirs, bins, trucks and a road graph
inside the real ward boundaries and draws readings from stated rules: daily and weekly demand curves in Mumbai time,
bins filling and being emptied on schedule (with some missed pickups), road speeds from a speed-flow curve with rain
and incidents. Leaks, bursts and meter faults are injected and their truth kept, so the detector can be scored.

| Model | Method | Tested by |
| --- | --- | --- |
| Water anomalies | Isolation Forest (`iforest.py`, NumPy) on flow, pressure, consumption, hour, weekday and each meter's 4-week hour-of-week baseline; top 1% Suspicious, top 0.4% High; three-hour persistence rule | Faults found, alert precision, hour precision/recall against the injected faults |
| Water demand | XGBoost: direct 24-hour model (hourly) and recursive daily model (7 and 30 days) | MAE/RMSE on held-out recent data against same-hour-yesterday, same-hour-last-week, last-week-repeated and 4-week-average |
| Pipe failure risk | XGBoost classifier on age, material, diameter, length, past failures, pressure variability, recent anomalies; per-pipe factor contributions | 5-fold cross-validated AUC and Brier score against failure rate by age; calibration table |
| Reservoir shortage | Water balance: last week's inflow against forecast demand, 7 days ahead | Stated rule (not learned) |
| Bin fill and overflow | XGBoost regression (fill in 2–24 h) and classifier (95% within 6/12/24 h, if not collected) | Held-out last week: fill MAE against straight-line, AUC, Brier, precision/recall, calibration |
| Collection routes | Capacitated vehicle routing, OR-Tools guided local search (savings + 2-opt fallback) | Distance and bins covered against the fixed schedule |
| Congestion | XGBoost, one model per horizon (15/30/60 min) | MAE/RMSE on the last two days against "no change" and "usual for the time" |
| What-if traffic | Gravity-model peak-hour demand, BPR link times, user-equilibrium assignment by successive averages | Simulated; calibrated so the busiest tenth of roads run near capacity |

Jobs (`jobs.py`) read their inputs back from the database, so the same code serves demo and connected data, and run
as the organization's administrator under RLS (`db.as_org`). `runner.py` records each run in `ops_jobs`; with
`REDIS_URL` the Celery worker (`app/worker.py`) runs them and retrains every organization nightly, otherwise the API
runs them in a background task. Each run is stored in `model_runs` with its metrics, which the pages show.

## Endpoints

| Method and path | Who | What |
| --- | --- | --- |
| `GET /health` | anyone | status, database reachability, configured models |
| `POST /v1/assistant/ask` `{question, conversation_id?}` | signed-in | answer, citations, tools used; counts against the plan's monthly AI limit |
| `POST /v1/documents/{id}/ingest` | officers | extract, chunk, embed and store an uploaded document |
| `POST /v1/documents/reindex` | officers | embed passages that have no vector yet (documents added before semantic search) |
| `GET /v1/documents/search?q=` | signed-in | retrieval only, to inspect what the assistant would see |
| `GET /v1/me` | signed-in | the caller and their organization |
| `POST /v1/complaints/{id}/analyse` | anyone who can see the complaint | category by meaning, duplicates within 150 m, photo check; recorded as suggestions |
| `POST /v1/complaints/embed-missing` | officers | embed older complaints so they can be matched as duplicates |
| `POST /v1/vector/sync` | officers | rebuild this organization's points in Qdrant from Postgres (VECTOR_STORE=qdrant) |
| `POST /v1/documents/{id}/forget` | officers | remove a deleted document's points from Qdrant |
| `POST /v1/ops/demo` | City Administrator | replace operations data with the demonstration dataset and train every model (202, background) |
| `POST /v1/ops/train` | City Administrator, Professional plan | retrain on the latest readings, re-plan routes, refresh recommendations |
| `POST /v1/traffic/simulate` `{road_id, action, capacity_factor?, extra_trips?}` | officers, Professional plan | what-if: `close`, `reduce_capacity` or `add_demand`; saved to `traffic_simulations` |

Interactive docs at `/docs` when running.

## Database migrations (Alembic)

The schema is the SQL in `supabase/migrations`. Alembic runs those files in order, one revision each, and records what
a database has in its own `alembic` schema (not `public`, which Supabase exposes through its REST API).

```bash
cd apps/api
alembic current                 # what this database has
alembic stamp 0018              # a database set up by hand in the SQL Editor up to 0018
alembic upgrade head            # apply the rest
python migrations/sync_sql.py   # after adding a new SQL file: create its revision
```

## Run locally

```bash
cd apps/api
cp .env.example .env            # fill in DATABASE_URL, SUPABASE_URL, SUPABASE_ANON_KEY, GEMINI_API_KEY
python -m venv .venv && . .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt
uvicorn app.main:app --reload   # http://localhost:8000/docs
pytest                          # 38 tests: RAG pipeline, citations, assistant routing, auth, operations models
```

Or with Docker, from `civicos/`: `docker compose up --build` (add `--profile jobs` for Redis, the Celery worker and
the nightly schedule).

Then add `CIVICOS_API_URL=http://localhost:8000` to `apps/web/.env.local`, restart the web app, and on
**Assistant → Documents** click **Index for semantic search** for documents uploaded earlier.

## Deploy on Render

`render.yaml` at the repository root is a Render Blueprint (New → Blueprint). Set `DATABASE_URL` to Supabase's
**pooler** connection string, because Render has no IPv6 and cannot reach the direct host. Also set `SUPABASE_URL`,
`SUPABASE_ANON_KEY` and `GEMINI_API_KEY`. Then set `CIVICOS_API_URL` in Vercel to the Render URL. A free Render
instance sleeps when idle, so the first question after a pause takes longer. Without a worker, training runs inside
the API instance (about a minute for the demonstration dataset); `render.yaml` has a commented, paid worker and Redis
block for queued jobs and nightly retraining.
