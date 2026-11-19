import type { Metadata } from "next";
import { AlertTriangle, Route, Trash2, Truck } from "lucide-react";
import { BarSeriesChart, ChartCard, EmptyChart } from "@/components/dashboard/charts";
import { KpiCard } from "@/components/dashboard/panels";
import { ModuleFilters } from "@/components/module-filters";
import { MultiBarChart } from "@/components/ops/charts";
import { OpsMap, type OpsLayer } from "@/components/ops/ops-map";
import { ModelCard, OpsBanner, SubNav } from "@/components/ops/panels";
import { requireSession } from "@/lib/auth";
import { SERIES } from "@/lib/chart-colors";
import { fmt } from "@/lib/dashboard";
import { parseFilters } from "@/lib/filters";
import { at, dayLabel, RISK_COLOR, type WasteOps } from "@/lib/ops";
import { loadOps, noteOf } from "@/lib/ops-server";

export const metadata: Metadata = { title: "Waste operations" };

const VIEWS = [{ href: "/waste", label: "Published figures" }, { href: "/waste/operations", label: "Bins and routes (demo)" }];
const ROUTE_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#8a4fd6", "#d03b6e"];

type HorizonMetrics = { windows: number; reached_full: number; fill_mae_pct: { xgboost: number; straight_line: number };
                        overflow: { xgboost: { auc: number; brier: number; precision_at_50: number; recall_at_50: number };
                                    straight_line: { precision: number; recall: number; brier: number } };
                        calibration: { predicted: number; observed: number; windows: number }[] };
type RouteMetrics = { optimised_km?: number; fixed_km?: number; optimised_bins?: number; fixed_bins?: number; priority?: number;
                      priority_covered_fixed?: number; solver?: string | null };

