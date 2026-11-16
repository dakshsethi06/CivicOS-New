import type { Metadata } from "next";
import { Building2, Clock, MessageSquareWarning, Trash2 } from "lucide-react";
import { BarSeriesChart, ChartCard, EmptyChart, LineSeriesChart } from "@/components/dashboard/charts";
import { KpiCard } from "@/components/dashboard/panels";
import { ModuleFilters } from "@/components/module-filters";
import { SubNav } from "@/components/ops/panels";
import { requireSession } from "@/lib/auth";
import { SERIES } from "@/lib/chart-colors";
import { cite, fmt } from "@/lib/dashboard";
import { parseFilters } from "@/lib/filters";
import { reader, type IndicatorData } from "@/lib/indicators";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Waste" };

const METRICS = [
  "waste_tonnes_per_day", "waste_tonnes_per_day_other_facilities", "waste_per_capita", "waste_total",
  "complaints_registered", "complaints_closed", "avg_days_to_close",
  "bwg_societies", "bwg_giving_waste_to_bmc", "bwg_not_processing_on_site_pct", "slum_population_pct",
];
const SWM = "Solid Waste Management (SWM)";
const WASTE_VIEWS = [{ href: "/waste", label: "Published figures" }, { href: "/waste/operations", label: "Bins and routes (demo)" }];

