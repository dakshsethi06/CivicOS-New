"""Collection route optimisation (a capacitated vehicle routing problem).

For each ward, the bins worth visiting today are those predicted to reach 95% within 24 hours, or already above 80%.
Each vehicle starts and ends at its depot, carries a limited volume, and the solver minimises total distance.
OR-Tools (Google's routing solver, guided local search) is used when installed; otherwise a savings construction
with 2-opt improvement. The plan is compared with the fixed schedule it replaces: every bin, every round, in a fixed
order. Distances are straight-line between stops times a road factor of 1.3, so they are estimates, not road routes.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .geo import Point, distance_matrix_m

ROAD_FACTOR = 1.3
SPEED_KMH = 18.0                # average collection-truck speed in city traffic
MINUTES_PER_STOP = 4.0
COMPACTION = 3.0                # a compactor truck holds about three times its body volume of loose waste


@dataclass
class Stop:
    key: str
    point: Point
    demand_l: float             # litres to lift
    priority: bool              # needs collecting today, by the forecast
    due: bool = True            # on today's fixed schedule


@dataclass
class Route:
    vehicle_key: str
    stops: list[str]            # stop keys in order (depot excluded)
    coords: list[Point]         # depot, stops..., depot
    distance_km: float
    minutes: float
    load_l: float


@dataclass
class Plan:
    routes: list[Route]
    distance_km: float
    minutes: float
    bins_visited: int
    priority_bins: int
    priority_covered: int
    solver: str


def _route_cost(order: list[int], d: np.ndarray) -> float:
    return float(sum(d[order[i], order[i + 1]] for i in range(len(order) - 1)))


def _two_opt(order: list[int], d: np.ndarray) -> list[int]:
    best = order[:]
    improved = True
    while improved:
        improved = False
        for i in range(1, len(best) - 2):
            for j in range(i + 1, len(best) - 1):
                a, b, c, e = best[i - 1], best[i], best[j], best[j + 1]
                if d[a, c] + d[b, e] < d[a, b] + d[c, e] - 1e-9:
                    best[i:j + 1] = reversed(best[i:j + 1])
                    improved = True
    return best


def _savings(d: np.ndarray, demand: np.ndarray, cap: float, n_vehicles: int) -> list[list[int]]:
    """Clarke-Wright savings from a single depot (node 0); routes over the fleet size are merged greedily."""
    n = len(demand)
    routes = {i: [i] for i in range(1, n)}
    where = {i: i for i in range(1, n)}
    load = {i: demand[i] for i in range(1, n)}
    sav = sorted(((d[0, i] + d[0, j] - d[i, j], i, j) for i in range(1, n) for j in range(i + 1, n)), reverse=True)
    for s, i, j in sav:
        ri, rj = where[i], where[j]
        if ri == rj or load[ri] + load[rj] > cap:
            continue
        a, b = routes[ri], routes[rj]
        if a[-1] == i and b[0] == j:
            merged = a + b
        elif a[0] == i and b[-1] == j:
            merged = b + a
        elif a[-1] == i and b[-1] == j:
            merged = a + b[::-1]
        elif a[0] == i and b[0] == j:
            merged = a[::-1] + b
        else:
            continue
        routes[ri] = merged
        load[ri] += load[rj]
        del routes[rj], load[rj]
        for k in merged:
            where[k] = ri
    # more routes than vehicles means some vehicles make a second trip from the depot
    return list(routes.values())


def _solve_fallback(d: np.ndarray, demand: np.ndarray, cap: float, n_vehicles: int) -> list[list[int]]:
    routes = _savings(d, demand, cap, n_vehicles)
    return [_two_opt([0] + r + [0], d)[1:-1] for r in routes]


def _solve_ortools(d: np.ndarray, demand: np.ndarray, cap: float, n_vehicles: int, seconds: int) -> list[list[int]] | None:
    try:
        from ortools.constraint_solver import pywrapcp, routing_enums_pb2
    except ImportError:
        return None
    # enough vehicle slots for extra trips if total demand exceeds the fleet's capacity in one round
    slots = max(n_vehicles, math.ceil(demand.sum() / cap))
    dist = np.rint(d).astype(int)
    manager = pywrapcp.RoutingIndexManager(len(d), slots, 0)
    routing = pywrapcp.RoutingModel(manager)
    transit = routing.RegisterTransitCallback(lambda i, j: int(dist[manager.IndexToNode(i), manager.IndexToNode(j)]))
    routing.SetArcCostEvaluatorOfAllVehicles(transit)
    dem = np.rint(demand).astype(int)
    demand_cb = routing.RegisterUnaryTransitCallback(lambda i: int(dem[manager.IndexToNode(i)]))
    routing.AddDimensionWithVehicleCapacity(demand_cb, 0, [int(cap)] * slots, True, "load")
    params = pywrapcp.DefaultRoutingSearchParameters()
    params.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    params.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    params.time_limit.seconds = seconds
    sol = routing.SolveWithParameters(params)
    if sol is None:
        return None
    routes = []
    for v in range(slots):
        idx = routing.Start(v)
        r = []
        while not routing.IsEnd(idx):
            node = manager.IndexToNode(idx)
            if node:
                r.append(node)
            idx = sol.Value(routing.NextVar(idx))
        if r:
            routes.append(r)
    return routes


def _plan(depot: Point, stops: list[Stop], vehicles: list[tuple[str, float]], routes_idx: list[list[int]],
          d: np.ndarray, solver: str, priority_total: int) -> Plan:
    pts = [depot] + [s.point for s in stops]
    routes = []
    for k, r in enumerate(routes_idx):
        vkey = vehicles[k % len(vehicles)][0]
        order = [0] + r + [0]
        km = _route_cost(order, d) / 1000
        routes.append(Route(vkey, [stops[i - 1].key for i in r], [pts[i] for i in order], round(km, 2),
                            round(km / SPEED_KMH * 60 + MINUTES_PER_STOP * len(r), 1),
                            round(float(sum(stops[i - 1].demand_l for i in r)), 0)))
    visited = {s for r in routes for s in r.stops}
    return Plan(routes, round(sum(r.distance_km for r in routes), 2), round(sum(r.minutes for r in routes), 1), len(visited),
                priority_total, sum(1 for s in stops if s.priority and s.key in visited), solver)


def optimise_zone(depot: Point, vehicles: list[tuple[str, float]], bins: list[Stop], seconds: int = 3) -> tuple[Plan, Plan]:
    """Returns (optimised plan for the bins the forecast says need collecting, today's fixed schedule)."""
    cap = min(c for _, c in vehicles) * COMPACTION
    priority_total = sum(1 for b in bins if b.priority)

    # fixed schedule: the bins due today, in code order, split evenly between the vehicles
    due = [b for b in bins if b.due]
    due_pts = [depot] + [b.point for b in due]
    d_due = distance_matrix_m(due_pts) * ROAD_FACTOR
    chunks = np.array_split(np.arange(1, len(due_pts)), len(vehicles))
    baseline = _plan(depot, due, vehicles, [list(map(int, c)) for c in chunks if len(c)], d_due, "fixed schedule",
                     priority_total)

    chosen = [b for b in bins if b.priority]
    if not chosen:
        return Plan([], 0.0, 0.0, 0, priority_total, 0, "nothing to collect"), baseline
    pts = [depot] + [b.point for b in chosen]
    d = distance_matrix_m(pts) * ROAD_FACTOR
    demand = np.array([0.0] + [b.demand_l for b in chosen])
    routes = _solve_ortools(d, demand, cap, len(vehicles), seconds)
    solver = "OR-Tools (guided local search)"
    if routes is None:
        routes = _solve_fallback(d, demand, cap, len(vehicles))
        solver = "savings + 2-opt"
    return _plan(depot, chosen, vehicles, routes, d, solver, priority_total), baseline