export default async function WasteOperationsPage({ searchParams }: PageProps<"/waste/operations">) {
  const session = await requireSession();
  const sp = await searchParams;
  const filters = parseFilters(sp);
  const { data: d, error, status, wards, zones, apiReady } = await loadOps<WasteOps>("ops_waste", filters.zone);
  const hasData = Boolean(d && d.bins.length);

  const header = (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Waste</h1>
        <p className="mt-1 text-sm text-muted">Bin fill levels · overflow prediction for 6, 12 and 24 hours · collection routes against the fixed schedule</p>
      </div>
      <SubNav items={VIEWS} active="/waste/operations" />
      <OpsBanner status={status} role={session.role} back="/waste/operations" apiReady={apiReady} note={noteOf(sp)} hasData={hasData} />
    </>
  );
  if (error || !d || !hasData) {
    return <div className="mx-auto max-w-6xl space-y-6">{header}{error ? <p className="text-sm text-danger">{error}</p> : null}</div>;
  }

  const k = d.kpis;
  const ov = (d.runs["waste-overflow"]?.metrics ?? {}) as Record<string, HorizonMetrics>;
  const rt = (d.runs["waste-routes"]?.metrics ?? {}) as RouteMetrics;
  const opt = d.plans.filter((p) => p.kind === "optimised");
  const fixed = d.plans.filter((p) => p.kind === "fixed");
  const sum = (ps: typeof opt, key: "distance_km" | "minutes" | "bins_visited" | "priority_covered" | "priority_bins") => ps.reduce((a, p) => a + p[key], 0);
  const optKm = sum(opt, "distance_km"), fixKm = sum(fixed, "distance_km");
  const plannedFor = d.plans[0]?.planned_for;

  // ---- map
  const routeFeatures: GeoJSON.Feature[] = opt.flatMap((p) => p.routes.map((r, i) => ({
    type: "Feature" as const, geometry: r.geometry, properties: { zone: p.zone, vehicle: r.vehicle, stops: r.stops.length, km: r.distance_km,
      minutes: r.minutes, load: r.load_l, color: ROUTE_COLORS[i % ROUTE_COLORS.length] } })));
  const fixedFeatures: GeoJSON.Feature[] = fixed.flatMap((p) => p.routes.map((r) => ({
    type: "Feature" as const, geometry: r.geometry, properties: { zone: p.zone, vehicle: r.vehicle, stops: r.stops.length, km: r.distance_km } })));
  const depots: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: d.vehicles.map((v) => ({ type: "Feature", geometry: v.depot, properties: { code: v.code, capacity_l: v.capacity_l } })) };
  const layers: OpsLayer[] = [
    { id: "fixed", label: "Fixed schedule routes", kind: "line", data: { type: "FeatureCollection", features: fixedFeatures }, color: "#8a94a6", width: 2, dashed: true,
      visible: false, title: "vehicle", fields: [{ key: "zone", label: "Ward" }, { key: "stops", label: "Stops", digits: 0 }, { key: "km", label: "Distance", unit: "km" }] },
    { id: "routes", label: "Optimised routes", kind: "line", data: { type: "FeatureCollection", features: routeFeatures }, color: ["get", "color"] as never, width: 3,
      title: "vehicle", fields: [{ key: "zone", label: "Ward" }, { key: "stops", label: "Stops", digits: 0 }, { key: "km", label: "Distance", unit: "km" },
                                 { key: "minutes", label: "Time", unit: "min", digits: 0 }, { key: "load", label: "Load", unit: "litres", digits: 0 }] },
    { id: "bins", label: "Bins by chance of filling within 24 hours", kind: "circle", data: { type: "FeatureCollection", features: d.bins },
      color: ["interpolate", ["linear"], ["coalesce", ["get", "p24"], 0], 0, RISK_COLOR.low, 0.5, RISK_COLOR.medium, 1, RISK_COLOR.high] as never,
      radius: ["interpolate", ["linear"], ["coalesce", ["get", "fill_now"], 0], 0, 3, 100, 8] as never, title: "code",
      fields: [{ key: "kind", label: "Type" }, { key: "capacity_l", label: "Size", unit: "litres", digits: 0 }, { key: "fill_now", label: "Full now", unit: "%" },
               { key: "fill_24h", label: "Expected in 24 h", unit: "%" }, { key: "p6", label: "Chance full within 6 h", percent: true, digits: 0 },
               { key: "p12", label: "Within 12 h", percent: true, digits: 0 }, { key: "p24", label: "Within 24 h", percent: true, digits: 0 },
               { key: "collect_every_h", label: "Scheduled every", unit: "h", digits: 0 }] },
    { id: "depots", label: "Depots", kind: "circle", data: depots, color: "#111827", radius: 5, title: "code", fields: [{ key: "capacity_l", label: "Truck body", unit: "litres", digits: 0 }] },
  ];

  const atRisk = d.bins.map((b) => b.properties).filter((b) => (b.p24 ?? 0) >= 0.5 || (b.fill_now ?? 0) >= 95)
    .sort((a, b) => (b.p6 ?? 0) - (a.p6 ?? 0) || (b.p24 ?? 0) - (a.p24 ?? 0));
  const zoneName = new Map(zones.map((z) => [z.id, z.name]));

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {header}
      <ModuleFilters wards={zones} ward={filters.zone} />

      <div className="stagger grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={Trash2} label="Bins full now" value={fmt.int(k.full_now)} note={`Of ${fmt.int(k.bins)} · average fill ${fmt.one(k.avg_fill)}%`} />
        <KpiCard icon={AlertTriangle} label="Likely to fill within 24 hours" value={fmt.int(k.overflow_24h)} note={`${k.overflow_6h} within 6 h · ${k.overflow_12h} within 12 h`} />
        <KpiCard icon={Route} label="Optimised route distance" value={fmt.one(optKm)} unit="km" note={fixKm ? `${fmt.one(fixKm)} km on the fixed schedule (${Math.round((1 - optKm / fixKm) * 100)}% less)` : undefined} />
        <KpiCard icon={Truck} label="Bins collected in the plan" value={fmt.int(sum(opt, "bins_visited"))}
                 note={`${sum(fixed, "bins_visited")} on the fixed schedule, which misses ${sum(fixed, "priority_bins") - sum(fixed, "priority_covered")} that need it`} />
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Bins and routes{plannedFor ? ` · plan for ${dayLabel(plannedFor)}` : ""}</h2>
        <OpsMap wards={wards} layers={layers}
          note={`Readings up to ${at(d.last_reading)}. Bin colour is the chance of reaching 95% within 24 hours; size is how full it is now. Routes are drawn as straight lines between stops.`}
          legend={[{ label: "Likely to fill (≥50%)", color: RISK_COLOR.high }, { label: "Possible", color: RISK_COLOR.medium }, { label: "Unlikely", color: RISK_COLOR.low },
                   { label: "Fixed schedule route", color: "#8a94a6", shape: "line" }]} />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Route distance by ward, optimised against fixed schedule (km)" question="How much driving does the forecast-led plan save?"
          note={`Optimised: bins predicted to reach 95% within 24 hours (chance ≥ 50%) or 75% full. Fixed: every bin due on its schedule. Solver: ${rt.solver ?? opt[0]?.solver ?? "—"}.`}
          table={{ columns: ["Ward", "Optimised km", "Fixed km", "Optimised bins", "Fixed bins", "Bins needing collection", "Fixed covers"],
                   rows: opt.map((p) => { const f = fixed.find((x) => x.zone_id === p.zone_id); return [p.zone, p.distance_km, f?.distance_km ?? null, p.bins_visited, f?.bins_visited ?? null, p.priority_bins, f?.priority_covered ?? null]; }) }}>
          <MultiBarChart data={opt.map((p) => ({ ward: p.zone.split(" ")[0], optimised: p.distance_km, fixed: fixed.find((x) => x.zone_id === p.zone_id)?.distance_km ?? null }))}
                         xKey="ward" unit="km" angle keys={[{ key: "optimised", label: "Optimised", color: SERIES.one }, { key: "fixed", label: "Fixed schedule", color: "#8a94a6" }]} />
        </ChartCard>
        <ChartCard title="Waste put into bins per day (litres)" question="How is waste generation trending?"
          note="The rises in fill between readings, times bin size, summed over all bins."
          table={{ columns: ["Day", "Litres"], rows: d.generation.map((g) => [g.day, g.litres]) }}>
          {d.generation.length ? <BarSeriesChart data={d.generation.map((g) => ({ day: dayLabel(g.day), litres: g.litres }))} xKey="day" unit="L" series={{ key: "litres", label: "Litres", color: SERIES.one }} /> : <EmptyChart />}
        </ChartCard>
        <ChartCard title="Average bin fill by hour of day (%)" question="When do bins fill up?"
          table={{ columns: ["Hour", "Average fill %"], rows: d.by_hour.map((h) => [h.hour, h.fill]) }}>
          <BarSeriesChart data={d.by_hour.map((h) => ({ hour: `${String(h.hour).padStart(2, "0")}:00`, fill: h.fill }))} xKey="hour" unit="%" series={{ key: "fill", label: "Average fill", color: SERIES.one }} />
        </ChartCard>
        <ChartCard title="Collection efficiency by ward" question="Which zones empty bins too early, or let them overflow?"
          note="How full bins were when emptied (low means trips to nearly empty bins), and the share of time bins sat full."
          table={{ columns: ["Ward", "Average fill when emptied %", "Time spent full %", "Collections"], rows: d.zones.map((z) => [z.code, z.avg_fill_at_collection, z.hours_full_pct, z.collections]) }}>
          <MultiBarChart data={d.zones.map((z) => ({ ward: z.code, at: z.avg_fill_at_collection, full: z.hours_full_pct }))} xKey="ward" unit="%" angle
                         keys={[{ key: "at", label: "Fill when emptied", color: SERIES.one }, { key: "full", label: "Time spent full", color: RISK_COLOR.high }]} />
        </ChartCard>
      </div>

      <section className="rounded-xl border border-line bg-panel">
        <div className="border-b border-line px-5 py-3">
          <h2 className="text-sm font-medium">Bins to prioritise</h2>
          <p className="text-xs text-muted">Full now, or likely to reach 95% within 24 hours if not collected. Most urgent first.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm tabular-nums">
            <thead className="text-xs uppercase tracking-wide text-muted">
              <tr>{["Bin", "Ward", "Type", "Full now", "In 24 h", "Within 6 h", "Within 12 h", "Within 24 h"].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-line">
              {atRisk.length === 0 ? <tr><td colSpan={8} className="px-4 py-6 text-center text-muted">No bins at risk.</td></tr> : null}
              {atRisk.slice(0, 30).map((b) => (
                <tr key={b.code}>
                  <td className="px-4 py-2 text-ink">{b.code}</td><td className="px-4 py-2 text-xs text-muted">{zoneName.get(b.zone_id) ?? ""}</td>
                  <td className="px-4 py-2 text-muted">{b.kind}</td><td className="px-4 py-2">{fmt.int(b.fill_now)}%</td><td className="px-4 py-2">{fmt.int(b.fill_24h)}%</td>
                  {[b.p6, b.p12, b.p24].map((p, i) => <td key={i} className="px-4 py-2 font-medium" style={{ color: (p ?? 0) >= 0.5 ? RISK_COLOR.high : "inherit" }}>{p == null ? "—" : `${Math.round(p * 100)}%`}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <details className="group rounded-xl border border-line bg-panel">
        <summary className="cursor-pointer list-none px-5 py-3 text-sm font-medium text-ink [&::-webkit-details-marker]:hidden">
          <span className="mr-1.5 inline-block text-muted transition-transform group-open:rotate-90">›</span>How the models were tested
          <span className="ml-2 text-xs font-normal text-muted">accuracy against simple baselines, on held-out data</span>
        </summary>
        <div className="grid gap-4 border-t border-line p-4 lg:grid-cols-2">
        <ModelCard title="A and B. Fill forecast and overflow prediction" method={d.runs["waste-overflow"]?.method} trainedAt={d.runs["waste-overflow"]?.trained_at} demo={d.runs["waste-overflow"]?.is_demo}
          columns={["Horizon", "Fill error, XGBoost", "Fill error, straight line", "AUC", "Brier", "Precision", "Recall"]}
          rows={[6, 12, 24].filter((h) => ov[`${h}h`]).map((h) => {
            const m = ov[`${h}h`];
            return [`${h} hours`, `${m.fill_mae_pct.xgboost} pts`, `${m.fill_mae_pct.straight_line} pts`, m.overflow.xgboost.auc, m.overflow.xgboost.brier,
                    `${Math.round(m.overflow.xgboost.precision_at_50 * 100)}%`, `${Math.round(m.overflow.xgboost.recall_at_50 * 100)}%`];
          })}
          note="Tested on the most recent week, held out, for bins not yet full in windows when they were not emptied. Precision and recall at a 50% threshold. Demonstration bins fill more regularly than real ones, so these scores are optimistic." />
        <ModelCard title="C. Route optimisation" method={d.runs["waste-routes"]?.method} trainedAt={d.runs["waste-routes"]?.trained_at} demo={d.runs["waste-routes"]?.is_demo}
          columns={["Plan", "Distance", "Bins", "Bins needing collection covered"]}
          rows={[["Forecast-led, optimised", `${fmt.one(optKm)} km`, sum(opt, "bins_visited"), `${sum(opt, "priority_covered")} of ${sum(opt, "priority_bins")}`],
                 ["Fixed schedule", `${fmt.one(fixKm)} km`, sum(fixed, "bins_visited"), `${sum(fixed, "priority_covered")} of ${sum(fixed, "priority_bins")}`]]}
          note="A capacitated vehicle routing problem per ward: each truck starts and ends at its depot, carries up to three times its body volume (compaction), and the solver minimises distance. Distances are straight lines × 1.3." />
        </div>
      </details>
    </div>
  );
}
