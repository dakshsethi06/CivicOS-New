# CivicOS

**Intelligence for Better Cities.** Urban intelligence platform, built for Mumbai as a multi-tenant SaaS.

**Real data only.** Every figure in the app comes from a published source and carries the report, table and
page it was read from. CivicOS does not generate, simulate or estimate data.

| Data | Source |
| --- | --- |
| Ward boundaries (24 BMC wards) | DataMeet, Municipal Spatial Data (CC BY-SA 2.5 India) |
| Complaints by ward and issue, 2016 to 2025; closure and days to close | Praja Foundation reports (BMC data via RTI) |
| Waste lifted by ward, 2021 to 2025 | Praja Foundation 2026 report |
| Monthly AQI 2016 to 2025; air-quality days by ward, 2025 | Praja Foundation 2026 report |
| Water supply hours by ward (2024), water quality (2020 to 2024), water balance | Praja Foundation 2025 report |

`data/mumbai/README.md` explains how the dataset was extracted and checked, and its known quirks.

```
apps/web/              Next.js (App Router, TypeScript, Tailwind) -> Vercel
supabase/migrations/   Postgres schema, RLS policies, Mumbai data  -> Supabase
supabase/tests/        Tenant-isolation and data tests (run in CI)
data/mumbai/           Extraction scripts, extracted tables, and model training (ml/)
```

## Setup

### 1. Supabase

1. Create a project at supabase.com.
2. Open **SQL Editor**, paste the whole of `supabase/all_migrations.sql`, and run it once.
   If you ran an earlier version of the migrations in this project, run `supabase/reset.sql` first, and delete
   any users under **Authentication -> Users** so you can register again with the same email.
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

### 3. Deploy to Vercel

1. Push this repo to GitHub.
2. Import it in Vercel and set **Root Directory** to `apps/web`.
3. Add the same three environment variables.

## What the app shows

- **Dashboard:** KPIs, complaints per year, issue breakdown, registered against closed, ward comparisons,
  monthly AQI, waste, water, and a prototype City Health Index. Filters: year, ward, complaint issue.
- **City Map:** the 24 wards shaded by any of nine published figures or by model ward group.
- **Water:** supply hours by ward, supply zones by hours, water-quality tests, yield against supply, water complaints.
- **Waste:** tonnage by ward and year, waste per person, solid-waste complaints and days to close, bulk generators.
- **Analytics:** ward clustering and 2026 forecasts of complaints, waste lifted (city and ward) and monthly air quality,
  each tested on past years (details in `data/mumbai/ml/README.md`), a scatter
  plot of any two ward indicators, their correlation matrix, and a flow chart of complaints by issue into closed / not closed.
- **Complaints:** real reports from real users (see below).
- **Assistant:** answers questions from uploaded documents and the published figures, with citations (see below).
- **Insights:** rule-based recommendations with their evidence; officers accept, reject, assign or complete them.
- **Settings:** team, plan and usage, API keys, audit log. **Platform** (super admin only): all municipalities.

Every chart has a "View data" table with a **Download CSV** button, and a source line. Dashboard and Analytics
have a **Print or save as PDF** button. Where a figure is not published for the selected
year or ward, the app says so and leaves it blank. Traffic is off: no ward-level traffic data is published.

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
Postgres full-text search. Scanned PDFs without a text layer cannot be read (no OCR).

For each question the assistant retrieves matching passages and matching published figures, and answers only from
those. Every statement carries a marker (`[F1]` figure, `[D2]` document page) that opens the source. If nothing
relevant is found it says: "The available documents and published figures do not establish this."

- **Without a language model** (default) the answer is the retrieved figures and passages themselves.
- **With one**, set `LLM_API_KEY` and `LLM_MODEL` (and `LLM_BASE_URL` if not Groq) in `.env.local` and in Vercel.
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

- **Traffic:** no ward-level traffic data is published for Mumbai. Live traffic needs an API key (for example TomTom)
  and would build history only from the day collection starts.
- **Water-leak and bin-overflow prediction:** no Mumbai sensor data is published, so there is nothing real to train on.
- **Pothole detection on photos**, OCR for scanned documents, and semantic (embedding) search: retrieval is keyword-based.
- **Payments:** plan changes are test mode only. **Email invitations:** admins create staff accounts with a temporary password.
- **Department scoping:** officers see all complaints in their organization, not only their department's.
- When a user's role changes, their JWT picks it up at the next token refresh (up to an hour) or next sign-in.

## What has and has not been tested

Tested: the database (schema, tenant isolation, figures against the reports, workflows, limits) on Postgres 16 in CI;
the web app's pages, document upload and reading, the assistant, API and exports against a local stand-in for Supabase.
Not yet run against a real Supabase project: sign-up and sign-in, Storage uploads (photos, documents), and a real
language model. Check these first after setup.
