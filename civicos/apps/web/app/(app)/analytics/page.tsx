import type { Metadata } from "next";
import Link from "next/link";
import { MapPinned } from "lucide-react";
import { AqiForecast } from "@/components/analytics/aqi-forecast";
import { ForecastChart } from "@/components/analytics/forecast-chart";
import { GroupProfile } from "@/components/analytics/group-profile";
import { ComplaintFlow, WardScatter } from "@/components/analytics/explore";
import { SeriesPicker } from "@/components/analytics/series-picker";
import { PrintButton } from "@/components/print-button";
import { DIVERGING } from "@/lib/chart-colors";
import type { DashboardData } from "@/lib/dashboard";
import { ChartCard } from "@/components/dashboard/charts";
import { requireSession } from "@/lib/auth";
import { GROUP_COLORS } from "@/lib/chart-colors";
import { fmt } from "@/lib/dashboard";
import { parseFilters } from "@/lib/filters";
import type { ForecastExtras, MlData } from "@/lib/models";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Analytics" };

const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export default async function AnalyticsPage({ searchParams }: PageProps<"/analytics">) {
  await requireSession();
  const filters = parseFilters(await searchParams);
  const supabase = await createClient();

  const [{ data, error }, zones, dash, extrasRes] = await Promise.all([
    supabase.rpc("ml_data", { p_zone: filters.zone, p_issue: filters.issue }),
    supabase.from("city_zones").select("id, name").order("code"),
    supabase.rpc("dashboard_data", { p_year: null, p_zone: null, p_issue: null }),
    supabase.rpc("forecast_extras", { p_zone: filters.zone }),
  ]);
  const ex = extrasRes.data as ForecastExtras | null;
  const dd = dash.data as DashboardData | null;
  const d = data as MlData | null;

  const header = (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Ward patterns and forecasts</h1>
        <p className="mt-1 text-sm text-muted">Models trained on the published figures: ward groups and forecasts of complaints, air quality and waste, each tested on past years.</p>
      </div>
      <PrintButton />
    </div>
  );

  if (error || !d) {
    return (
      <div className="mx-auto max-w-6xl space-y-6">
        {header}
        <p className="rounded-xl border border-line bg-panel p-6 text-sm text-muted">The models query failed: {error?.message ?? "no data returned"}.</p>
      </div>
    );
  }
  const cm = d.models.clustering;
  const fm = d.models.forecast;
  if (!cm || !fm) {
    return (
      <div className="mx-auto max-w-6xl space-y-6">
        {header}
        <p className="rounded-xl border border-line bg-panel p-6 text-sm text-muted">No models have been loaded for this workspace. They load with the Mumbai dataset.</p>
      </div>
    );
  }

  const features = cm.params.features;
  const groups = [...cm.params.groups].sort((a, b) => a.cluster - b.cluster);
  const cityMean = Object.fromEntries(features.map((f) => [f.key, d.wards.reduce((a, w) => a + (w.features[f.key] ?? 0), 0) / d.wards.length]));
  const silhouette = cm.metrics.silhouette as number;

  // Pearson correlation between every pair of ward indicators (24 wards)
  const cols = features.map((f) => d.wards.map((w) => w.features[f.key]));
  const pearson = (a: number[], b: number[]) => {
    const n = a.length, ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
    return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
  };
  const r: Record<string, Record<string, number>> = {};
  features.forEach((fa, i) => { r[fa.key] = {}; features.forEach((fb, j) => { r[fa.key][fb.key] = pearson(cols[i], cols[j]); }); });
  const shortLabel = (l: string) => l.replace(/ \(\d{4}\)/, "").replace(/, %/, " %");
  const mix = (t: number) => {
    const to = t >= 0 ? [42, 120, 214] : [227, 73, 72], from = [240, 239, 236], k = Math.min(1, Math.abs(t));
    return `rgb(${from.map((c, i) => Math.round(c + k * (to[i] - c))).join(",")})`;
  };

  // complaint flow for the latest year: the eight largest issues, the rest grouped
  const issues = (dd?.issues ?? []).filter((x) => x.closed != null);
  const top = issues.slice(0, 8), rest = issues.slice(8);
  const flows = [
    ...top.map((x) => ({ issue: x.issue, closed: x.closed!, open: Math.max(0, x.registered - x.closed!) })),
    ...(rest.length ? [{ issue: `Other issues (${rest.length})`, closed: rest.reduce((a, x) => a + x.closed!, 0), open: rest.reduce((a, x) => a + Math.max(0, x.registered - x.closed!), 0) }] : []),
  ];

  const fc = d.forecast;
  const fam = fc ? fm.params.families[fc.family] : null;
  const last = d.history.at(-1);
  const scope = d.zone ? d.zone.name : "Whole city";
  const families = Object.entries(fm.params.families);
  const methodOrder = ["naive", "mean3", "trend"].filter((m) => m in fm.params.methods);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {header}

      {/* ---------------- ward groups ---------------- */}
      <ChartCard
        title={`${cm.name}: ${groups.length} groups of wards`}
        question="Which wards look alike once complaints, resolution, water and waste are taken together?"
        note={`${cm.description} Silhouette score ${silhouette.toFixed(2)} (from −1 to 1; above 0.25 is weak but real structure). Solutions with 3 to 5 groups scored lower or left a group with a single ward.`}
        source={`Method: ${cm.method}. Trained on ${cm.trained_on}.`}
        table={{
          columns: ["Ward", "Group", ...features.map((f) => f.label)],
          rows: d.wards.map((w) => [w.name, w.cluster, ...features.map((f) => w.features[f.key])]),
        }}
      >
        <div className="mb-5 grid gap-3 sm:grid-cols-2">
          {groups.map((g) => (
            <div key={g.cluster} className="rounded-lg border border-line p-4">
              <p className="flex items-center gap-2 text-sm font-medium text-ink">
                <span className="inline-block size-3 rounded-sm" style={{ background: GROUP_COLORS[g.cluster - 1] }} />
                Group {g.cluster}: {g.label}
              </p>
              <p className="mt-2 flex flex-wrap gap-1.5">
                {g.wards.map((w) => (
                  <span key={w} className="rounded border border-line px-1.5 py-0.5 font-mono text-xs text-muted">{w}</span>
                ))}
              </p>
            </div>
          ))}
        </div>
        <GroupProfile groups={groups} features={features} cityMean={cityMean} />
        <Link href="/map" className="mt-4 inline-flex items-center gap-1.5 text-xs text-accent hover:underline">
          <MapPinned className="size-3.5" aria-hidden="true" />
          See the groups on the map (shade wards by “Ward group”)
        </Link>
      </ChartCard>

      {/* ---------------- forecasts ---------------- */}
      <ChartCard
        title={`Complaints registered, 2016 to 2025, and the 2026 forecast: ${scope}${d.issue ? `, ${d.issue}` : ""}`}
        question="How many complaints should the city plan for next year?"
        note={
          fc && fam
            ? `Method: ${fm.params.methods[fc.method]}. It had the lowest error when tested on ${fam.backtest_years.join(", ")} across ${fam.series === 1 ? "this one series" : `${fam.series} series in this family`} (${fam.label.toLowerCase()})${fam.series === 1 ? ", only four test forecasts, so treat the choice as tentative" : ""}. In that test, 80% of forecasts were within ±${fam.interval_pct}% of the real figure, which sets the range shown.`
            : undefined
        }
        source={`Trained on ${fm.trained_on}.`}
        table={{ columns: ["Year", "Complaints"], rows: [...d.history.map((h) => [h.year, h.value] as (string | number)[]), ...(fc ? [[`${fc.year} (forecast)`, `${fmt.int(fc.value)} (${fmt.int(fc.lower)} to ${fmt.int(fc.upper)})`]] : [])] }}
      >
        <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
          <SeriesPicker zone={filters.zone} issue={filters.issue} wards={zones.data ?? []} cityIssues={d.issues_with_forecasts} wardIssues={d.ward_issues} />
          {fc ? (
            <div className="text-right">
              <p className="text-xs text-muted">2026 forecast</p>
              <p className="text-2xl font-semibold tabular-nums">{fmt.int(fc.value)}</p>
              <p className="text-xs tabular-nums text-muted">
                80% range {fmt.int(fc.lower)} to {fmt.int(fc.upper)}
                {last ? ` · ${last.year}: ${fmt.int(last.value)}` : ""}
              </p>
            </div>
          ) : null}
        </div>
        {d.history.length ? (
          <ForecastChart history={d.history} forecast={fc} />
        ) : (
          <p className="py-10 text-center text-sm text-faint">No published series for this ward and issue.</p>
        )}
      </ChartCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard
          title="How accurate were the forecasts?"
          question="Does the chosen method beat simply repeating last year's figure?"
          note="Average error as a share of the real figure (MAPE), forecasting each of 2022 to 2025 from the years before it. Lower is better. Where last year's value wins, it is the method used: a fancier method would be worse."
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[460px] text-left text-xs tabular-nums">
              <thead className="text-muted">
                <tr>
                  <th className="py-2 pr-3 font-medium">Series</th>
                  {methodOrder.map((k) => (
                    <th key={k} className="py-2 pr-3 text-right font-medium" title={fm.params.methods[k]}>
                      {k === "naive" ? "Last year" : k === "mean3" ? "3-yr avg" : "Trend"}
                    </th>
                  ))}
                  <th className="py-2 text-right font-medium">80% range</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {families.map(([key, f]) => (
                  <tr key={key}>
                    <td className="py-2 pr-3 text-ink">
                      {f.label}
                      <span className="block text-faint">{f.series} series × {f.backtest_years.length} test years</span>
                    </td>
                    {methodOrder.map((m) => (
                      <td key={m} className={`py-2 pr-3 text-right ${m === f.chosen ? "font-semibold text-accent" : "text-muted"}`}>
                        {f.mape_pct[m].toFixed(1)}%
                      </td>
                    ))}
                    <td className="py-2 text-right text-muted">±{f.interval_pct}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted">The chosen method for each series is highlighted.</p>
        </ChartCard>

        <ChartCard
          title={`2026 forecast by ward${d.issue ? `, ${d.issue}` : ""}`}
          question="Which wards should expect more complaints next year?"
          note={d.ward_forecasts.length ? undefined : "Ward forecasts exist for all issues together, solid waste and drainage only."}
        >
          {d.ward_forecasts.length ? (
            <div className="max-h-[420px] overflow-auto">
              <table className="w-full text-left text-xs tabular-nums">
                <thead className="sticky top-0 bg-panel text-muted">
                  <tr>
                    <th className="py-2 pr-3 font-medium">Ward</th>
                    <th className="py-2 pr-3 text-right font-medium">2025</th>
                    <th className="py-2 pr-3 text-right font-medium">2026 forecast</th>
                    <th className="py-2 pr-3 text-right font-medium">80% range</th>
                    <th className="py-2 text-right font-medium">Change</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {d.ward_forecasts.map((w) => {
                    const ch = w.last ? (100 * (w.value - w.last)) / w.last : null;
                    return (
                      <tr key={w.code}>
                        <td className="py-1.5 pr-3 text-ink">{w.name}</td>
                        <td className="py-1.5 pr-3 text-right text-muted">{fmt.int(w.last)}</td>
                        <td className="py-1.5 pr-3 text-right font-medium text-ink">{fmt.int(w.value)}</td>
                        <td className="py-1.5 pr-3 text-right text-muted">{fmt.int(w.lower)} to {fmt.int(w.upper)}</td>
                        <td className="py-1.5 text-right text-muted">{ch == null ? "—" : `${ch > 0 ? "+" : ""}${ch.toFixed(0)}%`}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </ChartCard>
      </div>

      {/* ---------------- air quality forecast ---------------- */}
      {ex?.aqi.model && ex.aqi.forecast.length ? (() => {
        const am = ex.aqi.model, ap = am.params;
        const fcs = ex.aqi.forecast;
        const worst = fcs.reduce((a, b) => (b.value > a.value ? b : a));
        const best = fcs.reduce((a, b) => (b.value < a.value ? b : a));
        const above = fcs.filter((f) => f.value > 100);
        const prev = ex.aqi.history.filter((h) => h.year === fcs[0].year - 1);
        const prevAvg = prev.reduce((a, h) => a + h.value, 0) / (prev.length || 1);
        const avg = fcs.reduce((a, f) => a + f.value, 0) / fcs.length;
        const src = ex.aqi.source;
        const aOrder = ["snaive", "smean3", "climatology", "profile"].filter((k) => k in ap.methods);
        return (
          <div className="grid gap-4 lg:grid-cols-3">
            <ChartCard
              className="lg:col-span-2"
              title={`${am.name}: Mumbai's monthly AQI, ${fcs[0].year}`}
              question="Which months of next year will have the worst air?"
              note={`Method: ${ap.methods[ap.chosen]}. 80% of test forecasts were within ±${ap.interval_pct}% of the published figure, which sets the range. The history includes 2020, the lockdown year.`}
              source={`${src ? `Source: ${src.publisher}, ${src.table}, p. ${src.page}. ` : ""}Trained on ${am.trained_on}.`}
              table={{ columns: ["Month", "Forecast AQI", "80% range low", "80% range high"], rows: fcs.map((f) => [`${MONTHS_LONG[f.month - 1]} ${f.year}`, f.value, f.lower ?? null, f.upper ?? null]) }}
            >
              <AqiForecast history={ex.aqi.history} forecast={fcs} params={ap} />
            </ChartCard>

            <div className="stagger grid content-start gap-4">
              <div className="card-hover rounded-xl border border-line bg-panel p-4">
                <p className="text-xs text-muted">Worst month forecast</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{MONTHS_LONG[worst.month - 1]} · {worst.value}</p>
                <p className="mt-1 text-xs text-faint">80% range {worst.lower} to {worst.upper}</p>
              </div>
              <div className="card-hover rounded-xl border border-line bg-panel p-4">
                <p className="text-xs text-muted">Cleanest month forecast</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{MONTHS_LONG[best.month - 1]} · {best.value}</p>
                <p className="mt-1 text-xs text-faint">Monsoon rain clears the air</p>
              </div>
              <div className="card-hover rounded-xl border border-line bg-panel p-4">
                <p className="text-xs text-muted">Months above 100</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{above.length} <span className="text-sm font-normal text-muted">of 12</span></p>
                <p className="mt-1 text-xs text-faint">{above.map((f) => MONTHS_SHORT[f.month - 1]).join(", ") || "None"}</p>
              </div>
              <div className="card-hover rounded-xl border border-line bg-panel p-4">
                <p className="text-xs text-muted">Year average</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{avg.toFixed(0)}</p>
                <p className="mt-1 text-xs text-faint">{fcs[0].year - 1}: {prevAvg.toFixed(0)} published</p>
              </div>
            </div>

            <ChartCard
              className="lg:col-span-3"
              title="How accurate was each air-quality method?"
              question="Does following the seasonal cycle beat repeating last year's month?"
              note={`Each method forecast all twelve months of ${ap.backtest_years.join(", ")} using only the years before. Error is the average miss as a share of the real figure (MAPE) and in AQI points (MAE). Lower is better.`}
            >
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-left text-xs tabular-nums">
                  <thead className="text-muted">
                    <tr>
                      <th className="py-2 pr-3 font-medium">Method</th>
                      <th className="py-2 pr-3 text-right font-medium">Average miss, %</th>
                      <th className="py-2 text-right font-medium">Average miss, AQI points</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {aOrder.map((k) => (
                      <tr key={k} className={k === ap.chosen ? "bg-accent-soft/60" : ""}>
                        <td className={`py-2 pr-3 ${k === ap.chosen ? "font-semibold text-accent" : "text-ink"}`}>
                          {ap.methods[k]}{k === ap.chosen ? " (used)" : k === ap.naive ? " (baseline)" : ""}
                        </td>
                        <td className={`py-2 pr-3 text-right ${k === ap.chosen ? "font-semibold text-accent" : "text-muted"}`}>{ap.mape_pct[k].toFixed(1)}%</td>
                        <td className={`py-2 text-right ${k === ap.chosen ? "font-semibold text-accent" : "text-muted"}`}>{ap.mae[k].toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-xs text-muted">
                The chosen method misses by {((100 * (ap.mape_pct[ap.naive] - ap.mape_pct[ap.chosen])) / ap.mape_pct[ap.naive]).toFixed(0)}% less than repeating last year&apos;s month. Use the “Test” tabs on the chart to see each test year.
              </p>
            </ChartCard>
          </div>
        );
      })() : null}

      {/* ---------------- waste forecast ---------------- */}
      {ex?.waste.model && ex.waste.forecast ? (() => {
        const wm = ex.waste.model, wf = ex.waste.forecast;
        const wfam = wm.params.families[wf.family];
        const wlast = ex.waste.history[ex.waste.history.length - 1];
        const wardFam = wm.params.families.ward_waste;
        const src = ex.waste.source;
        const wscope = ex.zone ? ex.zone.name : "Whole city";
        return (
          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard
              title={`${wm.name}: waste lifted per day, ${wscope}`}
              question="How much waste will need collecting each day next year?"
              note={wfam ? `Method: ${wm.params.methods[wf.method]}, the lowest error when tested on ${wfam.backtest_years.join(" and ")} (${wfam.mape_pct[wfam.chosen].toFixed(1)}% average miss). Only five years are published, so the test is short; the 80% range is ±${wfam.interval_pct}%.${wf.family === "city_waste" ? " The city range uses the wider ward-level error because one series gives only two test errors." : ""} Choose a ward with the ward filter in the complaint forecast above.` : undefined}
              source={`${src ? `Source: ${src.publisher}, ${src.table}, p. ${src.page}. ` : ""}Trained on ${wm.trained_on}.`}
              table={{ columns: ["Year", "Tonnes per day"], rows: [...ex.waste.history.map((h) => [h.year, h.value] as (string | number)[]), [`${wf.year} (forecast)`, `${fmt.int(wf.value)} (${fmt.int(wf.lower)} to ${fmt.int(wf.upper)})`]] }}
            >
              <div className="mb-3 flex items-end justify-between gap-4">
                <p className="text-xs text-muted">Tonnes per day</p>
                <div className="text-right">
                  <p className="text-xs text-muted">{wf.year} forecast</p>
                  <p className="text-2xl font-semibold tabular-nums">{fmt.int(wf.value)} <span className="text-sm font-normal text-muted">t/day</span></p>
                  <p className="text-xs tabular-nums text-muted">80% range {fmt.int(wf.lower)} to {fmt.int(wf.upper)}{wlast ? ` · ${wlast.year}: ${fmt.int(wlast.value)}` : ""}</p>
                </div>
              </div>
              <ForecastChart history={ex.waste.history} forecast={wf} />
            </ChartCard>

            <ChartCard
              title={`${wf.year} waste forecast by ward`}
              question="How much should each ward plan to collect?"
              note={wardFam?.chosen === "naive" ? `For single wards, repeating last year's figure was the most accurate method (${wardFam.mape_pct.naive.toFixed(1)}% average miss, against ${wardFam.mape_pct.trend.toFixed(1)}% for the trend), so each ward's forecast equals its ${wlast?.year ?? "latest"} figure. The useful part is the range: plan for the high end.` : undefined}
              table={{ columns: ["Ward", "Last year", "Forecast", "Low", "High"], rows: ex.waste.ward_forecasts.map((w) => [w.code, w.last, w.value, w.lower, w.upper]) }}
            >
              <div className="max-h-[420px] overflow-auto">
                <table className="w-full text-left text-xs tabular-nums">
                  <thead className="sticky top-0 bg-panel text-muted">
                    <tr>
                      <th className="py-2 pr-3 font-medium">Ward</th>
                      <th className="py-2 pr-3 text-right font-medium">{wlast?.year ?? "Last"}</th>
                      <th className="py-2 pr-3 text-right font-medium">{wf.year} forecast</th>
                      <th className="py-2 text-right font-medium">80% range</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {ex.waste.ward_forecasts.map((w) => (
                      <tr key={w.code} className={ex.zone?.code === w.code ? "bg-accent-soft/60" : ""}>
                        <td className="py-1.5 pr-3 text-ink">{w.name}</td>
                        <td className="py-1.5 pr-3 text-right text-muted">{fmt.int(w.last)}</td>
                        <td className="py-1.5 pr-3 text-right font-medium text-ink">{fmt.int(w.value)}</td>
                        <td className="py-1.5 text-right text-muted">{fmt.int(w.lower)} to {fmt.int(w.upper)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </ChartCard>
          </div>
        );
      })() : null}

      {/* ---------------- exploration ---------------- */}
      <ChartCard
        title="How ward indicators relate to each other"
        question="Do wards with more of one thing tend to have more of another?"
        note="Each dot is a ward. With 24 wards, a pattern here is a lead to investigate, not proof that one thing causes the other."
        source={`Indicators as used by the ward-group model. Trained on ${cm.trained_on}.`}
        table={{ columns: ["Ward", "Group", ...features.map((f) => f.label)], rows: d.wards.map((w) => [w.code, w.cluster, ...features.map((f) => w.features[f.key])]) }}
      >
        <WardScatter wards={d.wards} features={features} r={r} />
      </ChartCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard
          title="Correlation between ward indicators"
          question="Which indicators move together across the 24 wards?"
          note="Pearson correlation, from −1 (move in opposite directions) to +1 (move together). Values near 0 mean no linear relationship."
          table={{ columns: ["", ...features.map((f) => shortLabel(f.label))], rows: features.map((fa) => [shortLabel(fa.label), ...features.map((fb) => Number(r[fa.key][fb.key].toFixed(2)))]) }}
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[460px] border-separate border-spacing-[2px] text-center text-[11px] tabular-nums">
              <thead>
                <tr>
                  <th />
                  {features.map((f, i) => <th key={f.key} className="px-1 pb-1 font-medium text-muted" title={f.label}>{i + 1}</th>)}
                </tr>
              </thead>
              <tbody>
                {features.map((fa, i) => (
                  <tr key={fa.key}>
                    <th className="whitespace-nowrap pr-2 text-left font-normal text-muted">{i + 1}. {shortLabel(fa.label)}</th>
                    {features.map((fb) => {
                      const v = r[fa.key][fb.key];
                      return (
                        <td key={fb.key} className="rounded py-1.5 transition-transform hover:scale-110" style={{ background: fa.key === fb.key ? "var(--color-raised)" : mix(v), color: fa.key !== fb.key && Math.abs(v) > 0.45 ? "#ffffff" : "var(--color-ink)" }} title={`${fa.label} × ${fb.label}: r = ${v.toFixed(2)}`}>
                          {fa.key === fb.key ? "–" : v.toFixed(2)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
            <span className="inline-flex items-center gap-1.5"><span className="inline-block size-2.5 rounded-sm" style={{ background: DIVERGING.neg }} />Negative</span>
            <span className="inline-flex items-center gap-1.5"><span className="inline-block size-2.5 rounded-sm bg-raised" />None</span>
            <span className="inline-flex items-center gap-1.5"><span className="inline-block size-2.5 rounded-sm" style={{ background: DIVERGING.pos }} />Positive</span>
            <span>Stronger colour = stronger relationship.</span>
          </p>
        </ChartCard>

        <ChartCard
          title={`Where ${dd?.meta.year ?? ""}'s complaints went, by issue`}
          question="Which issues account for the complaints left open?"
          note="Band width is the number of complaints. City-wide."
          source={dd ? "Source: Praja Foundation 2026 report, Table 2, p. 12." : undefined}
          table={{ columns: ["Issue", "Closed", "Not closed"], rows: flows.map((f) => [f.issue, f.closed, f.open]) }}
        >
          {flows.length ? <ComplaintFlow flows={flows} /> : <p className="py-10 text-center text-sm text-faint">Closure figures are not published for the latest year.</p>}
        </ChartCard>
      </div>

      <section className="rounded-xl border border-line bg-panel p-5 text-xs leading-relaxed text-muted">
        <h2 className="text-sm font-medium text-ink">Limits of these models</h2>
        <ul className="mt-2 list-disc space-y-1 pl-4">
          <li>Each complaint series has ten yearly figures, and 2020 and 2021 are pandemic years. That is too little history for anything more complex than the three methods compared here.</li>
          <li>Waste has only five published years per ward, so its methods were tested on two years. Air quality has 120 months, but only city-wide: there is no monthly AQI by ward to forecast.</li>
          <li>The air-quality forecast follows the usual seasonal cycle. It cannot foresee an unusual year (a weak monsoon, a festival season with heavy firecracker use, a construction boom).</li>
          <li>The forecasts assume next year behaves like the recent past. A one-off event, such as ward S&apos;s jump from 6,221 complaints in 2024 to 13,116 in 2025, will not be predicted and is only partly carried forward.</li>
          <li>Ward groups describe 2025 (water 2024) and depend on which indicators are included. They show patterns, not causes.</li>
          <li>All models were trained on {fm.trained_at} from the published figures only. Retrain them when a new annual report is loaded.</li>
        </ul>
      </section>
    </div>
  );
}
