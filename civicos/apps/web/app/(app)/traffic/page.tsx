import type { Metadata } from "next";
import { Activity, AlertTriangle, Gauge, TrendingUp } from "lucide-react";
import { BarSeriesChart, ChartCard } from "@/components/dashboard/charts";
import { KpiCard } from "@/components/dashboard/panels";
import { ModuleFilters } from "@/components/module-filters";
import { MultiLineChart } from "@/components/ops/charts";
import { OpsMap, type OpsLayer } from "@/components/ops/ops-map";
import { ModelCard, OpsBanner } from "@/components/ops/panels";
import { Simulator } from "@/components/ops/simulator";
import { requireSession } from "@/lib/auth";
import { SERIES } from "@/lib/chart-colors";
import { fmt } from "@/lib/dashboard";
import { parseFilters } from "@/lib/filters";
import { ACTION_LABEL, at, CONGESTION_COLOR, congestionLevel, type ErrPair, type TrafficOps } from "@/lib/ops";
import { loadOps, noteOf } from "@/lib/ops-server";

export const metadata: Metadata = { title: "Traffic" };

const H = ["15", "30", "60"] as const;
const congestionPaint = (key: string) =>
  ["case", ["==", ["typeof", ["get", key]], "number"],
   ["step", ["get", key], CONGESTION_COLOR["free flow"], 0.2, CONGESTION_COLOR.moderate, 0.4, CONGESTION_COLOR.heavy, 0.6, CONGESTION_COLOR.severe],
   "#b8c0cc"] as never;

