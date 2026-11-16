"use client";

import { useState, useTransition } from "react";
import { simulate } from "@/app/(app)/ops-actions";
import { OpsMap, type OpsLayer } from "@/components/ops/ops-map";
import { fmt } from "@/lib/dashboard";
import { ACTION_LABEL, type SimResult } from "@/lib/ops";

type RoadOption = { id: string; name: string; lanes: number; capacity_vph: number; volume_now: number | null };
const input = "h-9 rounded-lg border border-line bg-raised px-2.5 text-sm text-ink focus:border-accent focus:outline-none";

function line(coords: [number, number][], props: Record<string, unknown>): GeoJSON.Feature {
  return { type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: props };
}

/** What-if: pick a road and a change, re-run the peak-hour assignment, see where traffic goes. */
export function Simulator({ roads, wards, allowed, reason }: { roads: RoadOption[]; wards: GeoJSON.FeatureCollection | null; allowed: boolean; reason?: string }) {
  const busiest = [...roads].sort((a, b) => (b.volume_now ?? 0) - (a.volume_now ?? 0))[0];
  const [roadId, setRoadId] = useState(busiest?.id ?? roads[0]?.id ?? "");
  const [action, setAction] = useState("close");
  const [factor, setFactor] = useState(0.5);
  const [extra, setExtra] = useState(1500);
  const [result, setResult] = useState<SimResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function run(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    start(async () => {
      const r = await simulate({ road_id: roadId, action, capacity_factor: factor, extra_trips: extra });
      if (r.ok) setResult(r.result);
      else setMessage(r.message);
    });
  }

  const layers: OpsLayer[] = result ? [
    { id: "affected", label: "Roads whose traffic changed most", kind: "line",
      data: { type: "FeatureCollection", features: result.most_affected_roads.map((r) => line(r.coords, {
        name: r.name, change: r.change, before: r.flow_before, after: r.flow_after, vc_after: r.vc_after, min_before: r.minutes_before, min_after: r.minutes_after })) },
      color: ["case", [">", ["get", "change"], 0], "#d03b3b", "#2a78d6"] as never,
      width: ["interpolate", ["linear"], ["abs", ["get", "change"]], 0, 2, 3000, 8] as never, title: "name",
      fields: [{ key: "change", label: "Change", unit: "vehicles/h", digits: 0 }, { key: "before", label: "Before", unit: "vehicles/h", digits: 0 },
               { key: "after", label: "After", unit: "vehicles/h", digits: 0 }, { key: "vc_after", label: "Volume / capacity after", digits: 2 },
               { key: "min_before", label: "Travel time before", unit: "min", digits: 1 }, { key: "min_after", label: "Travel time after", unit: "min", digits: 1 }] },
    { id: "road", label: "Road changed", kind: "line", data: { type: "FeatureCollection", features: [line(result.road.coords, { name: result.road.name })] },
      color: "#111827", width: 5, dashed: true, title: "name" },
    ...(result.detour ? [
      { id: "before", label: "Busiest affected trip, before", kind: "line" as const, data: { type: "FeatureCollection" as const, features: [line(result.detour.before, { name: "Before" })] },
        color: "#8a94a6", width: 3 },
      { id: "after", label: "Same trip, after", kind: "line" as const, data: { type: "FeatureCollection" as const, features: [line(result.detour.after, { name: "After" })] },
        color: "#eb6834", width: 3, dashed: true },
    ] : []),
  ] : [];

  return (
    <section className="space-y-4 rounded-xl border border-line bg-panel p-5">
      <div>
        <h2 className="text-sm font-medium">What-if simulation</h2>
        <p className="mt-0.5 text-xs text-muted">
          Close a road, cut its capacity or add trips around it, and see how peak-hour traffic redistributes. Results are simulated on the
          demonstration road network, not measured.
        </p>
      </div>
      <form onSubmit={run} className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-56 flex-1 flex-col gap-1 text-xs text-muted">Road
          <select className={input} value={roadId} onChange={(e) => setRoadId(e.target.value)}>
            {roads.map((r) => <option key={r.id} value={r.id}>{r.name} · {r.lanes} lane{r.lanes > 1 ? "s" : ""}{r.volume_now != null ? ` · ${fmt.int(r.volume_now)} veh/h now` : ""}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">Change
          <select className={input} value={action} onChange={(e) => setAction(e.target.value)}>
            {Object.entries(ACTION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        {action === "reduce_capacity" ? (
          <label className="flex flex-col gap-1 text-xs text-muted">Capacity left
            <select className={input} value={factor} onChange={(e) => setFactor(Number(e.target.value))}>
              {[0.25, 0.5, 0.75].map((f) => <option key={f} value={f}>{f * 100}% (e.g. {f === 0.5 ? "one of two lanes" : f === 0.25 ? "one of four lanes" : "works narrowing"})</option>)}
            </select>
          </label>
        ) : null}
        {action === "add_demand" ? (
          <label className="flex flex-col gap-1 text-xs text-muted">Extra trips per hour
            <input type="number" className={`${input} w-32`} min={100} max={20000} step={100} value={extra} onChange={(e) => setExtra(Number(e.target.value))} />
          </label>
        ) : null}
        <button type="submit" disabled={!allowed || pending || !roadId} className="h-9 rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink disabled:cursor-not-allowed disabled:opacity-50">
          {pending ? "Simulating…" : "Run simulation"}
        </button>
      </form>
      {!allowed && reason ? <p className="text-xs text-faint">{reason}</p> : null}
      {message ? <p role="alert" className="text-sm text-danger">{message}</p> : null}

      {result ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              ["Total vehicle-hours", `${fmt.int(result.vehicle_hours_before)} → ${fmt.int(result.vehicle_hours_after)}`, result.vehicle_hours_change_pct != null ? `${result.vehicle_hours_change_pct >= 0 ? "+" : ""}${result.vehicle_hours_change_pct}%` : ""],
              ["Average trip", `${fmt.one(result.avg_trip_minutes_before)} → ${fmt.one(result.avg_trip_minutes_after)} min`, ""],
              ["Busiest affected trip", result.detour ? `${fmt.one(result.detour.minutes_before)} → ${fmt.one(result.detour.minutes_after)} min` : "—", result.detour ? "Grey: before · orange: after" : ""],
              ["Trips with no route left", fmt.int(result.trips_cut_off), result.trips_cut_off ? "The road was the only link" : "Every trip can still be made"],
            ].map(([label, value, note]) => (
              <div key={label} className="rounded-lg border border-line bg-raised p-3">
                <p className="text-xs text-muted">{label}</p><p className="mt-1 text-lg font-semibold tabular-nums">{value}</p><p className="text-xs text-faint">{note}</p>
              </div>
            ))}
          </div>
          <OpsMap key={`${result.road.key}-${result.vehicle_hours_after}`} wards={wards} layers={layers} height="h-[420px]"
                  legend={[{ label: "More traffic", color: "#d03b3b", shape: "line" }, { label: "Less traffic", color: "#2a78d6", shape: "line" }, { label: "Road changed", color: "#111827", shape: "line" }]}
                  note={`${result.label}. ${result.method}.`} />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm tabular-nums">
              <thead className="text-xs uppercase tracking-wide text-muted"><tr>{["Road", "Vehicles/h before", "After", "Change", "V/C after", "Minutes before", "After"].map((h) => <th key={h} className="py-1.5 pr-4 font-medium">{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-line">
                {result.most_affected_roads.map((r) => (
                  <tr key={r.road_key}><td className="py-1.5 pr-4 text-ink">{r.name}</td><td className="py-1.5 pr-4">{fmt.int(r.flow_before)}</td><td className="py-1.5 pr-4">{fmt.int(r.flow_after)}</td>
                    <td className="py-1.5 pr-4" style={{ color: r.change > 0 ? "#d03b3b" : "#2a78d6" }}>{r.change > 0 ? "+" : ""}{fmt.int(r.change)}</td>
                    <td className="py-1.5 pr-4">{fmt.two(r.vc_after)}</td><td className="py-1.5 pr-4">{fmt.one(r.minutes_before)}</td><td className="py-1.5 pr-4">{fmt.one(r.minutes_after)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}
