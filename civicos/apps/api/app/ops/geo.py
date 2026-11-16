"""Small geometry helpers for the demo network generator and the routing and simulation models.

Coordinates are (longitude, latitude) in WGS 84, as in GeoJSON. Distances are great-circle metres. Heavy spatial work
in the database uses PostGIS; this is only what Python needs to place points inside wards and measure routes.
"""
from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np

Point = tuple[float, float]
Ring = list[Point]
EARTH_M = 6_371_008.8


def haversine_m(a: Point, b: Point) -> float:
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * EARTH_M * math.asin(min(1.0, math.sqrt(h)))


def distance_matrix_m(points: Sequence[Point]) -> np.ndarray:
    p = np.radians(np.asarray(points, dtype=float))
    lon, lat = p[:, 0][:, None], p[:, 1][:, None]
    h = np.sin((lat.T - lat) / 2) ** 2 + np.cos(lat) * np.cos(lat.T) * np.sin((lon.T - lon) / 2) ** 2
    return 2 * EARTH_M * np.arcsin(np.minimum(1.0, np.sqrt(h)))


def line_length_m(coords: Sequence[Point]) -> float:
    return sum(haversine_m(coords[i], coords[i + 1]) for i in range(len(coords) - 1))


def _in_ring(x: float, y: float, ring: Ring) -> bool:
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-15) + xi:
            inside = not inside
        j = i
    return inside


@dataclass
class Area:
    """A ward: a GeoJSON Polygon or MultiPolygon reduced to lists of rings (first ring outer, the rest holes)."""
    polygons: list[list[Ring]]

    @classmethod
    def from_geojson(cls, g: dict) -> Area:
        if g["type"] == "Polygon":
            polys = [g["coordinates"]]
        elif g["type"] == "MultiPolygon":
            polys = g["coordinates"]
        else:
            raise ValueError(f"Not an area: {g['type']}")
        return cls([[[(float(x), float(y)) for x, y, *_ in ring] for ring in poly] for poly in polys])

    @classmethod
    def box(cls, lon: float, lat: float, half: float = 0.01) -> Area:
        r = [(lon - half, lat - half), (lon + half, lat - half), (lon + half, lat + half), (lon - half, lat + half),
             (lon - half, lat - half)]
        return cls([[r]])

    def contains(self, p: Point) -> bool:
        for poly in self.polygons:
            if _in_ring(p[0], p[1], poly[0]) and not any(_in_ring(p[0], p[1], h) for h in poly[1:]):
                return True
        return False

    def bounds(self) -> tuple[float, float, float, float]:
        xs = [x for poly in self.polygons for x, _ in poly[0]]
        ys = [y for poly in self.polygons for _, y in poly[0]]
        return min(xs), min(ys), max(xs), max(ys)

    def centroid(self) -> Point:
        # area-weighted centroid of the outer rings (shoelace); good enough to label a ward
        ax = ay = a = 0.0
        for poly in self.polygons:
            r = poly[0]
            for i in range(len(r) - 1):
                cross = r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]
                a += cross
                ax += (r[i][0] + r[i + 1][0]) * cross
                ay += (r[i][1] + r[i + 1][1]) * cross
        if abs(a) < 1e-15:
            x0, y0, x1, y1 = self.bounds()
            return (x0 + x1) / 2, (y0 + y1) / 2
        c = (ax / (3 * a), ay / (3 * a))
        return c if self.contains(c) else self.sample(np.random.default_rng(0), 1)[0]

    def sample(self, rng: np.random.Generator, n: int, max_tries: int = 200_000) -> list[Point]:
        """n uniformly random points inside the area (rejection sampling in the bounding box)."""
        x0, y0, x1, y1 = self.bounds()
        out: list[Point] = []
        tries = 0
        while len(out) < n and tries < max_tries:
            batch = rng.uniform((x0, y0), (x1, y1), size=(max(32, 4 * (n - len(out))), 2))
            for x, y in batch:
                tries += 1
                if self.contains((x, y)):
                    out.append((round(float(x), 6), round(float(y), 6)))
                    if len(out) == n:
                        break
        if len(out) < n:
            raise ValueError("Could not place points inside the area")
        return out


def minimum_spanning_edges(points: Sequence[Point]) -> list[tuple[int, int]]:
    """Prim's algorithm on great-circle distance: the shortest set of links joining every point."""
    n = len(points)
    if n < 2:
        return []
    d = distance_matrix_m(points)
    in_tree = np.zeros(n, dtype=bool)
    in_tree[0] = True
    best = d[0].copy()
    parent = np.zeros(n, dtype=int)
    edges: list[tuple[int, int]] = []
    for _ in range(n - 1):
        cand = np.where(in_tree, np.inf, best)
        j = int(np.argmin(cand))
        edges.append((int(parent[j]), j))
        in_tree[j] = True
        closer = d[j] < best
        best = np.where(closer, d[j], best)
        parent = np.where(closer, j, parent)
    return edges
