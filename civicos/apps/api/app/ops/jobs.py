"""Operations jobs: build the demonstration dataset, train the models, store their outputs, plan routes, simulate.

Each job takes an open connection scoped to one organization (db.as_org), so every statement runs under that
organization's Row Level Security. Jobs read their inputs back from the database, so the same code serves the
demonstration dataset and a city's own connected feeds.
"""
from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import numpy as np
from sqlalchemy import Connection, text

from . import routing, store, traffic, waste, water
from .demo import DemoConfig, generate
from .store import _bulk, _geom, _line, new_run

IST = timezone(timedelta(hours=5, minutes=30))


# --------------------------------------------------------------------------------------------------------- dataset


def seed_demo(conn: Connection, org_id: str, user_id: str | None, seed: int = 2026) -> dict:
    zones = store.load_zones(conn, org_id)
    if not zones:
        raise ValueError("This workspace has no wards. Load the city dataset first.")
    city = generate(zones, DemoConfig(seed=seed))
    store.clear_operations(conn, org_id)
    store.save_dataset(conn, org_id, city, user_id)
    return {"zones": len(zones), "pipes": len(city.water.pipelines), "sensors": len(city.water.sensors),
            "bins": len(city.waste.bins), "roads": len(city.traffic.roads), "generated_at": city.generated_at.isoformat()}


# ----------------------------------------------------------------------------------------------------------- water


