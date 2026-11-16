"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import type { LngLatBoundsLike, Map as MlMap, Marker } from "maplibre-gl";
import { bounds, contains, DEFAULT_STYLE } from "@/lib/map-style";

type Zones = GeoJSON.FeatureCollection<GeoJSON.Geometry, { code: string; name: string }>;
type Props = {
  action: (formData: FormData) => void;
  categories: { id: string; name: string }[];
  wards: { id: string; code: string; name: string }[];
  zones: Zones | null;
};

const inputCls = "w-full rounded-lg border border-line bg-raised px-3 py-2.5 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="inline-flex items-center justify-center rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-ink hover:brightness-110 disabled:opacity-50">
      {pending ? "Submitting…" : "Submit complaint"}
    </button>
  );
}

/** Report form. Clicking the map drops a pin and picks the ward the pin falls in; the ward can also be chosen by hand. */
export function ReportForm({ action, categories, wards, zones }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const [point, setPoint] = useState<{ lon: number; lat: number } | null>(null);
  const [zone, setZone] = useState("");
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!zones || !container.current) return;
    let cancelled = false;
    let map: MlMap | null = null;
    (async () => {
      const ml = await import("maplibre-gl");
      if (cancelled || !container.current) return;
      map = new ml.Map({
        container: container.current,
        style: process.env.NEXT_PUBLIC_MAP_STYLE_URL || DEFAULT_STYLE,
        bounds: (bounds(zones) as LngLatBoundsLike) ?? undefined,
        fitBoundsOptions: { padding: 20 },
        attributionControl: { compact: true },
      });
      mapRef.current = map;
      map.addControl(new ml.NavigationControl({ showCompass: false }), "top-right");
      map.on("load", () => {
        map!.addSource("zones", { type: "geojson", data: zones });
        map!.addLayer({ id: "zones-fill", type: "fill", source: "zones", paint: { "fill-color": "#2a78d6", "fill-opacity": 0.12 } });
        map!.addLayer({ id: "zones-line", type: "line", source: "zones", paint: { "line-color": "#5b6577", "line-width": 1 } });
      });
      map.on("click", (e) => {
        const { lng, lat } = e.lngLat;
        const hit = zones.features.find((f) => contains(f.geometry, lng, lat));
        markerRef.current?.remove();
        markerRef.current = new ml.Marker({ color: "#0d8f78" }).setLngLat([lng, lat]).addTo(map!);
        setPoint({ lon: Number(lng.toFixed(6)), lat: Number(lat.toFixed(6)) });
        if (hit) {
          setZone(wards.find((w) => w.code === hit.properties.code)?.id ?? "");
          setNote(null);
        } else {
          setNote("That point is outside the ward boundaries. Choose the ward by hand if it is correct.");
        }
      });
    })();
    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [zones, wards]);

  return (
    <form action={action} className="grid gap-6 lg:grid-cols-[1fr_1fr]">
      <div className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">What is the problem?</span>
          <textarea name="description" required minLength={10} rows={5} className={inputCls} placeholder="For example: Garbage has not been lifted from the bin near the bus stop for three days." />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Category</span>
          <select name="category" className={inputCls} defaultValue="">
            <option value="">Not sure: suggest one from my description</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Ward</span>
          <select name="zone" className={inputCls} value={zone} onChange={(e) => setZone(e.target.value)}>
            <option value="">Not sure</option>
            {wards.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <span className="mt-1 block text-xs text-muted">Filled in automatically when you click the map.</span>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Photo (optional)</span>
          <input type="file" name="photo" accept="image/jpeg,image/png,image/webp" className="block w-full text-sm text-muted file:mr-3 file:rounded-lg file:border file:border-line file:bg-raised file:px-3 file:py-2 file:text-sm file:text-ink" />
          <span className="mt-1 block text-xs text-muted">JPEG, PNG or WebP, up to 5 MB. Visible to municipal staff.</span>
        </label>

        <input type="hidden" name="lon" value={point?.lon ?? ""} />
        <input type="hidden" name="lat" value={point?.lat ?? ""} />
        <Submit />
      </div>

      <div>
        <p className="mb-1.5 text-sm font-medium">Where is it? Click the map to drop a pin</p>
        <div className="h-[420px] overflow-hidden rounded-xl border border-line bg-panel">
          {zones ? <div ref={container} className="h-full w-full" role="application" aria-label="Pick the location" /> : (
            <p className="flex h-full items-center justify-center px-6 text-center text-sm text-muted">No ward map is loaded for this workspace. Choose the ward from the list.</p>
          )}
        </div>
        <p className="mt-2 text-xs text-muted" role="status">
          {point ? `Pin at ${point.lat}, ${point.lon}.` : "No pin yet. A pin lets staff find the spot and lets CivicOS flag duplicate reports nearby."}
          {note ? <span className="block text-warn">{note}</span> : null}
        </p>
      </div>
    </form>
  );
}
