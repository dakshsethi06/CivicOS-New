import Link from "next/link";
import { AlertTriangle, Droplets, Gauge, Trash2 } from "lucide-react";
import { ChartCard } from "@/components/dashboard/charts";
import { KpiCard } from "@/components/dashboard/panels";
import { MultiBarChart } from "@/components/ops/charts";
import { fmt } from "@/lib/dashboard";
import { RISK_COLOR } from "@/lib/ops";

type Levels = Partial<Record<"low" | "medium" | "high", number>>;
export type OpsSummary = {
  is_synthetic: boolean;
  water: { consumption_24h_m3: number | null; consumption_prev_week_m3: number | null; open_anomalies: number; reservoirs_at_risk: number };
  risk: { pipes: Levels | null; bins: Levels | null; roads: Levels | null; reservoirs: Levels | null };
  waste: { bins: number; full_now: number; overflow_24h: number } | null;
  collection: { avg_fill_at_collection: number | null; hours_full_pct: number | null } | null;
  traffic: { monitored: number; avg_congestion_now: number | null; heavy_now: number } | null;
} | null;

/** The dashboard's operations block: water, waste and traffic KPIs and the infrastructure risk distribution. */
export function OpsStrip({ s }: { s: OpsSummary }) {
  if (!s) return null;
  const w = s.water;
  const change = w.consumption_24h_m3 && w.consumption_prev_week_m3 ? (w.consumption_24h_m3 / w.consumption_prev_week_m3 - 1) * 100 : null;
  const risk = [
    { asset: "Pipes (failure in 12 months)", ...s.risk.pipes },
    { asset: "Bins (full within 24 hours)", ...s.risk.bins },
    { asset: "Roads (congestion in 1 hour)", ...s.risk.roads },
    { asset: "Reservoirs (shortage in 7 days)", ...s.risk.reservoirs },
  ].map((r) => ({ asset: r.asset, high: r.high ?? 0, medium: r.medium ?? 0, low: r.low ?? 0 }));

  return (
    <section className="space-y-3 rounded-xl border border-warn/40 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">
          Operations{s.is_synthetic ? <span className="ml-2 rounded bg-warn/20 px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-warn">Demo data</span> : null}
        </h2>
        <p className="text-xs text-muted">
          <Link href="/water/network" className="hover:text-ink">Water network</Link> · <Link href="/waste/operations" className="hover:text-ink">Bins and routes</Link> ·{" "}
          <Link href="/traffic" className="hover:text-ink">Traffic</Link>
        </p>
      </div>
      {s.is_synthetic ? (
        <p className="text-xs text-muted">Sensor-level readings on a synthetic network inside the real wards, to show the models. Not measurements, and kept apart from the published figures.</p>
      ) : null}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={Droplets} label="Water consumption, last 24 hours" value={fmt.int(w.consumption_24h_m3)} unit="m³"
                 note={change != null ? `${change >= 0 ? "+" : ""}${change.toFixed(1)}% against a week earlier` : undefined} />
        <KpiCard icon={AlertTriangle} label="Predicted infrastructure risks" value={fmt.int((s.risk.pipes?.high ?? 0) + w.reservoirs_at_risk + w.open_anomalies)}
                 note={`${s.risk.pipes?.high ?? 0} pipes at high risk · ${w.open_anomalies} open anomalies · ${w.reservoirs_at_risk} reservoirs`} />
        <KpiCard icon={Trash2} label="Waste collection efficiency" value={fmt.one(s.collection?.avg_fill_at_collection)} unit="% full when emptied"
                 note={`Bins full ${fmt.two(s.collection?.hours_full_pct)}% of the time · ${s.waste?.overflow_24h ?? 0} likely to fill in 24 h`} />
        <KpiCard icon={Gauge} label="Traffic congestion now" value={s.traffic?.avg_congestion_now != null ? String(Math.round(s.traffic.avg_congestion_now * 100)) : "—"} unit="%"
                 note={`${s.traffic?.heavy_now ?? 0} of ${s.traffic?.monitored ?? 0} monitored roads heavy`} />
      </div>
      <ChartCard title="Infrastructure risk distribution" question="How much of each kind of asset is at risk?"
        table={{ columns: ["Asset", "High", "Medium", "Low"], rows: risk.map((r) => [r.asset, r.high, r.medium, r.low]) }}>
        <MultiBarChart data={risk} xKey="asset" stacked height={220}
                       keys={[{ key: "high", label: "High", color: RISK_COLOR.high }, { key: "medium", label: "Medium", color: RISK_COLOR.medium },
                              { key: "low", label: "Low", color: RISK_COLOR.low }]} />
      </ChartCard>
    </section>
  );
}
