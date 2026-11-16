import type { Metadata } from "next";
import { Clock, Droplets, FlaskConical, Gauge } from "lucide-react";
import { BarSeriesChart, ChartCard, EmptyChart, LineSeriesChart } from "@/components/dashboard/charts";
import { KpiCard } from "@/components/dashboard/panels";
import { ModuleFilters } from "@/components/module-filters";
import { requireSession } from "@/lib/auth";
import { SERIES } from "@/lib/chart-colors";
import { cite, fmt } from "@/lib/dashboard";
import { parseFilters } from "@/lib/filters";
import { reader, type IndicatorData } from "@/lib/indicators";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Water" };

const METRICS = [
  "water_supply_hours", "water_supply_zones", "water_zones_by_hours", "water_unfit_samples_pct",
  "water_yield_mld", "water_enroute_loss_mld", "water_supply_mld", "water_demand_mld", "water_gap_mld",
  "water_yield_fy", "water_supply_fy", "water_loss_fy", "water_loss_fy_pct",
  "complaints_registered", "complaints_closed", "avg_days_to_close",
];
const BANDS = ["<=2 hrs", ">2 to <=4 hrs", ">4 to <=8 hrs", ">8 to <=12 hrs", ">12 to <=18 hrs", ">18 to <24 hrs", "24 hrs", "Not available"];
const SHORT: Record<string, string> = {
  "<=2 hrs": "≤2", ">2 to <=4 hrs": "2–4", ">4 to <=8 hrs": "4–8", ">8 to <=12 hrs": "8–12",
  ">12 to <=18 hrs": "12–18", ">18 to <24 hrs": "18–24", "24 hrs": "24", "Not available": "No data",
};
const ISSUE = "Water Supply";

