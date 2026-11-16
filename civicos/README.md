# CivicOS

**Intelligence for Better Cities.** Urban intelligence platform, built for Mumbai as a multi-tenant SaaS.

**Real data first.** Every published figure in the app comes from a published source and carries the report, table
and page it was read from. CivicOS does not generate, simulate or estimate published figures.

The one exception is clearly labelled: Mumbai publishes no pipe-network, water-meter, bin-sensor or traffic-detector
readings, so the sensor-level water, waste and traffic modules run on a **demonstration dataset** that an administrator
builds on request. It is stored apart from the published figures, flagged `is_synthetic`, and every page that shows it
says "Demo data". A city can replace it with its own feeds.

| Data | Source |
| --- | --- |
| Ward boundaries (24 BMC wards) | DataMeet, Municipal Spatial Data (CC BY-SA 2.5 India) |
| Complaints by ward and issue, 2016 to 2025; closure and days to close | Praja Foundation reports (BMC data via RTI) |
| Waste lifted by ward, 2021 to 2025 | Praja Foundation 2026 report |
| Monthly AQI 2016 to 2025; air-quality days by ward, 2025 | Praja Foundation 2026 report |
| Water supply hours by ward (2024), water quality (2020 to 2024), water balance | Praja Foundation 2025 report |

`data/mumbai/README.md` explains how the dataset was extracted and checked, and its known quirks.

```
apps/web/              Next.js (App Router, TypeScript, Tailwind)              -> Vercel
apps/api/              Python backend (FastAPI): RAG, assistant, water/waste/traffic models -> Render
supabase/migrations/   Postgres schema, RLS policies, pgvector, Mumbai data   -> Supabase
supabase/tests/        Tenant-isolation and data tests (run in CI)
data/mumbai/           Extraction scripts, extracted tables, and model training (ml/)
render.yaml            (repository root) Render Blueprint for apps/api
```

The web app reads dashboards, maps and complaints from Supabase directly, under Row Level Security. The assistant and
document ingestion go through `apps/api`, which runs every query as the signed-in user too (see `apps/api/README.md`).

## Setup

### 1. Supabase

1. Create a project at supabase.com.
2. Open **SQL Editor**, paste the whole of `supabase/all_migrations.sql`, and run it once.
   If you ran an earlier version of the migrations in this project, run `supabase/reset.sql` first, and delete
   any users under **Authentication -> Users** so you can register again with the same email.
   (`all_migrations.sql` is built from `supabase/migrations/` by `python3 supabase/build_all_migrations.py`.)
   To add the three-year forecasts to a project set up before them, without a reset, run
   `supabase/migrations/0009_mumbai_models.sql` and then `0016_three_year_forecasts.sql`; for semantic search,
   `0017_rag_vectors.sql`; for the water, waste and traffic operations modules, `0018_operations.sql`.
3. Copy the project URL, anon key and service-role key from **Project Settings -> API**.

### 2. Web app

```bash
cd apps/web
cp .env.example .env.local     # paste the three values (Windows Command Prompt: copy .env.example .env.local)
npm install
npm run dev
```

Open http://localhost:3000 and click **Register a municipality**. Leave **City dataset** on Mumbai: the wards and
all published figures load during registration, and you land on the dashboard as City Administrator.

To load or reload the dataset for an existing workspace:

```sql
select app.load_mumbai_data(id) from public.organizations;
```

### 3. API (assistant and semantic search)

See `apps/api/README.md`. In short: fill in `apps/api/.env` (Supabase connection string and keys, a Gemini API key),
run `uvicorn app.main:app` or `docker compose up`, and set `CIVICOS_API_URL=http://localhost:8000` in
`apps/web/.env.local`. Without it the assistant still works, with keyword search.

### 4. Deploy

1. Push this repo to GitHub.
2. Web: import it in Vercel, set **Root Directory** to `apps/web`, and add the same environment variables plus
   `CIVICOS_API_URL`.
3. API: in Render, New -> Blueprint -> this repository (`render.yaml`), then fill in the secret environment variables.

## What the app shows

- **Dashboard:** KPIs, complaints per year, issue breakdown, registered against closed, ward comparisons,
  monthly AQI, waste, water, and a prototype City Health Index. Filters: year, ward, complaint issue. When operations
  data exists, a separate labelled block adds water consumption, predicted infrastructure risks, collection
  efficiency, congestion and the infrastructure risk distribution.
- **City Map:** the 24 wards shaded by any of nine published figures or by model ward group, and a layer map with
  toggles for complaints (real reports), pipes by failure risk, water anomalies, bins, road congestion and incidents.
- **Water:** supply hours by ward, supply zones by hours, water-quality tests, yield against supply, water complaints,
  and forecasts to 2028 of unfit drinking-water samples (city and ward) and water supplied.
  **Network and sensors (demo):** pipe, meter and reservoir map; anomaly detection (Isolation Forest) with officer
  review; demand forecasts for 24 hours, 7 and 30 days (XGBoost, tested against naive baselines); pipe failure risk
  with each pipe's contributing factors and a calibration check; reservoir shortage risk.
