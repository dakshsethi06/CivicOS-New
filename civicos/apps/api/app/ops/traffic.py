"""Traffic models.

A. Congestion forecasting: one XGBoost model per horizon (15, 30 and 60 minutes) predicts each monitored road's speed
   as a share of its limit, from the latest readings, the same time yesterday, the road's usual speed at that time of
   day, the hour and weekday, rain, an active incident, and the road's lanes and limit. Scored on the last two days
   (held out) by MAE and RMSE in km/h against two baselines: no change, and the road's usual speed at that time.
B. What-if simulation: a static traffic assignment on the road graph for the peak hour. Trips between junctions follow
   a gravity model on ward population; each trip takes its quickest path, and road travel time rises with the
   volume/capacity ratio (the BPR function). Equilibrium by the method of successive averages. A scenario (close a
   road, cut its capacity, or add trips around it) is re-assigned and compared with the base case. This is a
   simplified macroscopic model, not a microsimulation such as SUMO, and its outputs are simulated, not measured.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

import numpy as np
import xgboost as xgb
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra

from .demo import Road
from .geo import Point, distance_matrix_m
from .water import mae, rmse

STEP_MIN = 15
HORIZONS_MIN = (15, 30, 60)
SLOTS = 24 * 60 // STEP_MIN
FEATURES = ["speed share now", "15 min ago", "30 min ago", "60 min ago", "same time yesterday", "usual at that time",
            "hour", "weekday", "rain (mm/h)", "incident on the road", "lanes", "speed limit"]


def congestion_level(index: float) -> str:
    """index = 1 - speed / limit."""
    return "free flow" if index < 0.2 else "moderate" if index < 0.4 else "heavy" if index < 0.6 else "severe"


@dataclass
class RoadForecast:
    road_key: str
    speed_now: float
    speed: dict[int, float]                # horizon minutes -> km/h
    congestion: dict[int, float]           # horizon minutes -> 1 - speed/limit
    level: dict[int, str]


@dataclass
class TrafficForecast:
    roads: list[RoadForecast]
    metrics: dict
    generated_at: datetime


def _design(R: np.ndarray, slot_mean: np.ndarray, times: list[datetime], rain: np.ndarray, inc: np.ndarray,
            roads: list[Road], t_idx: np.ndarray, k: int) -> np.ndarray:
    rows = []
    for r in range(R.shape[0]):
        tgt = t_idx + k
        tgt_times = [times[0] + timedelta(minutes=STEP_MIN * int(i)) for i in tgt]
        slots = np.array([(t.hour * 60 + t.minute) // STEP_MIN for t in tgt_times])
        rows.append(np.column_stack([
            R[r, t_idx], R[r, t_idx - 1], R[r, t_idx - 2], R[r, t_idx - 4],
            R[r, np.maximum(tgt - SLOTS, 0)], slot_mean[r, slots],
            [t.hour + t.minute / 60 for t in tgt_times], [t.weekday() for t in tgt_times],
            rain[t_idx], inc[r, t_idx].astype(float), np.full(len(t_idx), roads[r].lanes), np.full(len(t_idx), roads[r].speed_limit),
        ]))
    return np.vstack(rows)


def forecast_congestion(roads: list[Road], times: list[datetime], speed: np.ndarray, rain: np.ndarray,
                        incident: np.ndarray, seed: int = 0) -> TrafficForecast:
    """roads: the monitored roads, in the row order of `speed` [road, time]."""
    limits = np.array([r.speed_limit for r in roads], dtype=float)[:, None]
    R = speed / limits
    n_t = R.shape[1]
    test_from = n_t - 2 * SLOTS
    slot_of = np.array([(t.hour * 60 + t.minute) // STEP_MIN for t in times])

    def slot_means(upto: int) -> np.ndarray:
        out = np.zeros((R.shape[0], SLOTS))
        for s in range(SLOTS):
            m = slot_of[:upto] == s
            out[:, s] = R[:, :upto][:, m].mean(axis=1) if m.any() else R[:, :upto].mean(axis=1)
        return out

    sm_tr = slot_means(test_from)
    metrics: dict = {"unit": "km/h", "test": "the last 2 days, held out", "features": FEATURES}
    models = {}
    for h in HORIZONS_MIN:
        k = h // STEP_MIN
        tr = np.arange(SLOTS, test_from - k)
        te = np.arange(test_from, n_t - k)
        Xtr = _design(R, sm_tr, times, rain, incident, roads, tr, k)
        ytr = np.concatenate([R[r, tr + k] for r in range(R.shape[0])])
        m = xgb.XGBRegressor(n_estimators=300, max_depth=6, learning_rate=0.05, subsample=0.9, tree_method="hist",
                             random_state=seed, n_jobs=2).fit(Xtr, ytr)
        Xte = _design(R, sm_tr, times, rain, incident, roads, te, k)
        lim = np.concatenate([np.full(len(te), roads[r].speed_limit) for r in range(R.shape[0])])
        y = np.concatenate([R[r, te + k] for r in range(R.shape[0])]) * lim
        p = m.predict(Xte) * lim
        persist = Xte[:, 0] * lim
        usual = Xte[:, 5] * lim
        metrics[f"{h}min"] = {"xgboost": {"mae": round(mae(y, p), 2), "rmse": round(rmse(y, p), 2)},
                              "no_change": {"mae": round(mae(y, persist), 2), "rmse": round(rmse(y, persist), 2)},
                              "usual_for_time": {"mae": round(mae(y, usual), 2), "rmse": round(rmse(y, usual), 2)}}
        # refit on everything for the live forecast
        sm_all = slot_means(n_t)
        allr = np.arange(SLOTS, n_t - k)
        models[h] = (xgb.XGBRegressor(n_estimators=300, max_depth=6, learning_rate=0.05, subsample=0.9,
                                      tree_method="hist", random_state=seed, n_jobs=2)
                     .fit(_design(R, sm_all, times, rain, incident, roads, allr, k),
                          np.concatenate([R[r, allr + k] for r in range(R.shape[0])])), sm_all)

    last = np.array([n_t - 1])
    out = []
    for r, road in enumerate(roads):
        sp, cg, lv = {}, {}, {}
        for h in HORIZONS_MIN:
            model, sm = models[h]
            X = _design(R[r:r + 1], sm[r:r + 1], times, rain, incident[r:r + 1], [road], last, h // STEP_MIN)
            ratio = float(np.clip(model.predict(X)[0], 0.03, 1.1))
            sp[h] = round(ratio * road.speed_limit, 1)
            cg[h] = round(max(0.0, 1 - ratio), 3)
            lv[h] = congestion_level(cg[h])
        out.append(RoadForecast(road.key, round(float(speed[r, -1]), 1), sp, cg, lv))
    return TrafficForecast(out, metrics, times[-1])


# ------------------------------------------------------------------------------------------------- B. what-if


@dataclass
class Network:
    nodes: list[Point]
    node_pop: np.ndarray
    roads: list[Road]
    # directed links: two per road
    tail: np.ndarray
    head: np.ndarray
    road_of: np.ndarray
    t0_h: np.ndarray                      # free-flow time, hours
    cap: np.ndarray                       # vehicles per hour

    @classmethod
    def build(cls, nodes: list[Point], node_pop: list[float], roads: list[Road]) -> Network:
        tail, head, road_of, t0, cap = [], [], [], [], []
        for i, r in enumerate(roads):
            for a, b in ((r.from_node, r.to_node), (r.to_node, r.from_node)):
                tail.append(a)
                head.append(b)
                road_of.append(i)
                t0.append(r.length_m / 1000 / r.speed_limit)
                cap.append(float(r.capacity_vph))
        return cls(nodes, np.asarray(node_pop, float), roads, np.array(tail), np.array(head), np.array(road_of),
                   np.array(t0), np.array(cap))


def gravity_demand(net: Network, total_trips: float) -> np.ndarray:
    d = distance_matrix_m(net.nodes) / 1000 + 0.5
    T = np.outer(net.node_pop, net.node_pop) / d ** 2
    np.fill_diagonal(T, 0)
    return T / T.sum() * total_trips


def calibrate_demand(net: Network, target_p90_vc: float = 0.9, start_trips: float = 30_000) -> tuple[np.ndarray, float]:
    """Scales peak-hour trips until the busiest tenth of links run at about `target_p90_vc` of capacity: busy but not
    gridlocked, as a city peak should be."""
    trips = start_trips
    for _ in range(4):
        a = assign(net, gravity_demand(net, trips), iterations=15)
        p90 = float(np.quantile(a.flow / net.cap, 0.9))
        if p90 <= 0:
            break
        trips *= target_p90_vc / p90
    return gravity_demand(net, trips), trips


@dataclass
class Assignment:
    flow: np.ndarray                      # per directed link, vehicles per hour
    time_h: np.ndarray                    # per directed link
    vehicle_hours: float
    od_time_h: np.ndarray                 # [origin, destination]
    unreachable_trips: float


def _bpr(t0: np.ndarray, v: np.ndarray, cap: np.ndarray) -> np.ndarray:
    with np.errstate(divide="ignore", invalid="ignore"):
        x = np.where(cap > 0, v / cap, np.inf)
    return np.where(cap > 0, t0 * (1 + 0.15 * x ** 4), np.inf)


def assign(net: Network, demand: np.ndarray, cap: np.ndarray | None = None, iterations: int = 40) -> Assignment:
    cap = net.cap if cap is None else cap
    n = len(net.nodes)
    open_ = cap > 0
    flow = np.zeros(len(net.tail))
    unreachable = 0.0
    for it in range(1, iterations + 1):
        t = _bpr(net.t0_h, flow, cap)
        g = csr_matrix((t[open_], (net.tail[open_], net.head[open_])), shape=(n, n))
        dist, pred = dijkstra(g, directed=True, return_predecessors=True)
        link = {(int(a), int(b)): i for i, (a, b) in enumerate(zip(net.tail, net.head)) if open_[i]}
        aon = np.zeros(len(net.tail))
        unreachable = 0.0
        for o in range(n):
            load = demand[o].copy()
            reach = np.isfinite(dist[o])
            unreachable += float(load[~reach].sum())
            load[~reach] = 0
            for v in np.argsort(-np.where(reach, dist[o], -1)):
                p = pred[o, v]
                if p < 0 or load[v] == 0:
                    continue
                aon[link[(int(p), int(v))]] += load[v]
                load[p] += load[v]
        flow = flow + (aon - flow) / it
    t = _bpr(net.t0_h, flow, cap)
    g = csr_matrix((t[open_], (net.tail[open_], net.head[open_])), shape=(n, n))
    od = dijkstra(g, directed=True)
    return Assignment(flow, t, float(np.sum(flow[open_] * t[open_])), od, unreachable)


def path_coords(net: Network, cap: np.ndarray, time_h: np.ndarray, o: int, d: int) -> list[Point]:
    n = len(net.nodes)
    open_ = cap > 0
    g = csr_matrix((time_h[open_], (net.tail[open_], net.head[open_])), shape=(n, n))
    _, pred = dijkstra(g, directed=True, indices=[o], return_predecessors=True)
    path, v = [d], d
    while v != o and pred[0, v] >= 0:
        v = int(pred[0, v])
        path.append(v)
    return [net.nodes[i] for i in reversed(path)] if v == o else []


@dataclass
class Scenario:
    road_index: int
    action: str                           # close, reduce_capacity, add_demand
    capacity_factor: float = 0.5          # reduce_capacity: share of capacity left
    extra_trips: float = 0.0              # add_demand: trips per hour to and from the road's ends


def simulate(net: Network, demand: np.ndarray, sc: Scenario, base: Assignment | None = None) -> dict:
    base = base or assign(net, demand)
    cap = net.cap.copy()
    dem = demand.copy()
    road = net.roads[sc.road_index]
    on_road = net.road_of == sc.road_index
    if sc.action == "close":
        cap[on_road] = 0
    elif sc.action == "reduce_capacity":
        cap[on_road] *= max(0.05, min(1.0, sc.capacity_factor))
    elif sc.action == "add_demand":
        others = np.arange(len(net.nodes))
        share = net.node_pop / net.node_pop.sum()
        for end in (road.from_node, road.to_node):
            dem[end, others] += sc.extra_trips / 4 * share
            dem[others, end] += sc.extra_trips / 4 * share
        np.fill_diagonal(dem, 0)
    else:
        raise ValueError(f"Unknown action {sc.action}")
    new = assign(net, dem, cap)

    per_road = []
    for i, r in enumerate(net.roads):
        m = net.road_of == i
        f0, f1 = float(base.flow[m].sum()), float(new.flow[m].sum())
        c = float(net.cap[m].sum())
        t0 = float(np.mean(base.time_h[m]) * 60)
        t1 = float(np.mean(new.time_h[m]) * 60) if np.isfinite(new.time_h[m]).all() else None
        per_road.append({"road_key": r.key, "name": r.name, "flow_before": round(f0), "flow_after": round(f1),
                         "change": round(f1 - f0), "vc_before": round(f0 / c, 2) if c else None,
                         "vc_after": round(f1 / float(cap[m].sum()), 2) if cap[m].sum() > 0 else None,
                         "minutes_before": round(t0, 2), "minutes_after": round(t1, 2) if t1 is not None else None,
                         "coords": r.coords})
    affected = sorted((p for p in per_road if p["road_key"] != road.key), key=lambda p: -abs(p["change"]))[:10]

    # average time of the trips that can still be made, weighted by the base demand
    finite = np.isfinite(base.od_time_h) & np.isfinite(new.od_time_h) & (demand > 0)
    w = np.where(finite, demand, 0.0)
    before = float((np.where(finite, base.od_time_h, 0) * w).sum() / w.sum() * 60) if w.sum() else 0.0
    after = float((np.where(finite, new.od_time_h, 0) * w).sum() / w.sum() * 60) if w.sum() else 0.0

    # the trip most affected: the busiest origin-destination pair whose time rose most
    detour = None
    if sc.action in ("close", "reduce_capacity"):
        delta = np.where(finite, new.od_time_h - base.od_time_h, 0) * (demand > np.quantile(demand[demand > 0], 0.5))
        o, d = np.unravel_index(int(np.argmax(delta)), delta.shape)
        if delta[o, d] > 0:
            detour = {"from_node": int(o), "to_node": int(d),
                      "minutes_before": round(float(base.od_time_h[o, d] * 60), 1),
                      "minutes_after": round(float(new.od_time_h[o, d] * 60), 1),
                      "before": path_coords(net, net.cap, base.time_h, int(o), int(d)),
                      "after": path_coords(net, cap, new.time_h, int(o), int(d))}

    return {
        "label": "Simulated: static peak-hour assignment on the demonstration road network, not measured traffic",
        "road": {"key": road.key, "name": road.name, "action": sc.action, "coords": road.coords},
        "vehicle_hours_before": round(base.vehicle_hours, 1), "vehicle_hours_after": round(new.vehicle_hours, 1),
        "vehicle_hours_change_pct": round((new.vehicle_hours / base.vehicle_hours - 1) * 100, 2) if base.vehicle_hours else None,
        "avg_trip_minutes_before": round(before, 2), "avg_trip_minutes_after": round(after, 2),
        "trips_cut_off": round(new.unreachable_trips),
        "most_affected_roads": affected, "detour": detour,
        "method": "Gravity-model peak-hour demand, BPR link times, user equilibrium by successive averages (40 iterations)",
    }