def train_water(conn: Connection, org_id: str) -> dict:
    w = store.load_water(conn, org_id)
    if w is None:
        return {"skipped": "no water sensors"}
    demo = store.is_demo(conn, org_id)
    truth = store.load_truth(conn, org_id, w.sensors, w.hours) if demo else None

    # A. anomalies
    a = water.detect_anomalies(w.hours, w.sensors, w.flow_lps, w.pressure_bar, w.consumption_m3, truth)
    run_a = new_run(conn, org_id, "water", "water-anomaly", "Isolation Forest (150 trees, 256 samples each)",
                    a.metrics, {"features": a.features, "suspicious_quantile": water.SUSPICIOUS_Q, "high_quantile": water.HIGH_Q},
                    demo)
    recent = max(0, len(w.hours) - 30 * 24)
    _bulk(conn, """
        update water_readings r set anomaly_score = u.s, anomaly_level = u.l
          from unnest(cast(:id as uuid[]), cast(:t as timestamptz[]), cast(:s as real[]), cast(:l as smallint[])) as u(id, t, s, l)
         where r.sensor_id = u.id and r.ts = u.t and r.organization_id = cast(:org as uuid)""",
          org_id, ((s.key, w.hours[h], float(a.scores[i, h]), int(a.levels[i, h]))
                   for i, s in enumerate(w.sensors) for h in range(recent, len(w.hours))), ["id", "t", "s", "l"])
    conn.execute(text("delete from water_anomalies where organization_id = cast(:org as uuid) and status = 'open'"), {"org": org_id})
    reviewed = defaultdict(list)
    for sid, s0, s1 in conn.execute(text("select sensor_id::text, started_at, ended_at from water_anomalies where organization_id = cast(:org as uuid)"),
                                    {"org": org_id}).all():
        reviewed[sid].append((s0, s1))
    zone_of = {s.key: s.zone_id for s in w.sensors}
    fresh = [e for e in a.events
             if not any(s0 < w.hours[min(e.end, len(w.hours) - 1)] and w.hours[e.start] < s1 for s0, s1 in reviewed[e.sensor_key])]
    _bulk(conn, """
        insert into water_anomalies (organization_id, sensor_id, zone_id, model_run_id, started_at, ended_at, level, peak_score, pattern, evidence)
        select cast(:org as uuid), s, z, cast(run as uuid), t0, t1, l, sc, p, cast(ev as jsonb)
          from unnest(cast(:s as uuid[]), cast(:z as uuid[]), cast(:t0 as timestamptz[]), cast(:t1 as timestamptz[]), cast(:l as text[]),
                      cast(:sc as real[]), cast(:p as text[]), cast(:ev as text[]), cast(:run as text[])) as u(s, z, t0, t1, l, sc, p, ev, run)""",
          org_id, ((e.sensor_key, zone_of[e.sensor_key], w.hours[e.start], w.hours[e.end - 1] + timedelta(hours=1), e.level,
                    e.peak_score, e.pattern, json.dumps(e.evidence), run_a) for e in fresh),
          ["s", "z", "t0", "t1", "l", "sc", "p", "ev", "run"])

    # B. demand forecasts
    f = water.forecast_demand(w.hours, w.sensors, w.consumption_m3)
    run_f = new_run(conn, org_id, "water", "water-demand", "XGBoost regression (direct 24-hour; recursive daily)", f.metrics, {}, demo)
    conn.execute(text("delete from water_predictions where organization_id = cast(:org as uuid)"), {"org": org_id})
    rows = [(z.zone_id, "hour", t, v, lo, hi) for z in f.zones for t, v, lo, hi in z.hourly] + \
           [(z.zone_id, "day", t, v, lo, hi) for z in f.zones for t, v, lo, hi in z.daily]
    _bulk(conn, """
        insert into water_predictions (organization_id, zone_id, model_run_id, granularity, target_at, predicted_m3, lower_m3, upper_m3)
        select cast(:org as uuid), z, cast(run as uuid), g, t, v, lo, hi
          from unnest(cast(:z as uuid[]), cast(:g as text[]), cast(:t as timestamptz[]), cast(:v as real[]), cast(:lo as real[]),
                      cast(:hi as real[]), cast(:run as text[])) as u(z, g, t, v, lo, hi, run)""",
          org_id, (r + (run_f,) for r in rows), ["z", "g", "t", "v", "lo", "hi", "run"])

    # C. pipe failure risk
    cv = defaultdict(list)
    for i, s in enumerate(w.sensors):
        cv[s.zone_id].append(float(np.std(w.pressure_bar[i]) / max(1e-6, np.mean(w.pressure_bar[i]))))
    pressure_cv = {z: float(np.mean(v)) for z, v in cv.items()}
    anomaly_hours = defaultdict(int)
    for i, s in enumerate(w.sensors):
        anomaly_hours[s.pipeline_key] += int((a.levels[i, recent:] > 0).sum())
    year = w.hours[-1].year
    r = water.pipe_risk(w.pipelines, year, pressure_cv, dict(anomaly_hours))
    run_r = new_run(conn, org_id, "water", "water-pipe-risk", "XGBoost classifier with per-pipe factor contributions", r.metrics, {}, demo)
    _bulk(conn, """
        insert into pipeline_risk (pipeline_id, organization_id, model_run_id, probability, level, factors, scored_at)
        select p, cast(:org as uuid), cast(run as uuid), pr, l, cast(f as jsonb), now()
          from unnest(cast(:p as uuid[]), cast(:pr as real[]), cast(:l as text[]), cast(:f as text[]), cast(:run as text[])) as u(p, pr, l, f, run)
        on conflict (pipeline_id) do update set model_run_id = excluded.model_run_id, probability = excluded.probability,
          level = excluded.level, factors = excluded.factors, scored_at = excluded.scored_at""",
          org_id, ((p.pipeline_key, p.probability, p.level, json.dumps(p.factors), run_r) for p in r.pipes), ["p", "pr", "l", "f", "run"])

    # D. shortage
    daily = {z.zone_id: [d[1] for d in z.daily[:7]] for z in f.zones}
    sh = water.shortage_risk(w.reservoirs, daily)
    run_s = new_run(conn, org_id, "water", "water-shortage", "Reservoir water balance: last week's inflow against forecast demand",
                    {"reservoirs": len(sh), "at_risk": sum(1 for x in sh if x.risk != "low")},
                    {"high_below_pct": 20, "medium_below_pct": 35}, demo)
    for x in sh:
        conn.execute(text("""
            insert into reservoir_risk (reservoir_id, organization_id, model_run_id, current_pct, projected_pct, min_pct, days_to_20pct, risk, scored_at)
            values (cast(:id as uuid), cast(:org as uuid), cast(:run as uuid), :cur, :proj, :mn, :d20, :risk, now())
            on conflict (reservoir_id) do update set model_run_id = excluded.model_run_id, current_pct = excluded.current_pct,
              projected_pct = excluded.projected_pct, min_pct = excluded.min_pct, days_to_20pct = excluded.days_to_20pct,
              risk = excluded.risk, scored_at = excluded.scored_at"""),
            {"id": x.reservoir_key, "org": org_id, "run": run_s, "cur": x.current_pct, "proj": x.projected_pct,
             "mn": float(x.min_pct), "d20": x.days_to_20pct, "risk": x.risk})
    return {"anomaly_events": len(fresh), "anomaly_metrics": a.metrics,
            "forecast": {k: v.get("xgboost") for k, v in f.metrics.items() if isinstance(v, dict) and "xgboost" in v},
            "pipe_risk": r.metrics["xgboost"], "reservoirs_at_risk": sum(1 for x in sh if x.risk != "low")}


