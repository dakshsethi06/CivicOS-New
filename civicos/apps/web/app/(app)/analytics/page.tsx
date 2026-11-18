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
import { methodsByYear, type ForecastExtras, type MlData, type MoreForecasts, type WardForecast, type YearRange } from "@/lib/models";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Analytics" };

const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026 to 2028" */
const spanOf = (years: number[]) => (years.length > 1 ? `${years[0]} to ${years.at(-1)}` : `${years[0] ?? ""}`);
/** "±14.2% for 2026, ±22% for 2027 and ±22% for 2028" */
const rangesByYear = (byH: Record<string, number> | undefined, first: number, fallback: number) => {
  const parts = Object.entries(byH ?? { "1": fallback }).sort(([a], [b]) => Number(a) - Number(b))
    .map(([h, q]) => `±${q}% for ${first + Number(h) - 1}`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
};

/** Forecast figures for the next few years, side by side, nearest first. */
function YearStats({ forecasts, last, unit }: { forecasts: YearRange[]; last?: { year: number; value: number }; unit?: string }) {
  return (
    <div className="flex flex-wrap justify-end gap-x-6 gap-y-2 text-right">
      {forecasts.map((f) => (
        <div key={f.year}>
          <p className="text-xs text-muted">{f.year} forecast</p>
          <p className="text-2xl font-semibold tabular-nums">{fmt.int(f.value)}{unit ? <span className="text-sm font-normal text-muted"> {unit}</span> : null}</p>
          <p className="text-xs tabular-nums text-muted">80% range {fmt.int(f.lower)} to {fmt.int(f.upper)}</p>
        </div>
      ))}
      {last ? <p className="basis-full text-xs tabular-nums text-faint">{last.year} published: {fmt.int(last.value)}</p> : null}
    </div>
  );
}

/** One row per ward: latest published figure, each forecast year (range on hover), and the change to the last year. */
function WardYearsTable({ rows, highlight }: { rows: WardForecast[]; highlight?: string | null }) {
  const years = rows[0]?.years.map((y) => y.year) ?? [];
  const lastYear = rows.find((r) => r.last_year != null)?.last_year;
  return (
    <div className="max-h-[420px] overflow-auto">
      <table className="w-full text-left text-xs tabular-nums">
        <thead className="sticky top-0 bg-panel text-muted">
          <tr>
            <th className="py-2 pr-3 font-medium">Ward</th>
            <th className="py-2 pr-3 text-right font-medium">{lastYear ?? "Last"}</th>
            {years.map((y) => <th key={y} className="py-2 pr-3 text-right font-medium">{y}</th>)}
            <th className="py-2 text-right font-medium">Change to {years.at(-1)}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((w) => {
            const end = w.years.at(-1);
            const ch = w.last && end ? (100 * (end.value - w.last)) / w.last : null;
            return (
              <tr key={w.code} className={highlight === w.code ? "bg-accent-soft/60" : ""}>
                <td className="py-1.5 pr-3 text-ink">{w.name}</td>
                <td className="py-1.5 pr-3 text-right text-muted">{fmt.int(w.last)}</td>
                {w.years.map((y, i) => (
                  <td key={y.year} className={`py-1.5 pr-3 text-right ${i === 0 ? "font-medium text-ink" : "text-ink"}`} title={`80% range ${fmt.int(y.lower)} to ${fmt.int(y.upper)}`}>
                    {fmt.int(y.value)}
                  </td>
                ))}
                <td className="py-1.5 text-right text-muted">{ch == null ? "—" : `${ch > 0 ? "+" : ""}${ch.toFixed(0)}%`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const wardTableData = (rows: WardForecast[]) => {
  const years = rows[0]?.years.map((y) => y.year) ?? [];
  return {
    columns: ["Ward", `Published ${rows[0]?.last_year ?? ""}`.trim(), ...years.flatMap((y) => [`${y} forecast`, `${y} low`, `${y} high`])],
    rows: rows.map((w) => [w.code, w.last, ...w.years.flatMap((y) => [y.value, y.lower, y.upper])]),
  };
};

export default async function AnalyticsPage({ searchParams }: PageProps<"/analytics">) {
  await requireSession();
  const filters = parseFilters(await searchParams);
  const supabase = await createClient();

  const [{ data, error }, zones, dash, extrasRes, moreRes] = await Promise.all([
    supabase.rpc("ml_data", { p_zone: filters.zone, p_issue: filters.issue }),
    supabase.from("city_zones").select("id, name").order("code"),
    supabase.rpc("dashboard_data", { p_year: null, p_zone: null, p_issue: null }),
    supabase.rpc("forecast_extras", { p_zone: filters.zone }),
    supabase.rpc("forecast_more", { p_zone: filters.zone }),     // migration 0023; null before it runs
  ]);
  const more = moreRes.data as MoreForecasts | null;
  const ex = extrasRes.data as ForecastExtras | null;
  const dd = dash.data as DashboardData | null;
  const d = data as MlData | null;

  const header = (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Ward patterns and forecasts</h1>
        <p className="mt-1 text-sm text-muted">Models trained on the published figures: ward groups and three-year forecasts of complaints, how fast they are closed, air quality and waste, each tested on past years.</p>
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

  const fcs = d.forecasts ?? [];
  const fc = fcs[0] ?? null;
  const fYears = fcs.map((f) => f.year);
  const fam = fc ? fm.params.families[fc.family] : null;
  const last = d.history.at(-1);
  const scope = d.zone ? d.zone.name : "Whole city";
  const families = Object.entries(fm.params.families);
  const methodOrder = ["naive", "mean3", "trend"].filter((m) => m in fm.params.methods);
  const methodLabel = (k: string) => (k === "naive" ? "Last year" : k === "mean3" ? "3-yr avg" : "Trend");
  const allYears = fm.params.forecast_years ?? fYears;

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

      {/* ---------------- complaint forecasts ---------------- */}
      <ChartCard
        title={`Complaints registered, ${d.history[0]?.year ?? ""} to ${last?.year ?? ""}, and forecasts for ${spanOf(fYears)}: ${scope}${d.issue ? `, ${d.issue}` : ""}`}
        question="How many complaints should the city plan for over the next three years?"
        note={
          fc && fam
            ? `Methods: ${methodsByYear(fam.chosen_by_horizon, fc.year, fam.chosen)}. Each had the lowest error at that distance when ${fam.backtest_years.join(", ")} were forecast from 1, 2 and 3 years earlier, across ${fam.series === 1 ? "this one series" : `${fam.series} series in this family`} (${fam.label.toLowerCase()})${fam.series === 1 ? ", only four test forecasts per distance, so treat the choice as tentative" : ""}. In those tests 80% of forecasts were within ${rangesByYear(fam.interval_pct_by_horizon, fc.year, fam.interval_pct)} of the real figure, which sets the ranges shown.`
            : undefined
        }
        source={`Trained on ${fm.trained_on}.`}
        table={{ columns: ["Year", "Complaints"], rows: [...d.history.map((h) => [h.year, h.value] as (string | number)[]), ...fcs.map((f) => [`${f.year} (forecast)`, `${fmt.int(f.value)} (${fmt.int(f.lower)} to ${fmt.int(f.upper)})`])] }}
      >
        <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
          <SeriesPicker zone={filters.zone} issue={filters.issue} wards={zones.data ?? []} cityIssues={d.issues_with_forecasts} wardIssues={d.ward_issues} />
          {fcs.length ? <YearStats forecasts={fcs} last={last} /> : null}
        </div>
        {d.history.length ? (
          <ForecastChart history={d.history} forecasts={fcs} />
        ) : (
          <p className="py-10 text-center text-sm text-faint">No published series for this ward and issue.</p>
        )}
      </ChartCard>

      {more?.closure?.model && more.closure.days.forecasts.length ? <ClosureForecasts more={more} scope={scope} /> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard
          title="How accurate were the forecasts?"
          question="Does the chosen method beat simply repeating last year's figure, and how fast does accuracy fall with distance?"
          note="Average error as a share of the real figure (MAPE), forecasting each of 2022 to 2025 one year ahead from the years before it. Lower is better. The right-hand columns repeat the test two and three years ahead for the method used in those years, and give each year's 80% range."
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-xs tabular-nums">
              <thead className="text-muted">
                <tr>
                  <th className="py-2 pr-3 font-medium">Series</th>
                  {methodOrder.map((k) => (
                    <th key={k} className="py-2 pr-3 text-right font-medium" title={fm.params.methods[k]}>{methodLabel(k)}</th>
                  ))}
                  <th className="py-2 pr-3 text-right font-medium">2 / 3 yrs ahead</th>
                  <th className="py-2 text-right font-medium">80% range by year</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {families.map(([key, f]) => {
                  const byH = f.chosen_by_horizon ?? {};
                  const ahead = ["2", "3"].map((h) => (byH[h] && f.mape_pct_by_horizon?.[h] ? `${f.mape_pct_by_horizon[h][byH[h]].toFixed(1)}%` : "—"));
                  const ranges = Object.values(f.interval_pct_by_horizon ?? { "1": f.interval_pct });
                  return (
                    <tr key={key}>
                      <td className="py-2 pr-3 text-ink">
                        {f.label}
                        <span className="block text-faint">{f.series} series × {f.backtest_years.length} test years</span>
                        {f.chosen_by_horizon ? <span className="block text-faint">Used: {methodsByYear(f.chosen_by_horizon, allYears[0], f.chosen)}</span> : null}
                      </td>
                      {methodOrder.map((m) => (
                        <td key={m} className={`py-2 pr-3 text-right ${m === f.chosen ? "font-semibold text-accent" : "text-muted"}`}>
                          {f.mape_pct[m].toFixed(1)}%
                        </td>
                      ))}
                      <td className="py-2 pr-3 text-right text-muted">{ahead.join(" / ")}</td>
                      <td className="py-2 text-right text-muted">{ranges.map((q) => `±${q}%`).join(" / ")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted">The method used one year ahead is highlighted. A straight-line trend often wins one year ahead and then drifts, so further years may use a steadier method.</p>
        </ChartCard>

        <ChartCard
          title={`Forecast by ward, ${spanOf(allYears)}${d.issue ? `, ${d.issue}` : ""}`}
          question="Which wards should expect more complaints in the next three years?"
          note={d.ward_forecasts.length ? "Hover a figure for its 80% range. Change compares the last forecast year with the latest published year." : "Ward forecasts exist for all issues together, solid waste and drainage only."}
          table={d.ward_forecasts.length ? wardTableData(d.ward_forecasts) : undefined}
        >
          {d.ward_forecasts.length ? <WardYearsTable rows={d.ward_forecasts} highlight={d.zone?.code} /> : null}
        </ChartCard>
      </div>

      {/* ---------------- air quality forecast ---------------- */}
      {ex?.aqi.model && ex.aqi.forecast.length ? (() => {
        const am = ex.aqi.model, ap = am.params;
        const all = ex.aqi.forecast;
        const years = [...new Set(all.map((f) => f.year))].sort((a, b) => a - b);
        const next = all.filter((f) => f.year === years[0]);
        const worst = next.reduce((a, b) => (b.value > a.value ? b : a));
        const best = next.reduce((a, b) => (b.value < a.value ? b : a));
        const above = next.filter((f) => f.value > 100);
        const prev = ex.aqi.history.filter((h) => h.year === years[0] - 1);
        const prevAvg = prev.reduce((a, h) => a + h.value, 0) / (prev.length || 1);
        const avgOf = (y: number) => { const m = all.filter((f) => f.year === y); return m.reduce((a, f) => a + f.value, 0) / (m.length || 1); };
        const src = ex.aqi.source;
        const aOrder = ["snaive", "smean3", "climatology", "profile"].filter((k) => k in ap.methods);
        const horizons = Object.keys(ap.mape_pct_by_horizon ?? { "1": ap.mape_pct }).sort();
        const chosenAt = (h: string) => ap.chosen_by_horizon?.[h] ?? ap.chosen;
        return (
          <div className="grid gap-4 lg:grid-cols-3">
            <ChartCard
              className="lg:col-span-2"
              title={`${am.name}: Mumbai's monthly AQI, ${spanOf(years)}`}
              question="Which months of the next three years will have the worst air?"
              note={`Methods: ${methodsByYear(ap.chosen_by_horizon, years[0], ap.chosen)}. Each held up best at that distance in tests on ${ap.backtest_years.join(", ")}. 80% of those test forecasts were within ${rangesByYear(ap.interval_pct_by_horizon, years[0], ap.interval_pct)} of the published figure, which sets the ranges. The history includes 2020, the lockdown year.`}
              source={`${src ? `Source: ${src.publisher}, ${src.table}, p. ${src.page}. ` : ""}Trained on ${am.trained_on}.`}
              table={{ columns: ["Month", "Forecast AQI", "80% range low", "80% range high"], rows: all.map((f) => [`${MONTHS_LONG[f.month - 1]} ${f.year}`, f.value, f.lower ?? null, f.upper ?? null]) }}
            >
              <AqiForecast history={ex.aqi.history} forecast={all} params={ap} />
            </ChartCard>

            <div className="stagger grid content-start gap-4">
              <div className="card-hover rounded-xl border border-line bg-panel p-4">
                <p className="text-xs text-muted">Worst month forecast, {years[0]}</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{MONTHS_LONG[worst.month - 1]} · {worst.value}</p>
                <p className="mt-1 text-xs text-faint">80% range {worst.lower} to {worst.upper}</p>
              </div>
              <div className="card-hover rounded-xl border border-line bg-panel p-4">
                <p className="text-xs text-muted">Cleanest month forecast, {years[0]}</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{MONTHS_LONG[best.month - 1]} · {best.value}</p>
                <p className="mt-1 text-xs text-faint">Monsoon rain clears the air</p>
              </div>
              <div className="card-hover rounded-xl border border-line bg-panel p-4">
                <p className="text-xs text-muted">Months above 100, {years[0]}</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{above.length} <span className="text-sm font-normal text-muted">of 12</span></p>
                <p className="mt-1 text-xs text-faint">{above.map((f) => MONTHS_SHORT[f.month - 1]).join(", ") || "None"}</p>
              </div>
              <div className="card-hover rounded-xl border border-line bg-panel p-4">
                <p className="text-xs text-muted">Year average forecast</p>
                <div className="mt-1 flex flex-wrap gap-x-4">
                  {years.map((y) => (
                    <p key={y} className="tabular-nums"><span className="text-2xl font-semibold">{avgOf(y).toFixed(0)}</span> <span className="text-xs text-muted">{y}</span></p>
                  ))}
                </div>
                <p className="mt-1 text-xs text-faint">{years[0] - 1}: {prevAvg.toFixed(0)} published</p>
              </div>
            </div>

            <ChartCard
              className="lg:col-span-3"
              title="How accurate was each air-quality method?"
              question="Does following the seasonal cycle beat repeating last year's month, and which method holds up further ahead?"
              note={`Each method forecast all twelve months of ${ap.backtest_years.join(", ")} using only the years up to 1, 2 or 3 years before. Error is the average miss as a share of the real figure (MAPE); the AQI-points column is one year ahead. Lower is better. The method used for each distance is highlighted.`}
            >
              <div className="overflow-x-auto">
                <table className="w-full min-w-[620px] text-left text-xs tabular-nums">
                  <thead className="text-muted">
                    <tr>
                      <th className="py-2 pr-3 font-medium">Method</th>
                      {horizons.map((h) => (
                        <th key={h} className="py-2 pr-3 text-right font-medium">{h === "1" ? "1 year ahead" : `${h} years ahead`}{` (${years[0] + Number(h) - 1})`}</th>
                      ))}
                      <th className="py-2 text-right font-medium">Average miss, AQI points</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {aOrder.map((k) => (
                      <tr key={k}>
                        <td className="py-2 pr-3 text-ink">{ap.methods[k]}{k === ap.naive ? " (baseline)" : ""}</td>
                        {horizons.map((h) => {
                          const v = ap.mape_pct_by_horizon?.[h]?.[k] ?? ap.mape_pct[k];
                          const used = chosenAt(h) === k;
                          return <td key={h} className={`py-2 pr-3 text-right ${used ? "font-semibold text-accent" : "text-muted"}`}>{v.toFixed(1)}%{used ? " ✓" : ""}</td>;
                        })}
                        <td className={`py-2 text-right ${k === ap.chosen ? "font-semibold text-accent" : "text-muted"}`}>{ap.mae[k].toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-xs text-muted">
                One year ahead, the chosen method misses by {((100 * (ap.mape_pct[ap.naive] - ap.mape_pct[ap.chosen])) / ap.mape_pct[ap.naive]).toFixed(0)}% less than repeating last year&apos;s month. Use the “Test” tabs on the chart to see each test year.
              </p>
            </ChartCard>
          </div>
        );
      })() : null}

      {/* ---------------- waste forecast ---------------- */}
      {ex?.waste.model && ex.waste.forecasts?.length ? (() => {
        const wm = ex.waste.model, wfs = ex.waste.forecasts, wf = wfs[0];
        const wfam = wm.params.families[wf.family];
        const wlast = ex.waste.history[ex.waste.history.length - 1];
        const wardFam = wm.params.families.ward_waste;
        const src = ex.waste.source;
        const wscope = ex.zone ? ex.zone.name : "Whole city";
        const wYears = wfs.map((f) => f.year);
        return (
          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard
              title={`${wm.name}: waste lifted per day, ${wscope}, to ${wYears.at(-1)}`}
              question="How much waste will need collecting each day over the next three years?"
              note={wfam ? `Method: ${methodsByYear(wfam.chosen_by_horizon, wf.year, wfam.chosen)}, the lowest error when tested one year ahead on ${wfam.backtest_years.join(" and ")} (${wfam.mape_pct[wfam.chosen].toFixed(1)}% average miss). Only five years are published, so 2027 and 2028 could not be tested: their ranges are the one-year range widened with distance (${rangesByYear(wfam.interval_pct_by_horizon, wf.year, wfam.interval_pct)}).${wf.family === "city_waste" ? " The city range uses the wider ward-level error because one series gives only two test errors." : ""} Choose a ward with the ward filter in the complaint forecast above.` : undefined}
              source={`${src ? `Source: ${src.publisher}, ${src.table}, p. ${src.page}. ` : ""}Trained on ${wm.trained_on}.`}
              table={{ columns: ["Year", "Tonnes per day"], rows: [...ex.waste.history.map((h) => [h.year, h.value] as (string | number)[]), ...wfs.map((f) => [`${f.year} (forecast)`, `${fmt.int(f.value)} (${fmt.int(f.lower)} to ${fmt.int(f.upper)})`])] }}
            >
              <div className="mb-3 flex flex-wrap items-end justify-between gap-4">
                <p className="text-xs text-muted">Tonnes per day</p>
                <YearStats forecasts={wfs} last={wlast} unit="t/day" />
              </div>
              <ForecastChart history={ex.waste.history} forecasts={wfs} />
            </ChartCard>

            <ChartCard
              title={`Waste forecast by ward, ${spanOf(wYears)}`}
              question="How much should each ward plan to collect?"
              note={wardFam?.chosen === "naive" ? `For single wards, repeating last year's figure was the most accurate method (${wardFam.mape_pct.naive.toFixed(1)}% average miss, against ${wardFam.mape_pct.trend.toFixed(1)}% for the trend), so each ward's forecast equals its ${wlast?.year ?? "latest"} figure in every year. The useful part is the range, which widens each year (hover a figure): plan for the high end.` : undefined}
              table={wardTableData(ex.waste.ward_forecasts)}
            >
              <WardYearsTable rows={ex.waste.ward_forecasts} highlight={ex.zone?.code} />
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
          <li>The further ahead, the less reliable: the ranges for {allYears.at(-1)} come from three-years-ahead tests and are wider for that reason. Treat {allYears.at(-1)} figures as a planning range, not a target.</li>
          <li>Waste has only five published years per ward, so only one-year-ahead forecasts could be tested; the 2027 and 2028 waste ranges are widened from that test rather than measured. Air quality has 120 months, but only city-wide: there is no monthly AQI by ward to forecast.</li>
          <li>The air-quality forecast follows the usual seasonal cycle. It cannot foresee an unusual year (a weak monsoon, a festival season with heavy firecracker use, a construction boom).</li>
          <li>The forecasts assume the coming years behave like the recent past. A one-off event, such as ward S&apos;s jump from 6,221 complaints in 2024 to 13,116 in 2025, will not be predicted and is only partly carried forward.</li>
          <li>Ward groups describe 2025 (water 2024) and depend on which indicators are included. They show patterns, not causes.</li>
          <li>All models were trained on {fm.trained_at} from the published figures only. Retrain them when a new annual report is loaded.</li>
        </ul>
      </section>
    </div>
  );
}

/** Complaint closure: days to close and share closed, 2026-2028, from the three published years. */
function ClosureForecasts({ more, scope }: { more: MoreForecasts; scope: string }) {
  const c = more.closure;
  const fams = c.model!.params.families;
  const dFam = fams.days_to_close, pFam = fams.closed_pct;
  const dErr = dFam.mape_pct?.[dFam.chosen], dNaive = dFam.mape_pct?.naive;
  const pErr = pFam.mae?.[pFam.chosen], pNaive = pFam.mae?.naive;
  const method = (k: string) => c.model!.params.methods[k]?.toLowerCase() ?? k;
  const years = c.days.forecasts.map((f) => f.year);
  const caution = `Only three years are published (${c.days.history.map((h) => h.year).join(", ")}), so the methods were tested on one year only (2025, forecast from 2023 and 2024, across ${dFam.series} series) and the ranges for later years are widened from that test. Treat these as rough.`;
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard
          title={`Average days to close a complaint, forecast for ${years[0]} to ${years.at(-1)}: ${scope}`}
          question="Will complaints be resolved faster or slower?"
          note={`Method: ${method(dFam.chosen)}. Its forecasts for 2025 missed by ${dErr?.toFixed(0)}% on average, against ${dNaive?.toFixed(0)}% for repeating last year. ${caution}`}
          source={`Trained on ${c.model!.trained_on}.`}
          table={{ columns: ["Year", "Days to close"], rows: [...c.days.history.map((h) => [h.year, h.value] as (string | number)[]),
                   ...c.days.forecasts.map((f) => [`${f.year} (forecast)`, `${fmt.int(f.value)} (${fmt.int(f.lower)} to ${fmt.int(f.upper)})`])] }}
        >
          <ForecastChart history={c.days.history} forecasts={c.days.forecasts} unit="days" />
        </ChartCard>
        <ChartCard
          title={`Share of complaints closed, %, forecast for ${years[0]} to ${years.at(-1)}: ${scope}`}
          question="What share of complaints will be closed?"
          note={`Closed as a share of complaints registered that year. Method: ${method(pFam.chosen)}. Its forecasts for 2025 missed by ${pErr?.toFixed(1)} percentage points on average, against ${pNaive?.toFixed(1)} for repeating last year. Upper ends are capped at 100%. ${caution}`}
          source={`Trained on ${c.model!.trained_on}.`}
          table={{ columns: ["Year", "% closed"], rows: [...c.pct.history.map((h) => [h.year, h.value] as (string | number)[]),
                   ...c.pct.forecasts.map((f) => [`${f.year} (forecast)`, `${fmt.one(f.value)} (${fmt.one(f.lower)} to ${fmt.one(f.upper)})`])] }}
        >
          <ForecastChart history={c.pct.history} forecasts={c.pct.forecasts} decimals={1} unit="%" />
        </ChartCard>
      </div>
      {c.wards.length ? (
        <ChartCard
          title={`Days to close a complaint by ward: latest published and forecast ${years[0]} to ${years.at(-1)}`}
          question="Which wards are expected to stay slow?"
          note="Each ward's forecast with its 80% range in brackets. Sorted by the next year's forecast, slowest first."
          table={{ columns: ["Ward", "Latest published", ...years.map((y) => `${y} forecast`)],
                   rows: c.wards.map((w) => [w.code, w.days_last, ...years.map((y) => w.days?.find((f) => f.year === y)?.value ?? null)]) }}
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm tabular-nums">
              <thead className="text-xs uppercase tracking-wide text-muted">
                <tr><th className="py-1.5 pr-4 font-medium">Ward</th><th className="py-1.5 pr-4 font-medium">Latest</th>
                  {years.map((y) => <th key={y} className="py-1.5 pr-4 font-medium">{y}</th>)}<th className="py-1.5 font-medium">% closed, {years[0]}</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {[...c.wards].sort((a, b) => (b.days?.[0]?.value ?? 0) - (a.days?.[0]?.value ?? 0)).map((w) => (
                  <tr key={w.code}>
                    <td className="py-1.5 pr-4 text-ink">{w.code}</td>
                    <td className="py-1.5 pr-4 text-muted">{fmt.int(w.days_last)}</td>
                    {years.map((y) => {
                      const f = w.days?.find((x) => x.year === y);
                      return <td key={y} className="py-1.5 pr-4">{f ? <>{fmt.int(f.value)} <span className="text-xs text-faint">({fmt.int(f.lower)}–{fmt.int(f.upper)})</span></> : "—"}</td>;
                    })}
                    <td className="py-1.5">{fmt.one(w.pct?.[0]?.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ChartCard>
      ) : null}
    </>
  );
}
