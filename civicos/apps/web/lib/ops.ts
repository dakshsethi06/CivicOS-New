/** Types for the operations reads (supabase/migrations/0018_operations.sql) and small helpers shared by the pages. */

type FC<P> = GeoJSON.Feature<GeoJSON.Geometry, P>[];
export type Run<M = Record<string, unknown>> = { method: string; trained_at: string; metrics: M; is_demo: boolean };
export type ErrPair = { mae: number; rmse: number };

export type OpsStatus = {
  dataset: { kind: "demo" | "connected"; generated_at: string; seed: number | null } | null;
  predictions_enabled: boolean;
  job: { id: string; kind: string; status: "queued" | "running" | "done" | "failed"; step: string | null; error: string | null;
         created_at: string; finished_at: string | null } | null;
  runs: { model: string; method: string; trained_at: string; is_demo: boolean }[];
};

export type Factor = { factor: string; value: number; effect: string; weight: number };
export type PipeProps = { id: string; code: string; material: string; diameter_mm: number; installed_year: number; length_m: number;
                          failures_5y: number; risk: number | null; level: "low" | "medium" | "high" | null; factors: Factor[] | null; zone_id: string };
export type Anomaly = { id: number; sensor: string; zone: string | null; zone_code: string | null; started_at: string; ended_at: string;
                        level: "suspicious" | "high"; score: number; pattern: string; status: string;
                        evidence: { hours?: number; consumption_vs_baseline_pct?: number; pressure_change_bar?: number; night_consumption_vs_baseline_pct?: number | null };
                        point: GeoJSON.Point | null };
export type Reservoir = { code: string; name: string; zone_id: string; capacity_ml: number; point: GeoJSON.Point | null; current_pct: number | null;
                          projected_pct: number[] | null; min_pct: number | null; days_to_20pct: number | null; risk: string | null;
                          levels: { ts: string; pct: number }[] | null };

export type WaterOps = {
  last_reading: string | null;
  is_synthetic: boolean;
  runs: Partial<Record<"water-anomaly" | "water-demand" | "water-pipe-risk" | "water-shortage", Run>>;
  kpis: { consumption_24h_m3: number | null; consumption_prev_week_m3: number | null; open_anomalies: number; high_anomalies_7d: number;
          high_risk_pipes: number; pipes: number; reservoirs_at_risk: number };
  hourly: { ts: string; m3: number }[];
  hourly_forecast: { ts: string; m3: number; lower: number; upper: number }[];
  daily: { day: string; m3: number }[];
  daily_forecast: { day: string; m3: number; lower: number; upper: number }[];
  zones: { zone_id: string; code: string; name: string; m3_per_day: number; litres_per_person: number | null; vs_prev_week_pct: number | null }[];
  anomalies: Anomaly[];
  anomaly_days: { day: string; suspicious: number; high: number }[];
  pipelines: FC<PipeProps>;
  sensors: FC<{ code: string; zone_id: string; flow_lps: number | null; pressure_bar: number | null; level: number | null }>;
  reservoirs: Reservoir[];
};

export type BinProps = { code: string; kind: string; capacity_l: number; zone_id: string; collect_every_h: number; fill_now: number | null;
                         fill_6h: number | null; fill_12h: number | null; fill_24h: number | null; p6: number | null; p12: number | null; p24: number | null };
export type RoutePlan = { zone_id: string; zone: string; kind: "optimised" | "fixed"; planned_for: string; distance_km: number; minutes: number;
                          bins_visited: number; priority_bins: number; priority_covered: number; solver: string;
                          routes: { vehicle: string | null; stops: string[]; distance_km: number; minutes: number; load_l: number; geometry: GeoJSON.LineString }[] };
export type WasteOps = {
  last_reading: string | null;
  is_synthetic: boolean;
  runs: Partial<Record<"waste-overflow" | "waste-routes", Run>>;
  kpis: { bins: number; full_now: number; overflow_6h: number; overflow_12h: number; overflow_24h: number; avg_fill: number | null };
  bins: FC<BinProps>;
  generation: { day: string; litres: number }[];
  by_hour: { hour: number; fill: number }[];
  zones: { zone_id: string; code: string; name: string; avg_fill_at_collection: number | null; hours_full_pct: number | null; collections: number }[];
  plans: RoutePlan[];
  vehicles: { code: string; zone_id: string; capacity_l: number; depot: GeoJSON.Point }[];
};

export type RoadProps = { id: string; code: string; name: string; lanes: number; speed_limit: number; capacity_vph: number; length_m: number;
                          monitored: boolean; zone_id: string; speed_now: number | null; volume_now: number | null; incident_now: boolean | null;
                          congestion_now: number | null; travel_min_now: number | null;
                          forecast: Record<"15" | "30" | "60", { speed: number; congestion: number; level: string }> | null; incidents_365d: number };
export type TrafficOps = {
  last_reading: string | null;
  is_synthetic: boolean;
  runs: Partial<Record<"traffic-congestion" | "traffic-assignment", Run>>;
  roads: FC<RoadProps>;
  by_hour: { hour: number; weekday: number | null; weekend: number | null }[];
  recent: { ts: string; congestion: number; speed: number }[];
  incidents: { kind: string; severity: string; occurred_at: string; duration_min: number; point: GeoJSON.Point | null; road: string | null }[];
  incidents_by_kind: { kind: string; severity: string; count: number }[];
  simulations: { id: string; road: string | null; action: string; params: Record<string, number>; created_at: string;
                 vehicle_hours_change_pct: number | null; avg_trip_minutes_before: number | null; avg_trip_minutes_after: number | null }[];
};

export type SimResult = {
  label: string; road: { key: string; name: string; action: string; coords: [number, number][] };
  vehicle_hours_before: number; vehicle_hours_after: number; vehicle_hours_change_pct: number | null;
  avg_trip_minutes_before: number; avg_trip_minutes_after: number; trips_cut_off: number;
  most_affected_roads: { road_key: string; name: string; flow_before: number; flow_after: number; change: number; vc_before: number | null;
                         vc_after: number | null; minutes_before: number; minutes_after: number | null; coords: [number, number][] }[];
  detour: { minutes_before: number; minutes_after: number; before: [number, number][]; after: [number, number][] } | null;
  method: string;
};

export const ACTION_LABEL: Record<string, string> = { close: "Close the road", reduce_capacity: "Reduce its capacity", add_demand: "Add trips around it" };

export const RISK_COLOR = { low: "#1baf7a", medium: "#fab219", high: "#d03b3b" } as const;
export const CONGESTION_COLOR = { "free flow": "#1baf7a", moderate: "#fab219", heavy: "#ec835a", severe: "#d03b3b" } as const;

export function congestionLevel(c: number | null | undefined): keyof typeof CONGESTION_COLOR | null {
  if (c == null) return null;
  return c < 0.2 ? "free flow" : c < 0.4 ? "moderate" : c < 0.6 ? "heavy" : "severe";
}

const IST = { timeZone: "Asia/Kolkata" } as const;
export const at = (iso: string | null | undefined, withDate = true) =>
  iso ? new Date(iso).toLocaleString("en-IN", { ...IST, ...(withDate ? { day: "numeric", month: "short" } : {}), hour: "2-digit", minute: "2-digit" }) : "—";
export const dayLabel = (iso: string) => new Date(iso + (iso.length === 10 ? "T00:00:00+05:30" : "")).toLocaleDateString("en-IN", { ...IST, day: "numeric", month: "short" });
export const pct = (v: number | null | undefined, digits = 0) => (v == null ? "—" : `${(v * 100).toFixed(digits)}%`);