# ----------------------------------------------------------------------------------------------------------- waste


def train_waste(conn: Connection, org_id: str, optimise_seconds: int = 3) -> dict:
    ws = store.load_waste(conn, org_id)
    if ws is None:
        return {"skipped": "no bins"}
    demo = store.is_demo(conn, org_id)
    res = waste.predict_bins(ws.bins, ws.times, ws.fill_pct, ws.collected)
    run = new_run(conn, org_id, "waste", "waste-overflow", "XGBoost regression (fill) and classifier (overflow)", res.metrics, {}, demo)
    _bulk(conn, """
        insert into waste_predictions (bin_id, organization_id, model_run_id, generated_at, fill_now, fill_6h, fill_12h, fill_24h,
                                       p_overflow_6h, p_overflow_12h, p_overflow_24h)
        select b, cast(:org as uuid), cast(run as uuid), g, f0, f6, f12, f24, p6, p12, p24
          from unnest(cast(:b as uuid[]), cast(:g as timestamptz[]), cast(:f0 as real[]), cast(:f6 as real[]), cast(:f12 as real[]),
                      cast(:f24 as real[]), cast(:p6 as real[]), cast(:p12 as real[]), cast(:p24 as real[]), cast(:run as text[]))
               as u(b, g, f0, f6, f12, f24, p6, p12, p24, run)
        on conflict (bin_id) do update set model_run_id = excluded.model_run_id, generated_at = excluded.generated_at,
          fill_now = excluded.fill_now, fill_6h = excluded.fill_6h, fill_12h = excluded.fill_12h, fill_24h = excluded.fill_24h,
          p_overflow_6h = excluded.p_overflow_6h, p_overflow_12h = excluded.p_overflow_12h, p_overflow_24h = excluded.p_overflow_24h""",
          org_id, ((p.bin_key, res.generated_at, p.fill_now, p.fill[6], p.fill[12], p.fill[24], p.p_overflow[6], p.p_overflow[12],
                    p.p_overflow[24], run) for p in res.bins), ["b", "g", "f0", "f6", "f12", "f24", "p6", "p12", "p24", "run"])

    plans = plan_routes(conn, org_id, ws, {p.bin_key: p for p in res.bins}, optimise_seconds, demo)
    return {"bins": len(res.bins), "overflow_24h": sum(1 for p in res.bins if p.p_overflow[24] >= 0.5),
            "metrics": {h: res.metrics.get(f"{h}h", {}).get("overflow", {}).get("xgboost") for h in waste.HORIZONS_H}, **plans}