- **Waste:** tonnage by ward and year, waste per person, solid-waste complaints and days to close, bulk generators.
  **Bins and routes (demo):** bin map, fill forecasts and overflow probabilities for 6, 12 and 24 hours (XGBoost,
  calibrated on a held-out week), waste generation, collection efficiency by ward, and collection routes optimised
  with OR-Tools against the fixed schedule.
- **Traffic (demo):** road network coloured by congestion now and forecast 15, 30 and 60 minutes ahead (XGBoost,
  against "no change" and "usual for the time"), peak hours, most congested roads, incident hotspots, and a what-if
  simulator (close a road, cut its capacity, add trips) using a peak-hour traffic assignment. Simulated, not measured.
- **Analytics:** ward clustering and 2026–2028 forecasts of complaints, waste lifted (city and ward) and monthly air quality,
  each tested on past years one, two and three years ahead (details in `data/mumbai/ml/README.md`), a scatter
  plot of any two ward indicators, their correlation matrix, and a flow chart of complaints by issue into closed / not closed.
- **Complaints:** real reports from real users (see below).
- **Assistant:** answers questions from uploaded documents and the published figures, with citations (see below).
- **Insights:** rule-based recommendations with their evidence; officers accept, reject, assign or complete them.
  Rules cover the published figures and the operations models (water anomalies, pipes at risk, reservoirs, bins about
  to fill, accident hotspots).
- **Settings:** team, plan and usage, API keys, audit log. **Platform** (super admin only): all municipalities.

Every chart has a "View data" table with a **Download CSV** button, and a source line. Dashboard and Analytics
have a **Print or save as PDF** button. Where a figure is not published for the selected
year or ward, the app says so and leaves it blank.

## Operations modules (water, waste, traffic)

1. Run `0018_operations.sql` and start the API (`apps/api`), with `CIVICOS_API_URL` set in the web app.
2. As City Administrator, open **Water → Network and sensors** and click **Build demo dataset**. In about a minute the
   API places pipes, meters, reservoirs, bins, trucks and roads inside the real ward boundaries, generates their
   readings (with leaks, bursts and meter faults injected so the detector can be scored), trains every model, plans
   tomorrow's collection routes and refreshes the recommendations.
3. **Retrain models** and the traffic **what-if** simulator are in the Professional plan (switch plans under Settings;
   test mode). Officers confirm or dismiss water anomalies; the decisions are kept to evaluate the detector.

Each module shows how its models were tested: the held-out period, MAE/RMSE or AUC/Brier, the baselines they are
compared with, and calibration tables where a probability is shown. Details in `apps/api/README.md`.

## Complaints

The complaint list starts empty and holds only what people submit through CivicOS.

1. A resident signs up at `/join`, picks the municipality, and reports a problem: description, optional
   category, a pin on the ward map, optional photo.
2. On submission the database **suggests** (never decides):
   - a category, from keyword matches in the description;
   - a priority: the category's default, raised one step for safety wording and for two or more open reports
     of the same kind within 150 m;
   - a possible duplicate: an open report of the same category within 150 m with similar wording;
   - a typical time to close, read from the published BMC averages (this ward and issue if published, else
     the city figure), with its source.
3. An officer reviews, confirms or changes category and priority, and assigns it to a staff member.
4. The assignee marks it in progress and then resolved; an officer verifies or reopens it.

Every step is recorded in the complaint's history. Who may do what is enforced in the database
(`complaint_action`), and a resident sees only their own complaints.

These suggestions are fixed rules, not trained models: there is no real complaint text to train on yet.
Keywords and default priorities live in `complaint_categories` and can be edited.

**Roles to try it:** register a municipality (City Administrator), add a Department Officer and a Field Worker
under **Settings -> Add a team member**, and create a resident at `/join`. Residents do not count towards
the plan's staff limit.

**Photos** go to a private Supabase Storage bucket (`complaint-photos`, created by migration 0011) and are
shown through short-lived signed URLs.

## City Health Index

A prototype composite for demonstration, not an official rating. Per ward, for 2025:

| Component | Weight | How it is scored (0 to 100) |
| --- | --- | --- |
| Complaints closed | 25% | closed / registered |
| Speed of resolution | 15% | 100 at 0 days to close, 0 at 60 days or more |
| Hours of water supply | 25% | average hours per day / 24 |
| Drinking-water quality | 15% | 100 minus 20 points per 1% of samples unfit |
| Good-air days | 20% | share of monitored days rated Good or Satisfactory |

A component with no published figure for a ward is left out and the other weights are scaled up. Weights are
per organization in `health_index_config`. The scoring rules are this project's own choices.

