import type { StyleSpecification } from "maplibre-gl";

/**
 * Raster basemap: OpenStreetMap's standard tiles, which need no API key (CARTO's basemaps now require one outside
 * localhost and stamp "API KEY REQUIRED" over the map). Lightly faded so the ward shading and markers stand out.
 * OSM's tile servers are for modest use; for heavy traffic set NEXT_PUBLIC_MAP_STYLE_URL to a hosted style
 * (for example MapTiler or Stadia Maps with your key).
 */
export const DEFAULT_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    basemap: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      maxzoom: 19,
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · Ward boundaries: <a href="https://github.com/datameet/Municipal_Spatial_Data">DataMeet</a> (CC BY-SA 2.5 IN)',
    },
  },
  layers: [{ id: "basemap", type: "raster", source: "basemap", paint: { "raster-saturation": -0.6, "raster-opacity": 0.85 } }],
};

export function bounds(fc: GeoJSON.FeatureCollection): [[number, number], [number, number]] | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const visit = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === "number") {
      x0 = Math.min(x0, c[0]); x1 = Math.max(x1, c[0]); y0 = Math.min(y0, c[1] as number); y1 = Math.max(y1, c[1] as number);
    } else if (Array.isArray(c)) c.forEach(visit);
  };
  fc.features.forEach((f) => f.geometry && "coordinates" in f.geometry && visit(f.geometry.coordinates));
  return Number.isFinite(x0) ? [[x0, y0], [x1, y1]] : null;
}

function inRing(x: number, y: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** True when the point lies inside the polygon or multipolygon (outer ring minus holes). */
export function contains(geometry: GeoJSON.Geometry, lon: number, lat: number): boolean {
  const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
  return polys.some((rings) => inRing(lon, lat, rings[0]) && !rings.slice(1).some((hole) => inRing(lon, lat, hole)));
}