export default async function WaterPage({ searchParams }: PageProps<"/water">) {
  await requireSession();
  const filters = parseFilters(await searchParams);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("indicator_rows", { p_metrics: METRICS });
  const d = data as IndicatorData | null;

  if (error || !d || d.rows.length === 0) {
    return (
      <div className="mx-auto max-w-6xl space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Water</h1>
        <p className="break-words rounded-xl border border-line bg-panel p-6 text-sm text-muted">{error?.message ?? "No published water figures are loaded for this workspace."}</p>
      </div>
    );
  }

  const q = reader(d.rows);
  const ward = d.wards.find((w) => w.id === filters.zone) ?? null;
  const code = ward?.code ?? null;
  const scope = ward?.name ?? "Mumbai";
  const hoursYear = q.years("water_supply_hours").at(-1)!;
  const unfitYears = q.years("water_unfit_samples_pct");
  const unfitYear = filters.year && unfitYears.includes(filters.year) ? filters.year : unfitYears.at(-1)!;
  const col = (key: string, label: string) => ({ key, label, color: SERIES.one });

  const hoursByWard = q.byWard("water_supply_hours", hoursYear).map((r) => ({ ward: r.ward, hours: r.value }));
  const unfitByWard = q.byWard("water_unfit_samples_pct", unfitYear).map((r) => ({ ward: r.ward, pct: r.value }));
  const unfitTrend = q.series("water_unfit_samples_pct", code).map((r) => ({ year: r.year, pct: r.value }));
  const bands = BANDS.map((b) => ({
    band: SHORT[b],
    zones: q.all("water_zones_by_hours", { category: b, year: hoursYear }).filter((r) => (code ? r.ward === code : r.ward != null)).reduce((a, r) => a + r.value, 0),
  }));
  const fy = q.series("water_yield_fy", null).map((r) => ({
    year: `${r.year - 1}-${String(r.year).slice(2)}`,
    yield: r.value,
    supply: q.one("water_supply_fy", { ward: null, year: r.year }),
    loss_pct: q.one("water_loss_fy_pct", { ward: null, year: r.year }),
  }));
  const complaints = q.series("complaints_registered", null, ISSUE).map((r) => ({ year: r.year, registered: r.value }));
  const lastC = complaints.at(-1);
  const closed = lastC ? q.one("complaints_closed", { ward: null, year: lastC.year, category: ISSUE }) : null;
  const days = lastC ? q.one("avg_days_to_close", { ward: null, year: lastC.year, category: ISSUE }) : null;
  const supply = q.one("water_supply_mld", { ward: null });
  const demand = q.one("water_demand_mld", { ward: null });
  const gap = q.one("water_gap_mld", { ward: null });
  const shortest = [...hoursByWard].sort((a, b) => a.hours - b.hours).slice(0, 3).map((w) => w.ward).join(", ");

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Water</h1>
        <p className="mt-1 text-sm text-muted">{scope} · supply hours, quality, losses and complaints from published BMC figures</p>
      </div>

      <ModuleFilters wards={d.wards} ward={filters.zone} years={unfitYears} year={unfitYear} yearLabel="Water-quality year" />

      <div className="stagger grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={Clock} label="Water supply" value={fmt.two(q.one("water_supply_hours", { ward: code, year: hoursYear }))} unit="hrs / day" note={`Average in ${hoursYear}${code ? "" : " · shortest: " + shortest}`} />
        <KpiCard icon={FlaskConical} label="Samples found unfit" value={fmt.two(q.one("water_unfit_samples_pct", { ward: code, year: unfitYear }))} unit="%" note={`Drinking-water tests, ${unfitYear}`} />
        <KpiCard icon={Droplets} label="Supplied to the city" value={fmt.int(supply)} unit="MLD" note={demand ? `Against demand of ${fmt.int(demand)} MLD (2023-24)` : ""} />
        <KpiCard icon={Gauge} label="Supply shortfall" value={gap && demand ? fmt.int((100 * gap) / demand) : "—"} unit="%" note={gap ? `${fmt.int(gap)} MLD short, city-wide (2023-24)` : ""} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard
          title={`Water supply hours per day by ward, ${hoursYear}`}
          question="Which wards get the least water supply?"
          source={cite(d.sources, ["p25-t4"])}
          table={{ columns: ["Ward", "Average hours per day"], rows: hoursByWard.map((r) => [r.ward, r.hours]) }}
        >
          <BarSeriesChart data={hoursByWard} xKey="ward" unit="hrs" series={col("hours", "Supply hours per day")} />
        </ChartCard>

        <ChartCard
          title={`Supply zones by hours of water per day: ${scope}, ${hoursYear}`}
          question="How many supply zones get only a few hours of water?"
          note="Horizontal axis: hours of supply per day. Each ward is split into supply zones with their own timings."
          source={cite(d.sources, ["p25-t4"])}
          table={{ columns: ["Hours per day", "Zones"], rows: bands.map((b) => [b.band, b.zones]) }}
        >
          <BarSeriesChart data={bands} xKey="band" series={col("zones", "Supply zones")} />
        </ChartCard>

        <ChartCard
          title={`Drinking-water samples found unfit by ward, %, ${unfitYear}`}
          question="Where is drinking-water quality worst?"
          source={cite(d.sources, ["p25-t7"])}
          table={{ columns: ["Ward", "Unfit samples %"], rows: unfitByWard.map((r) => [r.ward, r.pct]) }}
        >
          <BarSeriesChart data={unfitByWard} xKey="ward" unit="%" series={col("pct", "Unfit samples")} />
        </ChartCard>

        <ChartCard
          title={`Drinking-water samples found unfit, %: ${scope}`}
          question="Is water quality improving?"
          source={cite(d.sources, ["p25-t7"])}
          table={{ columns: ["Year", "Unfit samples %"], rows: unfitTrend.map((r) => [r.year, r.pct]) }}
        >
          {unfitTrend.length ? <BarSeriesChart data={unfitTrend} xKey="year" unit="%" series={col("pct", "Unfit samples")} /> : <EmptyChart />}
        </ChartCard>

        <ChartCard
          title="Water drawn from sources and water supplied, MLD, Mumbai"
          question="How much water is lost between the lakes and the city?"
          note="By financial year. The gap between the two lines is water lost en route."
          source={cite(d.sources, ["p25-t2"])}
          table={{ columns: ["Financial year", "Yield (MLD)", "Supplied (MLD)", "Lost en route %"], rows: fy.map((r) => [r.year, r.yield, r.supply, r.loss_pct]) }}
        >
          <LineSeriesChart
            data={fy} xKey="year" xType="category" unit="MLD" zeroBased={false}
            series={[
              { key: "yield", label: "Drawn from sources", color: SERIES.one },
              { key: "supply", label: "Supplied to the city", color: SERIES.two },
            ]}
          />
          <p className="mt-2 text-xs text-faint">The vertical axis does not start at zero, so the gap is visible.</p>
        </ChartCard>

        <ChartCard
          title="Water supply complaints per year, Mumbai"
          question="Are water complaints rising?"
          note={lastC && closed != null ? `In ${lastC.year}, ${fmt.int(closed)} of ${fmt.int(lastC.registered)} were closed (${Math.round((100 * closed) / lastC.registered)}%), taking ${fmt.int(days)} days on average. The reports do not break water complaints down by ward.` : undefined}
          source={cite(d.sources, ["p26-t1", "p26-t2"])}
          table={{ columns: ["Year", "Complaints registered"], rows: complaints.map((r) => [r.year, r.registered]) }}
        >
          <LineSeriesChart data={complaints} xKey="year" xType="year" series={[col("registered", "Water supply complaints")]} />
        </ChartCard>
      </div>

      <p className="rounded-xl border border-line bg-panel p-5 text-xs leading-relaxed text-muted">
        <span className="font-medium text-ink">What is not here.</span> Pipeline maps, meter readings, pressure, reservoir levels and leak detection need sensor data that BMC does not publish, so CivicOS does not show them. If a utility shares such data, it can be loaded alongside these figures.
      </p>
    </div>
  );
}
