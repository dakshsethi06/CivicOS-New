import type { Metadata } from "next";
import { FilterBar } from "@/components/filter-bar";
import { CityMap, type MapData } from "@/components/map/city-map";
import { OpsMap, type OpsLayer } from "@/components/ops/ops-map";
import { CONGESTION_COLOR, RISK_COLOR } from "@/lib/ops";

type FC = GeoJSON.FeatureCollection;
type MapLayers = { is_synthetic: boolean; complaints: FC; pipes: FC; anomalies: FC; bins: FC; roads: FC; incidents: FC };
import { requireSession } from "@/lib/auth";
import { parseFilters } from "@/lib/filters";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "City Map" };

export default async function MapPage({ searchParams }: PageProps<"/map">) {
  await requireSession();
  const filters = parseFilters(await searchParams);
  const supabase = await createClient();

  const [{ data, error }, city, extra] = await Promise.all([
    supabase.rpc("map_data", { p_year: filters.year, p_issue: filters.issue }),
    supabase.from("cities").select("name").limit(1).maybeSingle(),
    supabase.rpc("map_layers"),
  ]);
  const d = data as MapData | null;
  const cityName = city.data?.name ?? "City";
  const L = extra.data as MapLayers | null;
  const outlines: GeoJSON.FeatureCollection | null = d
    ? { type: "FeatureCollection", features: d.zones.features.map((f) => ({ ...f, properties: { code: f.properties.code } })) }
    : null;
  const layers: OpsLayer[] = L ? [
    { id: "complaints", label: "Complaints (CivicOS reports)", kind: "circle", data: L.complaints, radius: 6,
      color: ["match", ["get", "severity"], "critical", "#7a1f1f", "high", RISK_COLOR.high, "medium", RISK_COLOR.medium, RISK_COLOR.low] as never,
      title: "reference", fields: [{ key: "category", label: "Category" }, { key: "severity", label: "Priority" }, { key: "status", label: "Status" }, { key: "created", label: "Reported" }] },
    { id: "roads", label: "Roads: congestion now", kind: "line", data: L.roads, visible: false, width: ["+", 1, ["get", "lanes"]] as never,
      color: ["case", ["==", ["typeof", ["get", "congestion_now"]], "number"],
              ["step", ["get", "congestion_now"], CONGESTION_COLOR["free flow"], 0.2, CONGESTION_COLOR.moderate, 0.4, CONGESTION_COLOR.heavy, 0.6, CONGESTION_COLOR.severe], "#b8c0cc"] as never,
      title: "name", fields: [{ key: "congestion_now", label: "Congestion now", percent: true, digits: 0 }, { key: "congestion_60", label: "Forecast in 60 min", percent: true, digits: 0 }] },
    { id: "pipes", label: "Water pipes by failure risk", kind: "line", data: L.pipes, visible: false, width: 2,
      color: ["match", ["get", "level"], "high", RISK_COLOR.high, "medium", RISK_COLOR.medium, RISK_COLOR.low] as never,
      title: "code", fields: [{ key: "material", label: "Material" }, { key: "installed_year", label: "Installed", digits: 0 }, { key: "risk", label: "Failure risk, 12 months", percent: true, digits: 0 }] },
    { id: "anomalies", label: "Water anomalies (open)", kind: "circle", data: L.anomalies, visible: false, radius: 8,
      color: ["match", ["get", "level"], "high", RISK_COLOR.high, RISK_COLOR.medium] as never, title: "sensor",
      fields: [{ key: "pattern", label: "Pattern" }, { key: "started", label: "Started" }] },
    { id: "bins", label: "Bins: chance of filling in 24 h", kind: "circle", data: L.bins, visible: false, radius: 4,
      color: ["interpolate", ["linear"], ["coalesce", ["get", "p24"], 0], 0, RISK_COLOR.low, 0.5, RISK_COLOR.medium, 1, RISK_COLOR.high] as never,
      title: "code", fields: [{ key: "fill_now", label: "Full now", unit: "%" }, { key: "p24", label: "Chance full in 24 h", percent: true, digits: 0 }] },
    { id: "incidents", label: "Traffic incidents, last 90 days", kind: "circle", data: L.incidents, visible: false, radius: 4,
      color: ["match", ["get", "kind"], "accident", "#d03b3b", "waterlogging", "#2a78d6", "#fab219"] as never, title: "kind",
      fields: [{ key: "severity", label: "Severity" }, { key: "when", label: "When" }] },
  ] : [];

  return (
    <div className="mx-auto max-w-[1400px] space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">City Map</h1>
        <p className="mt-1 text-sm text-muted">
          {cityName} by ward{d?.year ? ` · ${d.year}` : ""} · click a ward for its figures
        </p>
      </div>

      {error || !d ? (
        <div className="rounded-xl border border-line bg-panel p-6 text-sm text-muted">
          The map query failed: {error?.message ?? "no data returned"}. Check that every migration in supabase/migrations has been run.
        </div>
      ) : d.zones.features.length === 0 ? (
        <div className="rounded-xl border border-line bg-panel p-6 text-sm text-muted">
          This workspace has no ward boundaries yet. Load a city dataset from the dashboard.
        </div>
      ) : (
        <>
          <FilterBar filters={filters} city={cityName} year={d.year} years={d.years ?? []} issues={d.ward_issues ?? []} />
          <CityMap data={d} issue={filters.issue} />
          {layers.length ? (
            <section className="space-y-2 pt-4">
              <h2 className="text-sm font-medium">
                Complaints, infrastructure and incidents
                {L?.is_synthetic ? <span className="ml-2 rounded bg-warn/20 px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-warn">Water, waste and traffic layers: demo data</span> : null}
              </h2>
              <OpsMap wards={outlines} layers={layers}
                note={`Complaints are real reports made through CivicOS (${L!.complaints.features.length} shown: open, or made in the last 90 days).${L!.is_synthetic ? " Pipes, anomalies, bins, roads and incidents are the labelled demonstration dataset." : ""} Tick a layer to show it; click a feature for details.`}
                legend={[{ label: "High / critical", color: RISK_COLOR.high }, { label: "Medium", color: RISK_COLOR.medium }, { label: "Low", color: RISK_COLOR.low }]} />
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
