import type { Metadata } from "next";
import { AlertTriangle, Droplets, GitBranch, Waves } from "lucide-react";
import { reviewAnomaly } from "@/app/(app)/ops-actions";
import { createTask } from "@/app/(app)/tasks/actions";
import { createClient } from "@/lib/supabase/server";
import { BarSeriesChart, ChartCard, EmptyChart } from "@/components/dashboard/charts";
import { KpiCard } from "@/components/dashboard/panels";
import { ModuleFilters } from "@/components/module-filters";
import { ForecastBandChart, MultiBarChart, type BandRow } from "@/components/ops/charts";
import { OpsMap, type OpsLayer } from "@/components/ops/ops-map";
import { ModelCard, OpsBanner, SubNav } from "@/components/ops/panels";
import { requireSession } from "@/lib/auth";
import { SERIES } from "@/lib/chart-colors";
import { fmt } from "@/lib/dashboard";
import { parseFilters } from "@/lib/filters";
import { at, dayLabel, RISK_COLOR, type ErrPair, type WaterOps } from "@/lib/ops";
import { loadOps, noteOf } from "@/lib/ops-server";

export const metadata: Metadata = { title: "Water network" };

const VIEWS = [{ href: "/water", label: "Published figures" }, { href: "/water/network", label: "Network and sensors (demo)" }];
const STATUS_LABEL: Record<string, string> = { open: "Open", inspecting: "Inspecting", confirmed: "Fault confirmed", dismissed: "Dismissed" };

type AnomalyMetrics = { flagged_share?: number; events?: number; faults_detected?: string; event_precision?: number; hour_precision?: number;
                        hour_recall?: number; scored_against?: string };
type DemandBlock = Record<string, ErrPair | string> & { unit?: string; test?: string };
type DemandMetrics = { next_24_hours?: DemandBlock; next_7_days?: DemandBlock; next_30_days?: DemandBlock };
type RiskMetrics = { pipes?: number; failed_last_year?: number; xgboost?: { auc: number; brier: number };
                     age_band_baseline?: { auc: number; brier: number }; validation?: string;
                     calibration?: { predicted: number; observed: number; pipes: number }[] };

const BASELINE_LABEL: Record<string, string> = {
  xgboost: "XGBoost", same_hour_yesterday: "Same hour yesterday", same_hour_last_week: "Same hour last week",
  last_week_repeated: "Last week repeated", four_week_average: "Four-week average",
};

function errRows(b: DemandBlock | undefined) {
  if (!b) return [];
  return Object.entries(b).filter(([, v]) => typeof v === "object").map(([k, v]) => [BASELINE_LABEL[k] ?? k, fmt.int((v as ErrPair).mae), fmt.int((v as ErrPair).rmse)]);
}

