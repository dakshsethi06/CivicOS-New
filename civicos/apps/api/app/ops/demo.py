"""Demonstration data for the water, waste and traffic modules.

Mumbai does not publish pipe-network, sensor, bin or road-traffic readings, so these modules cannot run on real data.
This generator builds a clearly labelled stand-in: synthetic pipes, sensors, bins, vehicles and roads placed inside the
real ward boundaries, with readings drawn from simple physical rules (daily demand curves, BPR road congestion, bin
filling and emptying) plus injected faults whose truth is kept, so the models can be scored against it.

Every row it produces is stored with is_synthetic = true and shown in the app under a "Demo data" label. It never
touches the published figures (civic_indicators) and is never mixed into them.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

import numpy as np

from .geo import Area, Point, distance_matrix_m, haversine_m, line_length_m, minimum_spanning_edges

# --------------------------------------------------------------------------------------------------------------
# Inputs


@dataclass
class Zone:
    id: str
    code: str
    name: str
    population: int
    area: Area
    waste_tpd: float | None = None        # published tonnes per day, when available, scales bin filling


@dataclass
class DemoConfig:
    seed: int = 2026
    water_days: int = 120                 # hourly
    waste_days: int = 28                  # every 2 hours
    traffic_days: int = 10                # every 15 minutes
    incident_days: int = 365
    pipes_per_zone: int = 12
    sensors_per_zone: int = 2
    bins_per_zone: int = 10
    vehicles_per_zone: int = 2
    road_nodes_per_zone: int = 6
    monitored_road_share: float = 0.3


# --------------------------------------------------------------------------------------------------------------
# Outputs


@dataclass
class Reservoir:
    key: str
    zone_id: str
    name: str
    capacity_ml: float
    point: Point
    level_pct: np.ndarray                 # hourly, aligned with WaterData.hours
    inflow_ml: np.ndarray                 # hourly


@dataclass
class Pipeline:
    key: str
    zone_id: str
    code: str
    material: str
    diameter_mm: int
    installed_year: int
    coords: list[Point]
    length_m: float
    failures_by_year: list[int]           # bursts or leaks repaired in each of the last six years, oldest first

    @property
    def failures_prev5(self) -> int:      # the five years before the last one
        return sum(self.failures_by_year[:-1])

    @property
    def failed_last_year(self) -> bool:   # the label the risk model learns
        return self.failures_by_year[-1] > 0


@dataclass
class Sensor:
    key: str
    zone_id: str
    pipeline_key: str
    code: str
    point: Point
    share: float                          # share of the zone's demand flowing past this meter


@dataclass
class WaterEvent:
    sensor_key: str
    kind: str                             # leak, burst, meter_fault
    start: int                            # hour index
    end: int                              # exclusive


@dataclass
class WaterData:
    hours: list[datetime]
    reservoirs: list[Reservoir]
    pipelines: list[Pipeline]
    sensors: list[Sensor]
    flow_lps: np.ndarray                  # [sensor, hour]
    pressure_bar: np.ndarray
    consumption_m3: np.ndarray
    events: list[WaterEvent]


@dataclass
class Bin:
    key: str
    zone_id: str
    code: str
    kind: str                             # residential, market, commercial
    capacity_l: int
    point: Point
    collect_every_h: int


@dataclass
class Vehicle:
    key: str
    zone_id: str
    code: str
    capacity_l: int
    depot: Point


@dataclass
class WasteData:
    times: list[datetime]                 # every 2 hours
    bins: list[Bin]
    vehicles: list[Vehicle]
    fill_pct: np.ndarray                  # [bin, time], after any collection at that time
    collected: np.ndarray                 # [bin, time] bool


@dataclass
class Road:
    key: str
    zone_id: str
    name: str
    from_node: int
    to_node: int
    coords: list[Point]
    length_m: float
    lanes: int
    speed_limit: int                      # km/h
    capacity_vph: int                     # per direction
    monitored: bool


@dataclass
class Incident:
    road_key: str
    kind: str                             # accident, breakdown, waterlogging
    severity: str
    occurred_at: datetime
    duration_min: int
    point: Point


@dataclass
class TrafficData:
    times: list[datetime]                 # every 15 minutes
    nodes: list[Point]
    node_zone: list[str]
    roads: list[Road]
    monitored: list[int]                  # indices into roads
    speed_kmh: np.ndarray                 # [monitored road, time]
    volume_vph: np.ndarray
    rain_mm_h: np.ndarray                 # [time]
    incident_active: np.ndarray           # [monitored road, time] bool
    incidents: list[Incident]


@dataclass
class DemoCity:
    generated_at: datetime
    config: DemoConfig
    water: WaterData
    waste: WasteData
    traffic: TrafficData
    notes: dict = field(default_factory=dict)


# --------------------------------------------------------------------------------------------------------------
# Profiles

# share of a day's water drawn in each hour (Mumbai supply is intermittent, but metered demand still peaks morning and
# evening); averages to 1
_WATER_DAY = np.array([0.45, 0.4, 0.38, 0.4, 0.55, 0.95, 1.55, 1.75, 1.6, 1.3, 1.1, 1.0,
                       0.95, 0.9, 0.85, 0.9, 1.0, 1.2, 1.45, 1.5, 1.35, 1.05, 0.8, 0.6])
_WATER_DAY = _WATER_DAY / _WATER_DAY.mean()
_WASTE_DAY = np.array([0.3, 0.25, 0.25, 0.3, 0.45, 0.8, 1.3, 1.6, 1.6, 1.4, 1.2, 1.1,
                       1.1, 1.0, 0.95, 0.95, 1.05, 1.3, 1.5, 1.55, 1.35, 1.0, 0.65, 0.4])
_WASTE_DAY = _WASTE_DAY / _WASTE_DAY.mean()
# road volume as a share of capacity, by hour (peaks 9-11 and 18-21)
_ROAD_DAY = np.array([0.18, 0.12, 0.1, 0.1, 0.14, 0.25, 0.45, 0.7, 0.92, 1.0, 0.9, 0.75,
                      0.7, 0.68, 0.7, 0.75, 0.85, 0.95, 1.05, 1.0, 0.85, 0.6, 0.4, 0.26])

_MATERIALS = {  # name: (first year, last year, relative hazard)
    "Cast iron": (1925, 1975, 1.0),
    "Mild steel": (1950, 1995, 0.75),
    "Ductile iron": (1975, 2015, 0.35),
    "PVC": (1985, 2010, 0.5),
    "HDPE": (1995, 2023, 0.25),
}


IST = timezone(timedelta(hours=5, minutes=30))


def _local(t: datetime) -> datetime:
    """Mumbai clock time: demand peaks, rush hours and collection rounds follow it, not UTC."""
    return t.astimezone(IST)


def _now_hour() -> datetime:
    return datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)


# --------------------------------------------------------------------------------------------------------------


def generate(zones: list[Zone], cfg: DemoConfig | None = None, end: datetime | None = None) -> DemoCity:
    if not zones:
        raise ValueError("The workspace has no wards to place the demonstration network in.")
    cfg = cfg or DemoConfig()
    end = (end or _now_hour()).astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
    rng = np.random.default_rng(cfg.seed)
    water = _water(zones, cfg, end, rng)
    waste = _waste(zones, cfg, end, rng)
    traffic = _traffic(zones, cfg, end, rng)
    return DemoCity(end, cfg, water, waste, traffic,
                    notes={"seed": cfg.seed, "zones": len(zones), "label": "Demonstration data, not measurements"})


# ------------------------------------------------------------------------------------------------------- water


def _water(zones: list[Zone], cfg: DemoConfig, end: datetime, rng: np.random.Generator) -> WaterData:
    n_h = cfg.water_days * 24
    hours = [end - timedelta(hours=n_h - 1 - i) for i in range(n_h)]
    hod = np.array([_local(h).hour for h in hours])            # daily patterns follow local (IST) time
    dow = np.array([_local(h).weekday() for h in hours])
    t_days = np.arange(n_h) / 24.0

    reservoirs: list[Reservoir] = []
    pipelines: list[Pipeline] = []
    sensors: list[Sensor] = []
    flows, pressures, cons = [], [], []
    pressure_cv: dict[str, float] = {}

    for z in zones:
        zr = np.random.default_rng(rng.integers(1 << 31))
        pop = max(z.population or 300_000, 50_000)
        demand_m3_h = pop * 0.15 / 24                       # ~150 litres a person a day reach taps
        pts = z.area.sample(zr, cfg.pipes_per_zone + 1)
        res_pt = pts[0]

        # pipes: the shortest network joining the service reservoir and the junctions
        for i, (a, b) in enumerate(minimum_spanning_edges(pts)):
            mat = zr.choice(list(_MATERIALS))
            y0, y1, _ = _MATERIALS[mat]
            mid = ((pts[a][0] + pts[b][0]) / 2 + zr.normal(0, 0.0008), (pts[a][1] + pts[b][1]) / 2 + zr.normal(0, 0.0008))
            coords = [pts[a], (round(mid[0], 6), round(mid[1], 6)), pts[b]]
            pipelines.append(Pipeline(
                key=f"{z.code}-P{i + 1}", zone_id=z.id, code=f"{z.code}-P{i + 1:02d}", material=str(mat),
                diameter_mm=int(zr.choice([150, 200, 300, 450, 600, 900, 1200], p=[.2, .25, .2, .15, .1, .06, .04])),
                installed_year=int(zr.integers(y0, y1 + 1)), coords=coords, length_m=round(line_length_m(coords), 1),
                failures_by_year=[0] * 6))

        zone_pipes = [p for p in pipelines if p.zone_id == z.id]
        base_p = zr.uniform(1.8, 3.2)
        cv = zr.uniform(0.03, 0.12)                         # how much pressure swings in this zone
        pressure_cv[z.id] = cv
        shares = zr.dirichlet(np.ones(cfg.sensors_per_zone) * 4)
        for s in range(cfg.sensors_per_zone):
            pipe = zone_pipes[min(len(zone_pipes) - 1, s * max(1, len(zone_pipes) // cfg.sensors_per_zone))]
            sensors.append(Sensor(key=f"{z.code}-S{s + 1}", zone_id=z.id, pipeline_key=pipe.key,
                                  code=f"{z.code}-FM{s + 1}", point=pipe.coords[1], share=float(shares[s])))
            weekly = np.where(dow == 6, 1.06, np.where(dow == 5, 1.03, 1.0))
            seasonal = 1 + 0.06 * np.sin(2 * np.pi * (t_days / 60.0 + zr.uniform()))
            trend = 1 + 0.0003 * t_days
            c = demand_m3_h * shares[s] * _WATER_DAY[hod] * weekly * seasonal * trend * zr.lognormal(0, 0.05, n_h)
            rel = c / c.mean()
            p = base_p - 0.35 * (rel - 1) + zr.normal(0, base_p * cv * 0.3, n_h)
            cons.append(c)
            flows.append(c / 3.6)                           # m3 per hour to litres per second
            pressures.append(p)

        cap_ml = demand_m3_h * 24 * 1.2 / 1000              # 1.2 days of demand, megalitres
        reservoirs.append(Reservoir(key=f"{z.code}-R1", zone_id=z.id, name=f"{z.name} service reservoir (demo)",
                                    capacity_ml=round(cap_ml, 1), point=res_pt, level_pct=np.zeros(n_h), inflow_ml=np.zeros(n_h)))

    flow = np.array(flows)
    pressure = np.array(pressures)
    consumption = np.array(cons)

    # injected faults, kept as ground truth for scoring the anomaly detector
    events: list[WaterEvent] = []
    n_s = len(sensors)
    recent = max(24 * 7, n_h - 24 * 60)

    def place(kind: str, count: int, dur: tuple[int, int]) -> None:
        for _ in range(count):
            s = int(rng.integers(n_s))
            length = int(rng.integers(*dur))
            start = int(rng.integers(recent, n_h - length))
            if any(e.sensor_key == sensors[s].key and start < e.end + 24 and e.start < start + length + 24 for e in events):
                continue
            events.append(WaterEvent(sensors[s].key, kind, start, start + length))
            sl = slice(start, start + length)
            mean_c = consumption[s].mean()
            if kind == "leak":                                 # steady extra draw, most visible at night
                extra = mean_c * rng.uniform(0.3, 0.6)
                consumption[s, sl] += extra
                pressure[s, sl] -= rng.uniform(0.35, 0.7)
            elif kind == "burst":
                consumption[s, sl] += mean_c * rng.uniform(1.2, 2.0)
                pressure[s, sl] -= rng.uniform(1.0, 1.5)
            else:                                              # meter stops reporting flow
                consumption[s, sl] = rng.uniform(0, 0.03, length) * mean_c
            flow[s, sl] = consumption[s, sl] / 3.6

    place("leak", max(3, n_s // 8), (36, 144))
    place("burst", max(2, n_s // 16), (3, 9))
    place("meter_fault", max(1, n_s // 24), (6, 25))
    pressure = np.clip(pressure, 0.2, None)

    # reservoirs: steady inflow from the treatment works, outflow = the zone's metered draw
    for r in reservoirs:
        idx = [i for i, s in enumerate(sensors) if s.zone_id == r.zone_id]
        out_ml = consumption[idx].sum(axis=0) / 1000
        daily_in = out_ml.reshape(-1, 24).sum(axis=1).mean()
        inflow = np.repeat(daily_in / 24 * rng.uniform(0.96, 1.04, cfg.water_days), 24)
        if rng.uniform() < 0.3:                                # a supply cut in the last fortnight
            d0 = int(rng.integers(cfg.water_days - 14, cfg.water_days - 2)) * 24
            inflow[d0:d0 + int(rng.integers(24, 72))] *= rng.uniform(0.4, 0.7)
        level = np.empty(n_h)
        target = r.capacity_ml * rng.uniform(0.6, 0.75)
        v = target
        for i in range(n_h):
            # operators adjust the valves towards a target level; a supply cut limits what they can send
            inflow[i] = max(0.0, inflow[i] + 0.03 * (target - v) * (inflow[i] / (daily_in / 24)))
            v = min(r.capacity_ml, max(0.03 * r.capacity_ml, v + inflow[i] - out_ml[i]))
            level[i] = v / r.capacity_ml * 100
        r.level_pct, r.inflow_ml = np.round(level, 2), np.round(inflow, 4)

    # pipe failure history: hazard grows with age and material, with pressure swings, and with a pipe's own frailty
    year = end.year
    for p in pipelines:
        frailty = rng.gamma(2.0, 0.5)
        counts = []
        for back in range(5, -1, -1):
            age = max(0, year - back - p.installed_year)
            lam = math.exp(-3.6 + 0.032 * age + 1.4 * _MATERIALS[p.material][2] + 9.0 * pressure_cv[p.zone_id]
                           - 0.0008 * p.diameter_mm + 0.0002 * p.length_m) * frailty
            counts.append(int(rng.poisson(lam)))
        p.failures_by_year = counts

    return WaterData(hours, reservoirs, pipelines, sensors, np.round(flow, 3), np.round(pressure, 3),
                     np.round(consumption, 3), events)


# ------------------------------------------------------------------------------------------------------- waste


def _waste(zones: list[Zone], cfg: DemoConfig, end: datetime, rng: np.random.Generator) -> WasteData:
    step = 2
    n_t = cfg.waste_days * 24 // step
    times = [end - timedelta(hours=step * (n_t - 1 - i)) for i in range(n_t)]
    tpd = np.array([z.waste_tpd for z in zones if z.waste_tpd]) if any(z.waste_tpd for z in zones) else None
    ref = float(np.median(tpd)) if tpd is not None and len(tpd) else None

    bins: list[Bin] = []
    vehicles: list[Vehicle] = []
    fills, collected = [], []
    for z in zones:
        zr = np.random.default_rng(rng.integers(1 << 31))
        scale = math.sqrt(z.waste_tpd / ref) if ref and z.waste_tpd else 1.0
        pts = z.area.sample(zr, cfg.bins_per_zone + cfg.vehicles_per_zone)
        for v in range(cfg.vehicles_per_zone):
            vehicles.append(Vehicle(key=f"{z.code}-V{v + 1}", zone_id=z.id, code=f"{z.code}-TRK{v + 1}",
                                    capacity_l=int(zr.choice([8000, 10000, 14000])), depot=pts[v]))
        for b in range(cfg.bins_per_zone):
            kind = str(zr.choice(["residential", "market", "commercial"], p=[0.6, 0.2, 0.2]))
            every = int(zr.choice([24, 48], p=[0.7, 0.3]))
            cap = 1100 if kind != "residential" else int(zr.choice([660, 1100]))
            bins.append(Bin(key=f"{z.code}-B{b + 1}", zone_id=z.id, code=f"{z.code}-BIN{b + 1:02d}", kind=kind,
                            capacity_l=cap, point=pts[cfg.vehicles_per_zone + b], collect_every_h=every))
            base = zr.uniform(1.0, 2.6) * scale * (24 / every) ** 0.35 * (660 / cap) ** 0.5   # % of the bin per hour
            fill = zr.uniform(5, 40)
            offset = int(zr.integers(0, every // 24)) * 24 if every > 24 else 0
            f_row, c_row = [], []
            for t in times:
                weekday = _local(t).weekday()
                k = {"market": 1.3 if weekday >= 5 else 1.0,
                     "commercial": 0.6 if weekday >= 5 else 1.2}.get(kind, 1.05 if weekday >= 5 else 1.0)
                for h in range(step):
                    hr = (_local(t).hour - step + 1 + h) % 24
                    fill += base * _WASTE_DAY[hr] * k * zr.lognormal(0, 0.15)
                fill = min(fill, 100.0)
                # the morning round at 06:00 falls inside this reading's two-hour window
                day_no = _local(t).toordinal()
                is_collection = (_local(t).hour - 6) % 24 < step and (every == 24 or (day_no + offset // 24) % 2 == 0)
                # a few missed pickups, which is when bins overflow
                if is_collection and zr.uniform() < 0.06:
                    is_collection = False
                if is_collection:
                    fill = zr.uniform(0, 6)
                f_row.append(round(min(100.0, max(0.0, fill + zr.normal(0, 1.5))), 1))
                c_row.append(is_collection)
            fills.append(f_row)
            collected.append(c_row)
    return WasteData(times, bins, vehicles, np.array(fills), np.array(collected, dtype=bool))


# ----------------------------------------------------------------------------------------------------- traffic


def _traffic(zones: list[Zone], cfg: DemoConfig, end: datetime, rng: np.random.Generator) -> TrafficData:
    nodes: list[Point] = []
    node_zone: list[str] = []
    for z in zones:
        zr = np.random.default_rng(rng.integers(1 << 31))
        for p in z.area.sample(zr, cfg.road_nodes_per_zone):
            nodes.append(p)
            node_zone.append(z.id)

    # a connected street graph: the spanning tree plus each junction's three nearest neighbours, so most roads have
    # an alternative
    d = distance_matrix_m(nodes)
    pairs = {tuple(sorted(e)) for e in minimum_spanning_edges(nodes)}
    for i in range(len(nodes)):
        for j in np.argsort(d[i])[1:4]:
            pairs.add(tuple(sorted((i, int(j)))))

    roads: list[Road] = []
    for k, (a, b) in enumerate(sorted(pairs)):
        lanes = int(rng.choice([1, 2, 3], p=[0.35, 0.45, 0.2]))
        limit = {1: 30, 2: 40, 3: 60}[lanes] if rng.uniform() > 0.2 else {1: 40, 2: 50, 3: 70}[lanes]
        coords = [nodes[a], nodes[b]]
        roads.append(Road(key=f"R{k + 1}", zone_id=node_zone[a], name=f"Demo road {k + 1}", from_node=a, to_node=b,
                          coords=coords, length_m=round(haversine_m(nodes[a], nodes[b]) * 1.15, 1), lanes=lanes,
                          speed_limit=limit, capacity_vph=lanes * 1600, monitored=False))

    n_mon = max(4, int(len(roads) * cfg.monitored_road_share))
    monitored = sorted(int(i) for i in rng.choice(len(roads), size=min(n_mon, len(roads)), replace=False))
    for i in monitored:
        roads[i].monitored = True

    step = 15
    n_t = cfg.traffic_days * 24 * 60 // step
    times = [end - timedelta(minutes=step * (n_t - 1 - i)) for i in range(n_t)]
    hour_f = np.array([_local(t).hour + _local(t).minute / 60 for t in times])
    weekend = np.array([_local(t).weekday() >= 5 for t in times])

    # rain: a few showers, each lasting a few hours
    rain = np.zeros(n_t)
    for _ in range(int(rng.integers(2, 6))):
        s = int(rng.integers(0, n_t - 16))
        rain[s:s + int(rng.integers(8, 24))] += rng.exponential(6)

    # incidents over the last year (for hotspots); those in the reading window also slow traffic
    risk = np.array([r.lanes * r.speed_limit * r.length_m for r in roads], dtype=float)
    risk = rng.gamma(1.5, 1.0, len(roads)) * risk / risk.mean()
    incidents: list[Incident] = []
    n_inc = int(cfg.incident_days * 1.6)
    t0 = end - timedelta(days=cfg.incident_days)
    for _ in range(n_inc):
        r = int(rng.choice(len(roads), p=risk / risk.sum()))
        kind = str(rng.choice(["accident", "breakdown", "waterlogging"], p=[0.55, 0.35, 0.1]))
        sev = str(rng.choice(["minor", "serious", "fatal"], p=[0.8, 0.18, 0.02])) if kind == "accident" else "minor"
        at = t0 + timedelta(minutes=int(rng.integers(0, cfg.incident_days * 1440)))
        frac = rng.uniform(0.1, 0.9)
        a, b = roads[r].coords
        incidents.append(Incident(roads[r].key, kind, sev, at.replace(second=0, microsecond=0),
                                  int(rng.integers(20, 150)),
                                  (round(a[0] + (b[0] - a[0]) * frac, 6), round(a[1] + (b[1] - a[1]) * frac, 6))))
    # some extra incidents on monitored roads inside the reading window, so the forecasts see them
    for _ in range(cfg.traffic_days * 3):
        r = int(rng.choice(monitored))
        at = times[int(rng.integers(0, n_t - 8))]
        a, b = roads[r].coords
        incidents.append(Incident(roads[r].key, "accident", "minor", at, int(rng.integers(30, 120)),
                                  ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)))

    speeds, volumes, active = [], [], []
    tmin = np.array([t.timestamp() / 60 for t in times])
    by_road: dict[str, list[Incident]] = {}
    for inc in incidents:
        by_road.setdefault(inc.road_key, []).append(inc)
    for i in monitored:
        road = roads[i]
        rr = np.random.default_rng(rng.integers(1 << 31))
        demand_k = rr.uniform(0.5, 1.15)
        profile = np.interp(hour_f, np.arange(25), np.append(_ROAD_DAY, _ROAD_DAY[0]))
        v = road.capacity_vph * demand_k * profile * np.where(weekend, 0.8, 1.0) * rr.lognormal(0, 0.06, n_t)
        cap = np.full(n_t, float(road.capacity_vph))
        cap *= np.where(rain > 2, 0.88, 1.0)
        on = np.zeros(n_t, dtype=bool)
        for inc in by_road.get(road.key, []):
            s = inc.occurred_at.timestamp() / 60
            on |= (tmin >= s) & (tmin < s + inc.duration_min)
        cap = np.where(on, cap * 0.5, cap)
        x = v / cap
        # signalled city streets: speed halves at capacity (BPR with alpha = 1), unlike the 0.15 used for highways
        speed = road.speed_limit / (1 + 1.0 * x ** 4) * rr.lognormal(0, 0.05, n_t)
        speed = np.clip(speed, 3, road.speed_limit * 1.1)
        speeds.append(np.round(speed, 2))
        volumes.append(np.round(np.minimum(v, cap * 1.1)))
        active.append(on)

    return TrafficData(times, nodes, node_zone, roads, monitored, np.array(speeds), np.array(volumes),
                       np.round(rain, 2), np.array(active, dtype=bool), incidents)
