import "server-only";
import { apiConfigured } from "./api";
import type { OpsStatus } from "./ops";
import { createClient } from "./supabase/server";

/** Everything an operations page needs, in parallel: its data, the job/dataset status, ward outlines and the ward list. */
export async function loadOps<T>(fn: "ops_water" | "ops_waste" | "ops_traffic", zone: string | null) {
  const supabase = await createClient();
  const [data, status, map, zones] = await Promise.all([
    supabase.rpc(fn, { p_zone: zone }),
    supabase.rpc("ops_status"),
    supabase.rpc("map_data", {}),
    supabase.from("city_zones").select("id, code, name").order("code"),
  ]);
  const wards = ((map.data as { zones?: GeoJSON.FeatureCollection } | null)?.zones ?? null) as GeoJSON.FeatureCollection | null;
  // outlines only: drop the published figures from the ward properties
  const outlines: GeoJSON.FeatureCollection | null = wards
    ? { type: "FeatureCollection", features: wards.features.map((f) => ({ ...f, properties: { code: f.properties?.code, name: f.properties?.name } })) }
    : null;
  return {
    data: data.data as T | null,
    error: data.error?.message ?? null,
    status: status.data as OpsStatus | null,
    wards: outlines,
    zones: (zones.data ?? []).map((z) => ({ id: z.id as string, name: `${z.code} · ${z.name}` })),
    apiReady: apiConfigured(),
  };
}

export const noteOf = (sp: Record<string, string | string[] | undefined>) => (typeof sp.note === "string" ? sp.note : undefined);