export default async function TrafficPage({ searchParams }: PageProps<"/traffic">) {
  const session = await requireSession();
  const sp = await searchParams;
  const filters = parseFilters(sp);
  const { data: d, error, status, wards, zones, apiReady } = await loadOps<TrafficOps>("ops_traffic", filters.zone);
  const hasData = Boolean(d && d.roads.length);

  const header = (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Traffic</h1>
        <p className="mt-1 text-sm text-muted">Road network · congestion now and in 15, 30 and 60 minutes · peak hours · incidents · what-if simulation</p>
      </div>
      <OpsBanner status={status} role={session.role} back="/traffic" apiReady={apiReady} note={noteOf(sp)} hasData={hasData} />
    </>
  );
  if (error || !d || !hasData) {
    return <div className="mx-auto max-w-6xl space-y-6">{header}{error ? <p className="text-sm text-danger">{error}</p> : null}</div>;
  }

  const roads = d.roads.map((r) => r.properties);
  const monitored = roads.filter((r) => r.monitored && r.congestion_now != null);
  const avgNow = monitored.length ? monitored.reduce((a, r) => a + r.congestion_now!, 0) / monitored.length : null;
  const heavyNow = monitored.filter((r) => r.congestion_now! >= 0.4).length;
  const heavy60 = roads.filter((r) => (r.forecast?.["60"]?.congestion ?? 0) >= 0.4).length;
  const lastYear = d.incidents.length;
  const cm = (d.runs["traffic-congestion"]?.metrics ?? {}) as Record<string, Record<string, ErrPair>>;
  const am = (d.runs["traffic-assignment"]?.metrics ?? {}) as { peak_hour_trips?: number; roads?: number; junctions?: number };

  // map: each road carries its congestion now and per horizon as flat properties, so one layer per view can colour it
  const flat: GeoJSON.Feature[] = d.roads.map((f) => ({
    ...f, properties: { ...f.properties, forecast: undefined, c15: f.properties.forecast?.["15"]?.congestion ?? null,
      c30: f.properties.forecast?.["30"]?.congestion ?? null, c60: f.properties.forecast?.["60"]?.congestion ?? null,
      s60: f.properties.forecast?.["60"]?.speed ?? null },
  }));
  const fields = [{ key: "lanes", label: "Lanes", digits: 0 }, { key: "speed_limit", label: "Limit", unit: "km/h", digits: 0 },
                  { key: "speed_now", label: "Speed now", unit: "km/h" }, { key: "volume_now", label: "Volume now", unit: "vehicles/h", digits: 0 },
                  { key: "travel_min_now", label: "Travel time now", unit: "min" }, { key: "congestion_now", label: "Congestion now", percent: true, digits: 0 },
                  { key: "s60", label: "Speed in 60 min", unit: "km/h" }, { key: "incidents_365d", label: "Incidents, last 12 months", digits: 0 }];
  const roadFc: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: flat };
  const incidents: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: d.incidents.filter((i) => i.point).map((i) => ({ type: "Feature", geometry: i.point!, properties: { kind: i.kind, severity: i.severity, when: at(i.occurred_at), road: i.road, duration: i.duration_min } })),
  };
  const layers: OpsLayer[] = [
    { id: "now", label: "Congestion now", kind: "line", data: roadFc, color: congestionPaint("congestion_now"), width: ["+", 1, ["get", "lanes"]] as never, title: "name", fields },
    ...H.map((h) => ({ id: `f${h}`, label: `Forecast, ${h} min`, kind: "line" as const, data: roadFc, color: congestionPaint(`c${h}`),
                       width: ["+", 1, ["get", "lanes"]] as never, visible: false, title: "name", fields })),
    { id: "incidents", label: "Incidents, last 12 months", kind: "circle", data: incidents, visible: false, radius: 3, opacity: 0.6,
      color: ["match", ["get", "kind"], "accident", "#d03b3b", "waterlogging", "#2a78d6", "#fab219"] as never, title: "kind",
      fields: [{ key: "severity", label: "Severity" }, { key: "when", label: "When" }, { key: "road", label: "Road" }, { key: "duration", label: "Duration", unit: "min", digits: 0 }] },
  ];

  const recent = d.recent.map((r) => ({ x: at(r.ts), congestion: r.congestion }));
  const byHour = d.by_hour.map((h) => ({ hour: `${String(h.hour).padStart(2, "0")}:00`, weekday: h.weekday, weekend: h.weekend }));
  const peaks = [...d.by_hour].filter((h) => h.weekday != null).sort((a, b) => b.weekday! - a.weekday!).slice(0, 3).map((h) => `${String(h.hour).padStart(2, "0")}:00`);
  const hotspots = [...roads].sort((a, b) => b.incidents_365d - a.incidents_365d).slice(0, 10);
  const worst = [...monitored].sort((a, b) => b.congestion_now! - a.congestion_now!).slice(0, 10);
  const kinds = Object.entries(d.incidents_by_kind.reduce<Record<string, number>>((a, i) => ({ ...a, [i.kind]: (a[i.kind] ?? 0) + i.count }), {}))
    .map(([kind, count]) => ({ kind, count }));
  const officer = session.role === "city_admin" || session.role === "dept_officer";

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {header}
      <ModuleFilters wards={zones} ward={filters.zone} />

      <div className="stagger grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={Gauge} label="Average congestion now" value={avgNow != null ? String(Math.round(avgNow * 100)) : "—"} unit="%"
                 note={`Speed below the limit, ${monitored.length} monitored roads`} />
        <KpiCard icon={Activity} label="Roads heavy or severe now" value={fmt.int(heavyNow)} note="Congestion 40% or more" />
        <KpiCard icon={TrendingUp} label="Heavy in 60 minutes (forecast)" value={fmt.int(heavy60)} note={`At ${at(d.last_reading)} + 1 hour`} />
        <KpiCard icon={AlertTriangle} label="Incidents, last 12 months" value={fmt.int(lastYear)} note={kinds.map((k) => `${k.count} ${k.kind}`).join(" · ")} />
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Road network</h2>
        <OpsMap wards={wards} layers={layers}
          note={`Readings up to ${at(d.last_reading)}. Congestion = how far speed falls below the limit. Grey roads have no detector. Tick a forecast layer to see 15, 30 or 60 minutes ahead.`}
          legend={Object.entries(CONGESTION_COLOR).map(([label, color]) => ({ label, color, shape: "line" as const }))} />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Congestion by hour of day, weekdays and weekends" question="When are the peak hours?"
          note={peaks.length ? `Weekday peaks: ${peaks.join(", ")}.` : undefined}
          table={{ columns: ["Hour", "Weekday congestion", "Weekend congestion"], rows: d.by_hour.map((h) => [h.hour, h.weekday, h.weekend]) }}>
          <MultiLineChart data={byHour} xKey="hour" percent keys={[{ key: "weekday", label: "Weekdays", color: SERIES.one }, { key: "weekend", label: "Weekends", color: SERIES.two }]} />
        </ChartCard>
        <ChartCard title="Average congestion, last 2 days" question="How has traffic moved recently?"
          table={{ columns: ["Time", "Congestion", "Average speed km/h"], rows: d.recent.map((r) => [at(r.ts), r.congestion, r.speed]) }}>
          <MultiLineChart data={recent} xKey="x" percent keys={[{ key: "congestion", label: "Average congestion", color: SERIES.one }]} />
        </ChartCard>
        <ChartCard title="Most congested roads now" question="Where is traffic worst right now?"
          table={{ columns: ["Road", "Speed km/h", "Limit", "Travel min", "Congestion", "In 60 min"], rows: worst.map((r) => [r.name, r.speed_now, r.speed_limit, r.travel_min_now, r.congestion_now, r.forecast?.["60"]?.congestion ?? null]) }}>
          <ul className="divide-y divide-line text-sm">
            {worst.map((r) => {
              const lv = congestionLevel(r.congestion_now);
              const lv60 = congestionLevel(r.forecast?.["60"]?.congestion);
              return (
                <li key={r.id} className="flex items-center justify-between gap-3 py-1.5">
                  <span className="text-ink">{r.name}<span className="block text-xs text-faint">{fmt.one(r.speed_now)} of {r.speed_limit} km/h · {fmt.one(r.travel_min_now)} min to cross</span></span>
                  <span className="text-right text-xs"><span style={{ color: lv ? CONGESTION_COLOR[lv] : undefined }}>{lv}</span>
                    <span className="block text-faint">in 60 min: <span style={{ color: lv60 ? CONGESTION_COLOR[lv60] : undefined }}>{lv60 ?? "—"}</span></span></span>
                </li>
              );
            })}
          </ul>
        </ChartCard>
        <ChartCard title="Accident and incident hotspots, last 12 months" question="Which roads have the most incidents?"
          table={{ columns: ["Road", "Incidents", "Lanes", "Limit"], rows: hotspots.map((r) => [r.name, r.incidents_365d, r.lanes, r.speed_limit]) }}>
          <BarSeriesChart data={hotspots.map((r) => ({ road: r.name.replace("Demo road ", "Road "), n: r.incidents_365d }))} xKey="road" direction="row" labelWidth={90}
                          series={{ key: "n", label: "Incidents", color: SERIES.two }} />
        </ChartCard>
      </div>

      <Simulator roads={roads.map((r) => ({ id: r.id, name: r.name, lanes: r.lanes, capacity_vph: r.capacity_vph, volume_now: r.volume_now }))}
                 wards={wards} allowed={officer && apiReady && Boolean(status?.predictions_enabled)}
                 reason={!officer ? "Only officers can run simulations." : !apiReady ? "Needs the CivicOS API (set CIVICOS_API_URL)."
                   : !status?.predictions_enabled ? "Simulation is in the Professional plan. A City Administrator can switch plans in Settings (test mode, no payment)." : undefined} />

      {d.simulations.length ? (
        <section className="rounded-xl border border-line bg-panel p-5">
          <h2 className="text-sm font-medium">Recent simulations</h2>
          <table className="mt-2 w-full text-left text-sm tabular-nums">
            <thead className="text-xs uppercase tracking-wide text-muted"><tr>{["When", "Road", "Change", "Vehicle-hours", "Average trip"].map((h) => <th key={h} className="py-1.5 pr-4 font-medium">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-line">
              {d.simulations.map((s) => (
                <tr key={s.id}><td className="py-1.5 pr-4 text-xs text-muted">{at(s.created_at)}</td><td className="py-1.5 pr-4">{s.road}</td>
                  <td className="py-1.5 pr-4 text-muted">{ACTION_LABEL[s.action]}{s.action === "reduce_capacity" ? ` to ${Math.round((s.params.capacity_factor ?? 0) * 100)}%` : s.action === "add_demand" ? ` (+${fmt.int(s.params.extra_trips)}/h)` : ""}</td>
                  <td className="py-1.5 pr-4">{s.vehicle_hours_change_pct != null ? `${s.vehicle_hours_change_pct >= 0 ? "+" : ""}${s.vehicle_hours_change_pct}%` : "—"}</td>
                  <td className="py-1.5 pr-4">{fmt.one(s.avg_trip_minutes_before)} → {fmt.one(s.avg_trip_minutes_after)} min</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <details className="group rounded-xl border border-line bg-panel">
        <summary className="cursor-pointer list-none px-5 py-3 text-sm font-medium text-ink [&::-webkit-details-marker]:hidden">
          <span className="mr-1.5 inline-block text-muted transition-transform group-open:rotate-90">›</span>How the models were tested
          <span className="ml-2 text-xs font-normal text-muted">accuracy against simple baselines, on held-out data</span>
        </summary>
        <div className="grid gap-4 border-t border-line p-4 lg:grid-cols-2">
        <ModelCard title="Congestion forecasting" method={d.runs["traffic-congestion"]?.method} trainedAt={d.runs["traffic-congestion"]?.trained_at} demo={d.runs["traffic-congestion"]?.is_demo}
          columns={["Horizon", "XGBoost MAE", "No change", "Usual for the time", "XGBoost RMSE"]}
          rows={H.filter((h) => cm[`${h}min`]).map((h) => [`${h} minutes`, `${cm[`${h}min`].xgboost.mae} km/h`, `${cm[`${h}min`].no_change.mae} km/h`, `${cm[`${h}min`].usual_for_time.mae} km/h`, `${cm[`${h}min`].xgboost.rmse} km/h`])}
          note="Mean absolute error in speed on the last two days, held out. Inputs: recent speeds, the same time yesterday, the road's usual speed at that time, hour, weekday, rain, incidents, lanes and limit." />
        <ModelCard title="What-if simulation" method={d.runs["traffic-assignment"]?.method} trainedAt={d.runs["traffic-assignment"]?.trained_at} demo={d.runs["traffic-assignment"]?.is_demo}
          columns={["Measure", "Value"]}
          rows={[["Peak-hour trips", fmt.int(am.peak_hour_trips)], ["Roads", fmt.int(am.roads)], ["Junctions", fmt.int(am.junctions)]]}
          note="Trips between junctions follow a gravity model on ward population, calibrated so the busiest tenth of roads run near capacity. Travel time rises with volume over capacity (BPR). This is a simplified macroscopic model, not a microsimulation such as SUMO, and its results are simulated." />
        </div>
      </details>
    </div>
  );
}