export default async function WastePage({ searchParams }: PageProps<"/waste">) {
  await requireSession();
  const filters = parseFilters(await searchParams);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("indicator_rows", { p_metrics: METRICS });
  const d = data as IndicatorData | null;

  if (error || !d || d.rows.length === 0) {
    return (
      <div className="mx-auto max-w-6xl space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Waste</h1>
        <p className="break-words rounded-xl border border-line bg-panel p-6 text-sm text-muted">{error?.message ?? "No published waste figures are loaded for this workspace."}</p>
      </div>
    );
  }

  const q = reader(d.rows);
  const ward = d.wards.find((w) => w.id === filters.zone) ?? null;
  const code = ward?.code ?? null;
  const scope = ward?.name ?? "Mumbai";
  const years = q.years("waste_tonnes_per_day");
  const year = filters.year && years.includes(filters.year) ? filters.year : years.at(-1)!;
  const col = (key: string, label: string) => ({ key, label, color: SERIES.one });

  const byWard = q.byWard("waste_tonnes_per_day", year).map((r) => ({ ward: r.ward, tpd: r.value }));
  const trend = q.series("waste_tonnes_per_day", code).map((r) => ({ year: r.year, tpd: r.value }));
  const perCapYear = q.years("waste_per_capita").at(-1)!;
  const perCap = q.byWard("waste_per_capita", perCapYear).map((r) => ({ ward: r.ward, kg: r.value }));
  const swm = q.series("complaints_registered", code, SWM).map((r) => ({ year: r.year, registered: r.value }));
  const closureYear = q.all("avg_days_to_close", { category: SWM }).filter((r) => r.ward != null).map((r) => r.year).sort().at(-1);
  const daysByWard = closureYear ? q.byWard("avg_days_to_close", closureYear, SWM).map((r) => ({ ward: r.ward, days: r.value })) : [];
  const bwg = q.byWard("bwg_not_processing_on_site_pct", 2025).map((r) => ({ ward: r.ward, pct: r.value }));
  const swmNow = swm.find((r) => r.year === year)?.registered ?? null;
  const swmDays = closureYear ? q.one("avg_days_to_close", { ward: code, year: closureYear, category: SWM }) : null;
  const bwgTotal = q.one("bwg_societies", { ward: code, year: 2025 });
  const bwgPct = q.one("bwg_not_processing_on_site_pct", { ward: code, year: 2025 });
  const prev = trend.find((r) => r.year === year - 1)?.tpd;
  const now = trend.find((r) => r.year === year)?.tpd ?? null;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Waste</h1>
        <p className="mt-1 text-sm text-muted">{scope} · {year} · waste lifted, bulk generators and solid-waste complaints from published BMC figures</p>
      </div>
      <SubNav items={WASTE_VIEWS} active="/waste" />

      <ModuleFilters wards={d.wards} ward={filters.zone} years={years} year={year} />

      <div className="stagger grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={Trash2} label="Waste lifted" value={fmt.int(now)} unit="t / day" note={prev && now ? `${now >= prev ? "+" : ""}${(((now - prev) / prev) * 100).toFixed(0)}% against ${year - 1}` : `Average in ${year}`} />
        <KpiCard icon={MessageSquareWarning} label="Solid-waste complaints" value={fmt.int(swmNow)} note={`Registered in ${year}`} />
        <KpiCard icon={Clock} label="Days to close a waste complaint" value={fmt.int(swmDays)} unit="days" note={closureYear ? `Average in ${closureYear}` : "Not published"} />
        <KpiCard icon={Building2} label="Bulk generators not processing on site" value={fmt.int(bwgPct)} unit="%" note={bwgTotal != null ? `Of ${fmt.int(bwgTotal)} societies, 2025` : "Not published"} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard
          title={`Waste lifted by ward, tonnes per day, ${year}`}
          question="Which wards generate the most waste?"
          source={cite(d.sources, ["p26-t37"])}
          table={{ columns: ["Ward", "Tonnes per day"], rows: byWard.map((r) => [r.ward, r.tpd]) }}
        >
          <BarSeriesChart data={byWard} xKey="ward" unit="t/day" series={col("tpd", "Waste lifted")} />
        </ChartCard>

        <ChartCard
          title={`Waste lifted per year, tonnes per day: ${scope}`}
          question="Is the amount of waste growing?"
          note={code ? "From 2023 the report lists waste handled at transfer stations separately, so ward figures drop that year for reporting reasons." : "The city total includes waste handled at transfer stations."}
          source={cite(d.sources, ["p26-t37"])}
          table={{ columns: ["Year", "Tonnes per day"], rows: trend.map((r) => [r.year, r.tpd]) }}
        >
          {trend.length ? <BarSeriesChart data={trend} xKey="year" unit="t/day" series={col("tpd", "Waste lifted")} /> : <EmptyChart />}
        </ChartCard>

        <ChartCard
          title={`Waste per person by ward, kg per day, ${perCapYear}`}
          question="Where does each resident generate the most waste?"
          note="Commercial districts score high because waste from offices and markets is divided by few residents."
          source={cite(d.sources, ["p26-t11"])}
          table={{ columns: ["Ward", "Kg per person per day"], rows: perCap.map((r) => [r.ward, r.kg]) }}
        >
          <BarSeriesChart data={perCap} xKey="ward" unit="kg" series={col("kg", "Waste per person")} />
        </ChartCard>

        <ChartCard
          title={`Solid-waste complaints per year: ${scope}`}
          question="Are waste complaints rising?"
          source={cite(d.sources, [code ? "p26-t39" : "p26-t1"])}
          table={{ columns: ["Year", "Complaints registered"], rows: swm.map((r) => [r.year, r.registered]) }}
        >
          {swm.length ? <LineSeriesChart data={swm} xKey="year" xType="year" series={[col("registered", "Solid-waste complaints")]} /> : <EmptyChart />}
        </ChartCard>

        <ChartCard
          title={`Average days to close a solid-waste complaint by ward, ${closureYear ?? ""}`}
          question="Which wards clear waste complaints fastest?"
          source={cite(d.sources, ["p26-t40"])}
          table={{ columns: ["Ward", "Average days to close"], rows: daysByWard.map((r) => [r.ward, r.days]) }}
        >
          {daysByWard.length ? <BarSeriesChart data={daysByWard} xKey="ward" unit="days" series={col("days", "Average days to close")} /> : <EmptyChart />}
        </ChartCard>

        <ChartCard
          title="Bulk waste generators not processing waste on site, % of societies, 2025"
          question="Where are large housing societies sending waste to BMC, not composting it?"
          note="Societies generating over 100 kg a day are required to process wet waste on their premises."
          source={cite(d.sources, ["p26-t12"])}
          table={{ columns: ["Ward", "% not processing on site"], rows: bwg.map((r) => [r.ward, r.pct]) }}
        >
          <BarSeriesChart data={bwg} xKey="ward" unit="%" series={col("pct", "Not processing on site")} />
        </ChartCard>
      </div>

      <p className="rounded-xl border border-line bg-panel p-5 text-xs leading-relaxed text-muted">
        <span className="font-medium text-ink">Published figures only.</span> Bin fill levels, overflow prediction and truck routing need bin sensors and vehicle logs that BMC does not publish. The <a href="/waste/operations" className="text-accent hover:underline">Bins and routes</a> view shows those models on a clearly labelled demonstration dataset, kept apart from these figures.
      </p>
    </div>
  );
}
