"""Operations models on a small demonstration city. No database or network."""
from datetime import datetime, timezone

import numpy as np
import pytest

from app.ops import routing, traffic, waste, water
from app.ops.demo import DemoConfig, Zone, generate
from app.ops.geo import Area, haversine_m
from app.ops.iforest import IsolationForest

END = datetime(2026, 11, 16, 13, tzinfo=timezone.utc)


@pytest.fixture(scope="module")
def city():
    zones = [Zone(f"z{i}", f"W{i}", f"Ward {i}", 250_000 + 30_000 * i, Area.box(72.85 + 0.03 * (i % 3), 19.0 + 0.03 * (i // 3)),
                  waste_tpd=150 + 20 * i) for i in range(6)]
    return zones, generate(zones, DemoConfig(water_days=90, waste_days=14, traffic_days=8), end=END)


def test_isolation_forest_scores_outliers_higher():
    rng = np.random.default_rng(0)
    X = np.vstack([rng.normal(0, 1, (500, 3)), [[8, 8, 8], [-7, 6, 9]]])
    s = IsolationForest(n_estimators=100, random_state=0).fit(X).score(X)
    assert s[-2:].min() > np.quantile(s[:-2], 0.99)


def test_demo_is_deterministic_and_inside_wards(city):
    zones, c = city
    again = generate(zones, DemoConfig(water_days=90, waste_days=14, traffic_days=8), end=END)
    assert np.array_equal(c.water.consumption_m3, again.water.consumption_m3)
    area = {z.id: z.area for z in zones}
    pipe_mid = {p.key: p.coords[1] for p in c.water.pipelines}
    assert all(s.point == pipe_mid[s.pipeline_key] for s in c.water.sensors)            # meters sit on their pipes
    assert all(area[b.zone_id].contains(b.point) for b in c.waste.bins)
    assert c.water.events and c.waste.collected.any() and c.traffic.monitored


def test_anomaly_detector_finds_injected_faults(city):
    _, c = city
    w = c.water
    a = water.detect_anomalies(w.hours, w.sensors, w.flow_lps, w.pressure_bar, w.consumption_m3, [e.__dict__ for e in w.events])
    found, total = map(int, a.metrics["faults_detected"].split(" of "))
    assert found >= 0.8 * total
    assert a.metrics["flagged_share"] <= 0.012
    assert all(e.level in ("suspicious", "high") and e.pattern for e in a.events)


def test_demand_forecast_beats_naive_and_has_bands(city):
    _, c = city
    f = water.forecast_demand(c.water.hours, c.water.sensors, c.water.consumption_m3)
    m = f.metrics["next_24_hours"]
    assert m["xgboost"]["mae"] < m["same_hour_yesterday"]["mae"]
    z = f.zones[0]
    assert len(z.hourly) == 24 and len(z.daily) == 30
    assert all(lo <= v <= hi for _, v, lo, hi in z.hourly + z.daily)


def test_pipe_risk_is_probabilistic_and_explained(city):
    _, c = city
    r = water.pipe_risk(c.water.pipelines, END.year, {}, {})
    assert all(0 <= p.probability <= 1 and p.factors for p in r.pipes)
    assert r.metrics["xgboost"]["auc"] > 0.6


def test_shortage_projection(city):
    _, c = city
    s = water.shortage_risk(c.water.reservoirs, {r.zone_id: [1e9] * 7 for r in c.water.reservoirs})   # huge demand
    assert all(x.risk == "high" and x.min_pct < 20 for x in s)


def test_waste_predictions_monotone_in_horizon(city):
    _, c = city
    ws = c.waste
    r = waste.predict_bins(ws.bins, ws.times, ws.fill_pct, ws.collected)
    assert len(r.bins) == len(ws.bins)
    for b in r.bins:
        assert b.p_overflow[6] <= b.p_overflow[12] <= b.p_overflow[24]
        assert b.fill_now <= b.fill[6] <= b.fill[12] <= b.fill[24] <= 100
    assert {"6h", "12h", "24h"} <= set(r.metrics)


def test_routes_respect_capacity_and_cover_priority_bins():
    rng = np.random.default_rng(1)
    pts = [(72.85 + x, 19.0 + y) for x, y in rng.uniform(0, 0.03, (14, 2))]
    stops = [routing.Stop(f"b{i}", p, 900.0, priority=i % 2 == 0) for i, p in enumerate(pts)]
    opt, fixed = routing.optimise_zone((72.86, 19.01), [("v1", 1000.0), ("v2", 1000.0)], stops)
    cap = 1000 * routing.COMPACTION
    assert all(r.load_l <= cap for r in opt.routes)
    assert opt.priority_covered == opt.priority_bins == 7
    assert fixed.bins_visited == 14 and opt.distance_km < fixed.distance_km


def test_two_opt_never_lengthens_a_tour():
    rng = np.random.default_rng(2)
    pts = rng.uniform(0, 1, (12, 2))
    d = np.linalg.norm(pts[:, None] - pts[None], axis=2)
    order = [0] + list(rng.permutation(range(1, 12))) + [0]
    assert routing._route_cost(routing._two_opt(order, d), d) <= routing._route_cost(order, d) + 1e-9


def test_traffic_forecast_and_simulation(city):
    zones, c = city
    tr = c.traffic
    mon = [tr.roads[i] for i in tr.monitored]
    f = traffic.forecast_congestion(mon, tr.times, tr.speed_kmh, tr.rain_mm_h, tr.incident_active)
    for h in (15, 30, 60):
        assert f.metrics[f"{h}min"]["xgboost"]["mae"] < f.metrics[f"{h}min"]["no_change"]["mae"]
    assert all(set(r.speed) == {15, 30, 60} for r in f.roads)

    pop = {z.id: z.population for z in zones}
    count = {z: tr.node_zone.count(z) for z in set(tr.node_zone)}
    net = traffic.Network.build(tr.nodes, [pop[z] / count[z] for z in tr.node_zone], tr.roads)
    demand, _ = traffic.calibrate_demand(net)
    base = traffic.assign(net, demand)
    busiest = int(np.argmax([base.flow[net.road_of == i].sum() for i in range(len(tr.roads))]))
    closed = traffic.simulate(net, demand, traffic.Scenario(busiest, "close"), base)
    more = traffic.simulate(net, demand, traffic.Scenario(busiest, "add_demand", extra_trips=3000), base)
    assert closed["vehicle_hours_after"] >= closed["vehicle_hours_before"] or closed["trips_cut_off"] > 0
    assert more["vehicle_hours_after"] > more["vehicle_hours_before"]
    assert closed["label"].startswith("Simulated")


def test_haversine_known_distance():
    # one degree of latitude is about 111 km
    assert abs(haversine_m((72.8, 19.0), (72.8, 20.0)) - 111_195) < 200