def plan_routes(conn: Connection, org_id: str, ws, pred: dict, seconds: int, demo: bool) -> dict:
    # the plan is for the next collection round, at the hour rounds usually happen in the readings
    last = ws.times[-1].astimezone(timezone.utc)
    hours = [ws.times[j].astimezone(timezone.utc).hour for j in range(len(ws.times)) if ws.collected[:, j].any()]
    round_hour = max(set(hours), key=hours.count) if hours else 6
    next_round = last.replace(hour=round_hour, minute=0, second=0, microsecond=0)
    if next_round <= last:
        next_round += timedelta(days=1)
    to_round_h = (next_round - last).total_seconds() / 3600
    planned_for = next_round.astimezone(IST).date()
    n_t = len(ws.times)
    since = waste._since_emptied(ws.collected)
    by_zone_bins, by_zone_veh = defaultdict(list), defaultdict(list)
    for i, b in enumerate(ws.bins):
        p = pred.get(b.key)
        if p is None:
            continue
        by_zone_bins[b.zone_id].append(routing.Stop(
            key=b.key, point=b.point, demand_l=max(p.fill[24], p.fill_now) / 100 * b.capacity_l,
            priority=p.p_overflow[24] >= 0.5 or p.fill[24] >= 75,
            # on the fixed schedule at that round: its interval will have passed by then
            due=since[i, n_t - 1] + to_round_h >= b.collect_every_h - 2))
    for v in ws.vehicles:
        by_zone_veh[v.zone_id].append(v)
    conn.execute(text("delete from collection_plans where organization_id = cast(:org as uuid) and planned_for = :d"),
                 {"org": org_id, "d": planned_for})
    run = new_run(conn, org_id, "waste", "waste-routes", "Capacitated vehicle routing (OR-Tools when installed)",
                  {}, {"priority_rule": "predicted to reach 95% within 24 hours (p >= 0.5), or to be 75% full",
                       "road_factor": routing.ROAD_FACTOR, "truck_speed_kmh": routing.SPEED_KMH,
                       "minutes_per_stop": routing.MINUTES_PER_STOP}, demo)
    code_of = {b.key: b.code for b in ws.bins}
    totals = {"optimised_km": 0.0, "fixed_km": 0.0, "optimised_bins": 0, "fixed_bins": 0, "priority": 0,
              "priority_covered_fixed": 0, "solver": None}
    for zone_id, stops in by_zone_bins.items():
        vehicles = by_zone_veh.get(zone_id)
        if not vehicles:
            continue
        opt, fixed = routing.optimise_zone(vehicles[0].depot, [(v.key, float(v.capacity_l)) for v in vehicles], stops, seconds)
        totals["optimised_km"] += opt.distance_km
        totals["fixed_km"] += fixed.distance_km
        totals["optimised_bins"] += opt.bins_visited
        totals["fixed_bins"] += fixed.bins_visited
        totals["priority"] += opt.priority_bins
        totals["priority_covered_fixed"] += fixed.priority_covered
        if opt.routes:
            totals["solver"] = opt.solver
        for kind, plan in (("optimised", opt), ("fixed", fixed)):
            pid = conn.execute(text("""
                insert into collection_plans (organization_id, zone_id, model_run_id, planned_for, kind, distance_km, minutes,
                                              bins_visited, priority_bins, priority_covered, solver)
                values (cast(:org as uuid), cast(:z as uuid), cast(:run as uuid), :d, :k, :km, :min, :bv, :pb, :pc, :solver)
                returning id::text"""),
                {"org": org_id, "z": zone_id, "run": run, "d": planned_for, "k": kind, "km": plan.distance_km, "min": plan.minutes,
                 "bv": plan.bins_visited, "pb": plan.priority_bins, "pc": plan.priority_covered, "solver": plan.solver}).scalar_one()
            for seq, r in enumerate(plan.routes):
                conn.execute(text(f"""
                    insert into collection_routes (organization_id, plan_id, vehicle_id, seq, stops, geom, distance_km, minutes, load_l)
                    values (cast(:org as uuid), cast(:p as uuid), cast(:v as uuid), :seq, :stops, {_geom(':g')}, :km, :min, :load)"""),
                    {"org": org_id, "p": pid, "v": r.vehicle_key, "seq": seq, "stops": [code_of[s] for s in r.stops],
                     "g": _line(r.coords), "km": r.distance_km, "min": r.minutes, "load": r.load_l})
    conn.execute(text("update model_runs set metrics = cast(:m as jsonb) where id = cast(:id as uuid)"),
                 {"m": json.dumps({k: round(v, 2) if isinstance(v, float) else v for k, v in totals.items()}), "id": run})
    return {"planned_for": planned_for.isoformat(), **totals}


# --------------------------------------------------------------------------------------------------------- traffic


def _network(conn: Connection, org_id: str, roads) -> traffic.Network:
    row = conn.execute(text("select nodes, node_zone_ids from traffic_networks where organization_id = cast(:org as uuid)"),
                       {"org": org_id}).first()
    pops = dict(conn.execute(text("select id::text, coalesce(population, 0) from city_zones where organization_id = cast(:org as uuid)"),
                             {"org": org_id}).all())
    node_zone = list(row[1])
    count = defaultdict(int)
    for z in node_zone:
        count[z] += 1
    node_pop = [max(1.0, pops.get(z, 0) / count[z]) for z in node_zone]
    return traffic.Network.build([tuple(p) for p in row[0]], node_pop, roads)