## Tenant isolation

Every table in `public` has Row Level Security on. Policies read `org_id` and `role` from the JWT
(`app_metadata`), which a trigger keeps in sync with `public.users`.

```sql
select app.apply_tenant_policies('public.some_table', '{city_admin,dept_officer}', '{city_admin}');
```

Run the tests against any plain Postgres 16:

```bash
createdb civicos_test
DATABASE_URL=postgresql://localhost/civicos_test supabase/tests/run_rls_test.sh shim
```

They check, as every role, that no other tenant's row is visible, that cross-tenant and privilege-escalating
writes fail, that no table has RLS off, and that the dashboard returns the figures printed in the reports.
`shim` mode stores geometry as GeoJSON text so it runs without PostGIS; it is for tests only.

## Map basemap

CARTO's dark raster tiles over OpenStreetMap data by default, with attribution on the map.
Set `NEXT_PUBLIC_MAP_STYLE_URL` to use another MapLibre style.

## Assistant and knowledge base

City Administrators and Department Officers upload PDF, DOCX, TXT or CSV files (up to 20 MB) under
**Assistant -> Manage documents**. Text is extracted page by page, split into passages and indexed with
Postgres full-text search, and, when `apps/api` is configured, with Gemini embeddings in pgvector for semantic search
(see `apps/api/README.md`). Scanned PDFs without a text layer cannot be read (no OCR).

For each question the assistant retrieves matching passages and matching published figures, and answers only from
those. Every statement carries a marker (`[F1]` figure, `[D2]` document page) that opens the source. If nothing
relevant is found it says: "The available documents and published figures do not establish this."

- **With `CIVICOS_API_URL` set**, `apps/api` answers with Gemini, choosing between documents, published figures,
  ward profiles and live complaints. This is the main path.
- **Without the API or a language model**, the answer is the retrieved figures and passages themselves.
- **Without the API but with a language model**, set `LLM_API_KEY` and `LLM_MODEL` (and `LLM_BASE_URL` if not Groq) in `.env.local` and in Vercel.
  Any OpenAI-compatible chat API works. The model sees only the retrieved sources; citations are checked in code,
  and a sentence citing a source that does not exist is removed. An answer with no valid citation is discarded.

Residents see only documents marked Public. Conversations are private to the person who asked.

## Recommendations

`app.generate_recommendations` applies six fixed rules: slow complaint closure, short water supply, unfit water
samples, forecast rise in complaints, bulk waste generators not processing on site, and overdue live complaints.
Each recommendation lists the figures it rests on with their sources, and the rule in words. They carry a
priority, not a confidence percentage, because they are rules, not statistical estimates.

## Plans, API and audit

- **Plans** (Free, Professional, Enterprise) limit staff users, documents and assistant questions per month.
  Switching plan under Settings is **test mode**: no payment provider is connected and no money is taken.
- **API keys** (City Administrator): create a key under Settings; it is shown once and stored only as a hash.

  ```bash
  curl -H "Authorization: Bearer civ_..." \
    "https://YOUR-SITE/api/v1/indicators?metric=water_supply_hours&year=2024&ward=K/W"
  ```

  Leave out `metric` to list the available metrics. 60 requests a minute per key.
- **Audit log:** changes to organizations, users, subscriptions and API keys are recorded; viewing is an Enterprise feature.
- **Platform admin:** to make yourself a super admin, run this in the SQL Editor, then sign out and in again:

  ```sql
  update public.users set role = 'super_admin' where email = 'you@example.com';
  ```

## Not built

- **Real sensor feeds:** the water, waste and traffic modules run on the demonstration dataset until a city connects
  its own meters, bin sensors and traffic detectors (or a live traffic API such as TomTom, which builds history only
  from the day collection starts).
- **Traffic microsimulation:** the what-if model is a macroscopic peak-hour assignment, not SUMO.
- **Pothole detection on photos** and OCR for scanned documents. Semantic search needs `apps/api` running; without it,
  retrieval is keyword-based.
- **Payments:** plan changes are test mode only. **Email invitations:** admins create staff accounts with a temporary password.
- **Department scoping:** officers see all complaints in their organization, not only their department's.
- When a user's role changes, their JWT picks it up at the next token refresh (up to an hour) or next sign-in.

## What has and has not been tested

Tested: the database (schema, tenant isolation, figures against the reports, workflows, limits, operations tables and
reads, recommendations) on plain Postgres; the backend's models, RAG pipeline and endpoints (pytest); the operations
jobs end to end (build dataset, train, plan routes, simulate) against that database; the web app's types, lint and
production build.
Not yet run against a real Supabase project: sign-up and sign-in, Storage uploads (photos, documents), PostGIS and
pgvector themselves (tests store geometry as GeoJSON text), a real language model, and the operations pages in a
browser. Route optimisation with OR-Tools has run only in CI; locally it used the built-in fallback solver.
