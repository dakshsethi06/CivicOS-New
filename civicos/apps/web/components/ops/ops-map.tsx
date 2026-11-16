"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import type { ExpressionSpecification, LngLatBoundsLike, Map as MlMap } from "maplibre-gl";
import { bounds, DEFAULT_STYLE } from "@/lib/map-style";

type Paint = string | number | ExpressionSpecification;
export type Field = { key: string; label: string; unit?: string; digits?: number; percent?: boolean };
export type OpsLayer = {
  id: string;
  label: string;
  kind: "line" | "circle";
  data: GeoJSON.FeatureCollection;
  color: Paint;
  width?: Paint;            // line width
  radius?: Paint;           // circle radius
  opacity?: number;
  dashed?: boolean;
  visible?: boolean;
  title?: string;           // property shown as the popup heading
  fields?: Field[];
};
export type LegendItem = { label: string; color: string; shape?: "line" | "dot" };

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

function value(raw: unknown, f: Field): string {
  if (raw == null || raw === "null" || raw === "") return "—";
  if (typeof raw === "boolean" || raw === "true" || raw === "false") return raw === true || raw === "true" ? "yes" : "no";
  const n = Number(raw);
  if (Number.isNaN(n)) return String(raw);
  const shown = f.percent ? n * 100 : n;
  return `${shown.toLocaleString("en-IN", { maximumFractionDigits: f.digits ?? 1 })}${f.percent ? "%" : f.unit ? ` ${f.unit}` : ""}`;
}

function popupHtml(layer: OpsLayer, p: Record<string, unknown>): string {
  const head = layer.title ? `<div style="font-weight:600;margin-bottom:4px">${esc(p[layer.title])}</div>` : "";
  const rows = (layer.fields ?? [])
    .map((f) => `<div><span style="color:#5b6577">${esc(f.label)}:</span> ${esc(value(p[f.key], f))}</div>`)
    .join("");
  return `${head}<div style="font-size:11px;color:#5b6577;margin-bottom:2px">${esc(layer.label)}</div>${rows}`;
}

/** A MapLibre map of ward outlines with toggleable line and point layers; click a feature for its details. */
export function OpsMap({
  wards, layers, legend, height = "h-[520px]", note,
}: { wards?: GeoJSON.FeatureCollection | null; layers: OpsLayer[]; legend?: LegendItem[]; height?: string; note?: string }) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [shown, setShown] = useState<Record<string, boolean>>(() => Object.fromEntries(layers.map((l) => [l.id, l.visible !== false])));

  useEffect(() => {
    let cancelled = false;
    let map: MlMap | null = null;
    (async () => {
      const ml = await import("maplibre-gl");
      if (cancelled || !container.current) return;
      const all: GeoJSON.FeatureCollection = {
        type: "FeatureCollection",
        features: [...(wards?.features ?? []), ...layers.flatMap((l) => l.data.features)].filter((f) => f.geometry),
      };
      const fit = bounds(all);
      map = new ml.Map({
        container: container.current,
        style: process.env.NEXT_PUBLIC_MAP_STYLE_URL || DEFAULT_STYLE,
        bounds: (fit as LngLatBoundsLike) ?? undefined,
        fitBoundsOptions: { padding: 30 },
        center: fit ? undefined : [72.88, 19.08],
        zoom: fit ? undefined : 10,
        attributionControl: { compact: true },
      });
      mapRef.current = map;
      map.addControl(new ml.NavigationControl({ showCompass: false }), "top-right");
      map.addControl(new ml.ScaleControl({ unit: "metric" }), "bottom-right");
      map.on("error", (e) => {
        if (!("sourceId" in e || "tile" in e)) setFailed(e.error?.message ?? "The map could not load.");
      });
      map.on("load", () => {
        if (!map) return;
        if (wards) {
          map.addSource("wards", { type: "geojson", data: wards });
          map.addLayer({ id: "wards-fill", type: "fill", source: "wards", paint: { "fill-color": "#eceff3", "fill-opacity": 0.35 } });
          map.addLayer({ id: "wards-line", type: "line", source: "wards", paint: { "line-color": "#8a94a6", "line-width": 1 } });
        }
        for (const l of layers) {
          map.addSource(l.id, { type: "geojson", data: l.data });
          const visibility = l.visible === false ? "none" : "visible";
          if (l.kind === "line") {
            map.addLayer({
              id: l.id, type: "line", source: l.id, layout: { visibility, "line-cap": "round" },
              paint: { "line-color": l.color as string, "line-width": (l.width ?? 3) as number, "line-opacity": l.opacity ?? 0.9,
                       ...(l.dashed ? { "line-dasharray": [2, 1.5] } : {}) },
            });
          } else {
            map.addLayer({
              id: l.id, type: "circle", source: l.id, layout: { visibility },
              paint: { "circle-color": l.color as string, "circle-radius": (l.radius ?? 5) as number, "circle-opacity": l.opacity ?? 0.9,
                       "circle-stroke-color": "#ffffff", "circle-stroke-width": 1 },
            });
          }
          if (l.fields?.length || l.title) {
            map.on("click", l.id, (e) => {
              const hit = e.features?.[0];
              if (hit) new ml.Popup({ maxWidth: "320px" }).setLngLat(e.lngLat).setHTML(popupHtml(l, hit.properties ?? {})).addTo(map!);
            });
            map.on("mouseenter", l.id, () => (map!.getCanvas().style.cursor = "pointer"));
            map.on("mouseleave", l.id, () => (map!.getCanvas().style.cursor = ""));
          }
        }
        setReady(true);
      });
    })().catch((err: unknown) => setFailed(err instanceof Error ? err.message : "The map could not load."));
    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
    };
    // created once per mount; a parent changes `key` to show different data
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggle(id: string) {
    const next = !shown[id];
    setShown((s) => ({ ...s, [id]: next }));
    mapRef.current?.setLayoutProperty(id, "visibility", next ? "visible" : "none");
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        {layers.map((l) => (
          <label key={l.id} className="flex cursor-pointer items-center gap-1.5 text-muted">
            <input type="checkbox" className="size-3.5 accent-[#0d8f78]" checked={shown[l.id]} onChange={() => toggle(l.id)} disabled={!ready} />
            {l.label} <span className="text-faint">({l.data.features.length})</span>
          </label>
        ))}
      </div>
      <div className={`relative overflow-hidden rounded-xl border border-line bg-panel ${height}`}>
        <div ref={container} className="h-full w-full" role="application" aria-label="Operations map" />
        {!ready && !failed ? <p className="absolute inset-0 flex items-center justify-center text-sm text-muted">Loading map…</p> : null}
        {failed ? <p className="absolute inset-x-6 top-6 rounded-lg border border-danger/40 bg-base/90 p-3 text-sm text-danger">Map failed to load: {failed}</p> : null}
        {legend?.length ? (
          <ul className="absolute bottom-3 left-3 space-y-1 rounded-lg border border-line bg-base/90 px-3 py-2 text-xs text-ink">
            {legend.map((i) => (
              <li key={i.label} className="flex items-center gap-2">
                {i.shape === "line"
                  ? <span className="inline-block h-1 w-4 rounded" style={{ background: i.color }} />
                  : <span className="inline-block size-2.5 rounded-full" style={{ background: i.color }} />}
                {i.label}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {note ? <p className="text-xs text-faint">{note}</p> : null}
    </div>
  );
}