def train_traffic(conn: Connection, org_id: str) -> dict:
    tr = store.load_traffic(conn, org_id)
    if tr is None or not tr.monitored:
        return {"skipped": "no monitored roads"}
    demo = store.is_demo(conn, org_id)
    mon = [tr.roads[i] for i in tr.monitored]
    f = traffic.forecast_congestion(mon, tr.times, tr.speed_kmh, tr.rain_mm_h, tr.incident_active)
    run = new_run(conn, org_id, "traffic", "traffic-congestion", "XGBoost regression, one model per horizon", f.metrics, {}, demo)
    _bulk(conn, """
        insert into traffic_predictions (road_id, horizon_min, organization_id, model_run_id, generated_at, speed_kmh, congestion, level)
        select r, h, cast(:org as uuid), cast(run as uuid), g, s, c, l
          from unnest(cast(:r as uuid[]), cast(:h as int[]), cast(:g as timestamptz[]), cast(:s as real[]), cast(:c as real[]),
                      cast(:l as text[]), cast(:run as text[])) as u(r, h, g, s, c, l, run)
        on conflict (road_id, horizon_min) do update set model_run_id = excluded.model_run_id, generated_at = excluded.generated_at,
          speed_kmh = excluded.speed_kmh, congestion = excluded.congestion, level = excluded.level""",
          org_id, ((r.road_key, h, f.generated_at, r.speed[h], r.congestion[h], r.level[h], run)
                   for r in f.roads for h in traffic.HORIZONS_MIN), ["r", "h", "g", "s", "c", "l", "run"])

    net = _network(conn, org_id, tr.roads)
    _, trips = traffic.calibrate_demand(net)
    conn.execute(text("update traffic_networks set peak_trips = :t, updated_at = now() where organization_id = cast(:org as uuid)"),
                 {"t": trips, "org": org_id})
    new_run(conn, org_id, "traffic", "traffic-assignment", "Static user-equilibrium assignment (BPR, successive averages)",
            {"peak_hour_trips": round(trips), "roads": len(tr.roads), "junctions": len(tr.nodes)},
            {"calibration": "busiest 10% of links at about 90% of capacity"}, demo)
    return {"roads_forecast": len(f.roads), "metrics": {k: v["xgboost"] for k, v in f.metrics.items() if isinstance(v, dict) and "xgboost" in v},
            "peak_trips": round(trips)}


def simulate(conn: Connection, org_id: str, user_id: str | None, road_id: str, action: str, capacity_factor: float,
             extra_trips: float) -> dict:
    roads_r = conn.execute(text("""
        select id::text, zone_id::text, name, from_node, to_node, st_asgeojson(geom) as g, length_m, lanes, speed_limit,
               capacity_vph, monitored
          from roads where organization_id = cast(:org as uuid) order by from_node, to_node, code"""), {"org": org_id}).mappings().all()
    from .demo import Road
    roads = [Road(r["id"], r["zone_id"], r["name"], r["from_node"], r["to_node"],
                  [tuple(c) for c in json.loads(r["g"])["coordinates"]] if r["g"] else [], float(r["length_m"]), r["lanes"],
                  r["speed_limit"], r["capacity_vph"], r["monitored"]) for r in roads_r]
    idx = next((i for i, r in enumerate(roads) if r.key == road_id), None)
    if idx is None:
        raise ValueError("Road not found.")
    net = _network(conn, org_id, roads)
    trips = conn.execute(text("select peak_trips from traffic_networks where organization_id = cast(:org as uuid)"), {"org": org_id}).scalar()
    demand = traffic.gravity_demand(net, float(trips)) if trips else traffic.calibrate_demand(net)[0]
    result = traffic.simulate(net, demand, traffic.Scenario(idx, action, capacity_factor, extra_trips))
    result["generated_at"] = datetime.now(timezone.utc).isoformat()
    sid = conn.execute(text("""
        insert into traffic_simulations (organization_id, road_id, action, params, result, created_by)
        values (cast(:org as uuid), cast(:road as uuid), :action, cast(:params as jsonb), cast(:result as jsonb), cast(:uid as uuid))
        returning id::text"""),
        {"org": org_id, "road": road_id, "action": action,
         "params": json.dumps({"capacity_factor": capacity_factor, "extra_trips": extra_trips}),
         "result": json.dumps(result, default=store._json_default), "uid": user_id}).scalar_one()
    return {"id": sid, **result}


# ------------------------------------------------------------------------------------------------------------- all


def train_all(conn_factory, org_id: str) -> dict:
    """Each module in its own transaction, so one failing does not undo the others."""
    out = {}
    for name, fn in (("water", train_water), ("waste", train_waste), ("traffic", train_traffic)):
        try:
            with conn_factory() as conn:
                out[name] = fn(conn, org_id)
        except Exception as e:  # noqa: BLE001 - reported per module
            out[name] = {"error": f"{type(e).__name__}: {e}"}
    return out