export default async function WaterNetworkPage({ searchParams }: PageProps<"/water/network">) {
  const session = await requireSession();
  const sp = await searchParams;
  const filters = parseFilters(sp);
  const { data: d, error, status, wards, zones, apiReady } = await loadOps<WaterOps>("ops_water", filters.zone);
  const hasData = Boolean(d && d.pipelines.length);
  const officer = session.role === "city_admin" || session.role === "dept_officer";
  const staffList = officer
    ? ((await (await createClient()).from("users").select("id, full_name").in("role", ["dept_officer", "field_worker", "city_admin"])
        .eq("is_active", true).order("full_name")).data ?? [])
    : [];

  const header = (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Water</h1>
        <p className="mt-1 text-sm text-muted">Pipe network, meters and reservoirs · leak and burst detection, demand forecasts, pipe risk, shortage risk</p>
      </div>
      <SubNav items={VIEWS} active="/water/network" />
      <OpsBanner status={status} role={session.role} back="/water/network" apiReady={apiReady} note={noteOf(sp)} hasData={hasData} />
    </>
  );
  if (error || !d || !hasData) {
    return <div className="mx-auto max-w-6xl space-y-6">{header}{error ? <p className="text-sm text-danger">{error}</p> : null}</div>;
  }

  const k = d.kpis;
  const change = k.consumption_24h_m3 && k.consumption_prev_week_m3 ? (k.consumption_24h_m3 / k.consumption_prev_week_m3 - 1) * 100 : null;
  const runs = d.runs;
  const am = (runs["water-anomaly"]?.metrics ?? {}) as AnomalyMetrics;
  const dm = (runs["water-demand"]?.metrics ?? {}) as DemandMetrics;
  const rm = (runs["water-pipe-risk"]?.metrics ?? {}) as RiskMetrics;

  // ---- map layers
  const reservoirsFc: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: d.reservoirs.filter((r) => r.point).map((r) => ({ type: "Feature", geometry: r.point!, properties: {
      name: r.name, current_pct: r.current_pct, min_pct: r.min_pct, risk: r.risk ?? "low", capacity_ml: r.capacity_ml } })),
  };
  const openAnoms: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: d.anomalies.filter((a) => a.point && (a.status === "open" || a.status === "inspecting")).map((a) => ({
      type: "Feature", geometry: a.point!, properties: { sensor: a.sensor, level: a.level, pattern: a.pattern, started: at(a.started_at),
        hours: a.evidence.hours, excess: a.evidence.consumption_vs_baseline_pct, dp: a.evidence.pressure_change_bar } })),
  };
  const riskColor = ["match", ["get", "level"], "high", RISK_COLOR.high, "medium", RISK_COLOR.medium, "low", RISK_COLOR.low, "#8a94a6"] as const;
  const layers: OpsLayer[] = [
    { id: "pipes", label: "Pipes by failure risk", kind: "line", data: { type: "FeatureCollection", features: d.pipelines },
      color: [...riskColor] as never, width: ["interpolate", ["linear"], ["get", "diameter_mm"], 150, 2, 1200, 6] as never, title: "code",
      fields: [{ key: "material", label: "Material" }, { key: "installed_year", label: "Installed", digits: 0 }, { key: "diameter_mm", label: "Diameter", unit: "mm" },
               { key: "length_m", label: "Length", unit: "m", digits: 0 }, { key: "failures_5y", label: "Failures, last 5 years", digits: 0 },
               { key: "risk", label: "Chance of a failure in 12 months", percent: true, digits: 0 }] },
    { id: "sensors", label: "Flow and pressure meters", kind: "circle", data: { type: "FeatureCollection", features: d.sensors },
      color: ["match", ["get", "level"], 2, RISK_COLOR.high, 1, RISK_COLOR.medium, SERIES.one] as never, radius: 5, title: "code",
      fields: [{ key: "flow_lps", label: "Flow", unit: "L/s" }, { key: "pressure_bar", label: "Pressure", unit: "bar", digits: 2 }] },
    { id: "reservoirs", label: "Service reservoirs", kind: "circle", data: reservoirsFc, radius: 8,
      color: ["match", ["get", "risk"], "high", RISK_COLOR.high, "medium", RISK_COLOR.medium, "#0d366b"] as never, title: "name",
      fields: [{ key: "current_pct", label: "Level now", unit: "%" }, { key: "min_pct", label: "Lowest projected, next 7 days", unit: "%" },
               { key: "capacity_ml", label: "Capacity", unit: "ML" }] },
    { id: "anomalies", label: "Open anomalies", kind: "circle", data: openAnoms, radius: 10, opacity: 0.55,
      color: ["match", ["get", "level"], "high", RISK_COLOR.high, RISK_COLOR.medium] as never, title: "sensor",
      fields: [{ key: "pattern", label: "Pattern" }, { key: "started", label: "Started" }, { key: "hours", label: "Hours", digits: 0 },
               { key: "excess", label: "Consumption vs usual", unit: "%" }, { key: "dp", label: "Pressure change", unit: "bar", digits: 2 }] },
  ];

  // ---- series
  const hourly: BandRow[] = d.hourly.map((h) => ({ x: at(h.ts), actual: h.m3 }));
  if (hourly.length && d.hourly_forecast.length) hourly[hourly.length - 1].forecast = d.hourly.at(-1)!.m3;
  hourly.push(...d.hourly_forecast.map((f) => ({ x: at(f.ts), forecast: f.m3, band: [f.lower, f.upper] as [number, number] })));
  const daily: BandRow[] = d.daily.map((r) => ({ x: dayLabel(r.day), actual: r.m3 }));
  if (daily.length && d.daily_forecast.length) daily[daily.length - 1].forecast = d.daily.at(-1)!.m3;
  daily.push(...d.daily_forecast.map((f) => ({ x: dayLabel(f.day), forecast: f.m3, band: [f.lower, f.upper] as [number, number] })));
  const f7 = d.daily_forecast.slice(0, 7).reduce((a, r) => a + r.m3, 0);
  const f30 = d.daily_forecast.reduce((a, r) => a + r.m3, 0);

  const riskCounts = (["high", "medium", "low"] as const).map((l) => ({ level: l, pipes: d.pipelines.filter((p) => p.properties.level === l).length }));
  const topPipes = [...d.pipelines].map((p) => p.properties).filter((p) => p.risk != null).sort((a, b) => b.risk! - a.risk!).slice(0, 12);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {header}
      <ModuleFilters wards={zones} ward={filters.zone} />

      <div className="stagger grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={Droplets} label="Water drawn, last 24 hours" value={fmt.int(k.consumption_24h_m3)} unit="m³"
                 note={change != null ? `${change >= 0 ? "+" : ""}${change.toFixed(1)}% against the same day last week` : undefined} />
        <KpiCard icon={AlertTriangle} label="Open anomalies" value={fmt.int(k.open_anomalies)} note={`${k.high_anomalies_7d} high in the last 7 days`} />
        <KpiCard icon={GitBranch} label="Pipes at high failure risk" value={fmt.int(k.high_risk_pipes)} note={`Of ${fmt.int(k.pipes)} pipes`} />
        <KpiCard icon={Waves} label="Reservoirs at shortage risk" value={fmt.int(k.reservoirs_at_risk)} note="Projected below 35% within 7 days" />
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Network map</h2>
        <OpsMap wards={wards} layers={layers} note={`Readings up to ${at(d.last_reading)}. Pipe width shows diameter. Click a pipe, meter or reservoir for details.`}
          legend={[{ label: "High risk / high anomaly", color: RISK_COLOR.high }, { label: "Medium / suspicious", color: RISK_COLOR.medium },
                   { label: "Low risk", color: RISK_COLOR.low }, { label: "Meter, normal", color: SERIES.one }]} />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Water drawn per hour, last 7 days and next 24 hours (m³)" question="What will demand be over the next day?"
          note="Forecast range: 90% of the model's errors on the held-out week fell inside it."
          table={{ columns: ["Time", "Observed m³", "Forecast m³", "Low", "High"],
                   rows: [...d.hourly.map((h) => [at(h.ts), h.m3, null, null, null]), ...d.hourly_forecast.map((f) => [at(f.ts), null, f.m3, f.lower, f.upper])] }}>
          <ForecastBandChart data={hourly} unit="m³" />
        </ChartCard>
        <ChartCard title="Water drawn per day, last 60 days and next 30 days (m³)" question="Where is demand heading this month?"
          note={`Next 7 days: ${fmt.int(f7)} m³. Next 30 days: ${fmt.int(f30)} m³.`}
          table={{ columns: ["Day", "Observed m³", "Forecast m³", "Low", "High"],
                   rows: [...d.daily.map((r) => [r.day, r.m3, null, null, null]), ...d.daily_forecast.map((f) => [f.day, null, f.m3, f.lower, f.upper])] }}>
          <ForecastBandChart data={daily} unit="m³" />
        </ChartCard>
        <ChartCard title="Water drawn by ward, m³ per day, last 7 days" question="Which zones consume the most water?"
          table={{ columns: ["Ward", "m³ per day", "Litres per person", "vs previous week %"], rows: d.zones.map((z) => [z.code, z.m3_per_day, z.litres_per_person, z.vs_prev_week_pct]) }}>
          <BarSeriesChart data={d.zones.map((z) => ({ ward: z.code, m3: z.m3_per_day }))} xKey="ward" unit="m³/day" series={{ key: "m3", label: "m³ per day", color: SERIES.one }} />
        </ChartCard>
        <ChartCard title="Change against the previous week, by ward (%)" question="Where is consumption unusually high?"
          note="A sustained rise with lower pressure is what a leak looks like; the anomaly list below says which meters show it."
          table={{ columns: ["Ward", "% change"], rows: d.zones.map((z) => [z.code, z.vs_prev_week_pct]) }}>
          <BarSeriesChart data={[...d.zones].sort((a, b) => (b.vs_prev_week_pct ?? 0) - (a.vs_prev_week_pct ?? 0)).map((z) => ({ ward: z.code, pct: z.vs_prev_week_pct }))}
                          xKey="ward" unit="%" series={{ key: "pct", label: "% change", color: SERIES.two }} />
        </ChartCard>
        <ChartCard title="Flagged meter-hours per day, last 30 days" question="When did unusual readings occur?"
          table={{ columns: ["Day", "Suspicious", "High"], rows: d.anomaly_days.map((r) => [r.day, r.suspicious, r.high]) }}>
          {d.anomaly_days.length ? (
            <MultiBarChart data={d.anomaly_days.map((r) => ({ day: dayLabel(r.day), suspicious: r.suspicious, high: r.high }))} xKey="day" stacked
                           keys={[{ key: "suspicious", label: "Suspicious", color: RISK_COLOR.medium }, { key: "high", label: "High anomaly", color: RISK_COLOR.high }]} />
          ) : <EmptyChart />}
        </ChartCard>
        <ChartCard title="Pipes by failure risk" question="How much of the network needs attention?"
          table={{ columns: ["Risk", "Pipes"], rows: riskCounts.map((r) => [r.level, r.pipes]) }}>
          <BarSeriesChart data={riskCounts} xKey="level" series={{ key: "pipes", label: "Pipes", color: SERIES.one }}
                          colors={[RISK_COLOR.high, RISK_COLOR.medium, RISK_COLOR.low]} />
        </ChartCard>
      </div>

      <section className="rounded-xl border border-line bg-panel">
        <div className="border-b border-line px-5 py-3">
          <h2 className="text-sm font-medium">Anomalies</h2>
          <p className="text-xs text-muted">Grouped flagged hours per meter. An anomaly is a pattern to inspect, not proof of a leak. Decisions are kept to evaluate the detector.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-muted">
              <tr><th className="px-4 py-2 font-medium">Meter</th><th className="px-4 py-2 font-medium">When</th><th className="px-4 py-2 font-medium">Level</th>
                  <th className="px-4 py-2 font-medium">What the readings show</th><th className="px-4 py-2 font-medium">Status</th><th className="px-4 py-2" /></tr>
            </thead>
            <tbody className="divide-y divide-line">
              {d.anomalies.length === 0 ? <tr><td colSpan={6} className="px-4 py-6 text-center text-muted">No anomalies.</td></tr> : null}
              {d.anomalies.slice(0, 25).map((a) => (
                <tr key={a.id} className="align-top">
                  <td className="px-4 py-2.5"><span className="text-ink">{a.sensor}</span><span className="block text-xs text-faint">{a.zone}</span></td>
                  <td className="px-4 py-2.5 text-xs text-muted">{at(a.started_at)} → {at(a.ended_at)}<span className="block">{a.evidence.hours} h</span></td>
                  <td className="px-4 py-2.5"><span className="rounded px-1.5 py-0.5 text-xs font-medium" style={{ background: `${a.level === "high" ? RISK_COLOR.high : RISK_COLOR.medium}22`, color: a.level === "high" ? RISK_COLOR.high : "#a46f00" }}>{a.level === "high" ? "High" : "Suspicious"}</span></td>
                  <td className="px-4 py-2.5 text-xs text-muted"><span className="text-ink">{a.pattern}</span>
                    <span className="block">Consumption {fmt.one(a.evidence.consumption_vs_baseline_pct)}% vs usual · pressure {fmt.two(a.evidence.pressure_change_bar)} bar{a.evidence.night_consumption_vs_baseline_pct != null ? ` · night use ${fmt.one(a.evidence.night_consumption_vs_baseline_pct)}%` : ""}</span></td>
                  <td className="px-4 py-2.5 text-xs text-muted">{STATUS_LABEL[a.status] ?? a.status}</td>
                  <td className="px-4 py-2.5">
                    {officer && (a.status === "open" || a.status === "inspecting") ? (
                      <div className="flex flex-wrap gap-1">
                        {(a.status === "open" ? ["inspecting", "confirmed", "dismissed"] : ["confirmed", "dismissed"]).map((s) => (
                          <form key={s} action={reviewAnomaly}>
                            <input type="hidden" name="id" value={a.id} /><input type="hidden" name="status" value={s} />
                            <button type="submit" className="rounded border border-line px-2 py-0.5 text-xs text-muted hover:text-ink">{s === "inspecting" ? "Inspect" : s === "confirmed" ? "Confirm fault" : "Dismiss"}</button>
                          </form>
                        ))}
                      </div>
                    ) : null}
                    {officer && (a.status === "open" || a.status === "inspecting") ? (
                      <form action={createTask} className="mt-1.5 flex gap-1">
                        <input type="hidden" name="back" value="/water/network" />
                        <input type="hidden" name="anomaly" value={a.id} />
                        <input type="hidden" name="kind" value="inspection" />
                        <input type="hidden" name="priority" value={a.level === "high" ? "high" : "medium"} />
                        <input type="hidden" name="title" value={`Inspect pipeline at meter ${a.sensor} (${a.level} anomaly)`} />
                        <input type="hidden" name="description" value={`${a.pattern} Consumption ${a.evidence.consumption_vs_baseline_pct ?? "?"}% against usual, pressure change ${a.evidence.pressure_change_bar ?? "?"} bar. Check for leaks or bursts and report what you find.`} />
                        <select name="assignee" required defaultValue="" aria-label="Assign inspection to" className="min-w-0 rounded border border-line bg-raised px-1 py-0.5 text-xs text-ink">
                          <option value="" disabled>Send to…</option>
                          {staffList.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                        </select>
                        <button type="submit" className="rounded border border-line px-2 py-0.5 text-xs text-muted hover:text-ink">Task</button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Pipes most likely to fail in the next 12 months" question="Which pipes should be inspected or replaced first?"
          table={{ columns: ["Pipe", "Material", "Installed", "Failures 5y", "Probability"], rows: topPipes.map((p) => [p.code, p.material, p.installed_year, p.failures_5y, p.risk]) }}>
          <ul className="divide-y divide-line text-sm">
            {topPipes.map((p) => (
              <li key={p.code} className="py-2">
                <div className="flex justify-between gap-3"><span className="text-ink">{p.code} · {p.material}, {p.installed_year}, {p.diameter_mm} mm</span>
                  <span className="tabular-nums font-medium" style={{ color: RISK_COLOR[p.level ?? "low"] }}>{Math.round((p.risk ?? 0) * 100)}%</span></div>
                <p className="mt-0.5 text-xs text-muted">{(p.factors ?? []).slice(0, 3).map((f) => `${f.factor} ${fmt.one(f.value)} (${f.effect})`).join(" · ")}</p>
              </li>
            ))}
          </ul>
        </ChartCard>
        <ChartCard title="Service reservoirs: level now and lowest projected in 7 days (%)" question="Where could supply run short?"
          note="Projection: last week's average inflow against the forecast demand of the reservoir's ward. High risk below 20%, medium below 35%."
          table={{ columns: ["Reservoir", "Now %", "Lowest in 7 days %", "Days to 20%", "Risk"], rows: d.reservoirs.map((r) => [r.name, r.current_pct, r.min_pct, r.days_to_20pct, r.risk]) }}>
          <MultiBarChart data={d.reservoirs.slice(0, 12).map((r) => ({ name: r.name.split(" ")[0], now: r.current_pct, min: r.min_pct }))} xKey="name" unit="%" angle
                         keys={[{ key: "now", label: "Now", color: SERIES.one }, { key: "min", label: "Lowest projected", color: SERIES.two }]} />
        </ChartCard>
      </div>

      <h2 className="pt-2 text-sm font-medium">How the models were tested</h2>
      <div className="grid gap-4 lg:grid-cols-2">
        <ModelCard title="A. Anomaly detection" method={runs["water-anomaly"]?.method} trainedAt={runs["water-anomaly"]?.trained_at} demo={runs["water-anomaly"]?.is_demo}
          columns={["Measure", "Value"]}
          rows={[["Faults found", am.faults_detected ?? "—"], ["Alerts that were real faults", am.event_precision != null ? `${Math.round(am.event_precision * 100)}%` : "—"],
                 ["Fault hours flagged (recall)", am.hour_recall != null ? `${Math.round(am.hour_recall * 100)}%` : "—"],
                 ["Flagged hours that were faults (precision)", am.hour_precision != null ? `${Math.round(am.hour_precision * 100)}%` : "—"],
                 ["Share of readings flagged", am.flagged_share != null ? `${(am.flagged_share * 100).toFixed(1)}%` : "—"]]}
          note={`Inputs: flow, pressure, consumption, hour, weekday and each meter's usual value for that hour of the week (median of the previous four weeks). Top 1% of scores are Suspicious, top 0.4% High. Scored against ${am.scored_against ?? "known faults"}.`} />
        <ModelCard title="B. Demand forecasting" method={runs["water-demand"]?.method} trainedAt={runs["water-demand"]?.trained_at} demo={runs["water-demand"]?.is_demo}
          columns={["Method", "MAE", "RMSE"]} rows={errRows(dm.next_24_hours)}
          note={`Next 24 hours, m³ per hour per ward, ${dm.next_24_hours?.test ?? ""}. Lower is better.`}>
          {(["next_7_days", "next_30_days"] as const).map((h) => (
            <div key={h} className="mt-3">
              <p className="text-xs text-muted">{h === "next_7_days" ? "Next 7 days" : "Next 30 days"}, m³ per day per ward</p>
              <table className="mt-1 w-full text-left text-xs tabular-nums"><tbody className="divide-y divide-line">
                {errRows(dm[h]).map((r, i) => <tr key={i} className={i === 0 ? "font-medium text-ink" : "text-muted"}>{r.map((c, j) => <td key={j} className="py-1 pr-4">{c}</td>)}</tr>)}
              </tbody></table>
            </div>
          ))}
        </ModelCard>
        <ModelCard title="C. Pipe failure risk" method={runs["water-pipe-risk"]?.method} trainedAt={runs["water-pipe-risk"]?.trained_at} demo={runs["water-pipe-risk"]?.is_demo}
          columns={["Method", "AUC (higher is better)", "Brier (lower is better)"]}
          rows={[["XGBoost", rm.xgboost?.auc ?? null, rm.xgboost?.brier ?? null], ["Failure rate by pipe age", rm.age_band_baseline?.auc ?? null, rm.age_band_baseline?.brier ?? null]]}
          note={`${rm.validation ?? ""}. ${rm.failed_last_year ?? "—"} of ${rm.pipes ?? "—"} pipes failed last year.`}>
          {rm.calibration?.length ? (
            <div className="mt-3">
              <p className="text-xs text-muted">Calibration: predicted probability against the share that failed</p>
              <table className="mt-1 w-full text-left text-xs tabular-nums"><thead className="text-muted"><tr><th className="py-1 pr-4 font-medium">Predicted</th><th className="py-1 pr-4 font-medium">Observed</th><th className="py-1 font-medium">Pipes</th></tr></thead>
                <tbody className="divide-y divide-line">{rm.calibration.map((c, i) => <tr key={i}><td className="py-1 pr-4">{Math.round(c.predicted * 100)}%</td><td className="py-1 pr-4">{Math.round(c.observed * 100)}%</td><td className="py-1">{c.pipes}</td></tr>)}</tbody></table>
            </div>
          ) : null}
        </ModelCard>
        <ModelCard title="D. Shortage risk" method={runs["water-shortage"]?.method} trainedAt={runs["water-shortage"]?.trained_at} demo={runs["water-shortage"]?.is_demo}
          note="A water balance, not a learned model: each reservoir's level is carried forward a day at a time, adding last week's average inflow and subtracting the ward's forecast demand." />
      </div>
    </div>
  );
}
