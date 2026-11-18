"""Reading and writing the operations tables (supabase/migrations/0018_operations.sql).

Every function takes an open connection from db.as_user / db.as_org, so Row Level Security scopes each statement to
one organization. Bulk rows go in through unnest() over arrays, a few thousand at a time.
"""
from __future__ import annotations

import json
from collections.abc import Iterable, Sequence
from datetime import date, datetime
from typing import Any

import numpy as np
from sqlalchemy import Connection, text

from .demo import (Bin, DemoCity, Pipeline, Reservoir, Road, Sensor, TrafficData, Vehicle, WasteData, WaterData, Zone)
from .geo import Area, Point

CHUNK = 5000


def _point(p: Point) -> str:
    return json.dumps({"type": "Point", "coordinates": [p[0], p[1]]})


def _line(coords: Sequence[Point]) -> str:
    return json.dumps({"type": "LineString", "coordinates": [[x, y] for x, y in coords]})


def _geom(sql_param: str) -> str:
    return f"st_setsrid(st_geomfromgeojson({sql_param}), 4326)"


def _bulk(conn: Connection, sql: str, org_id: str, rows: Iterable[tuple], names: list[str]) -> int:
    """Inserts rows through unnest() over one array per column, CHUNK rows per statement."""
    rows = list(rows)
    for s in range(0, len(rows), CHUNK):
        part = rows[s:s + CHUNK]
        conn.execute(text(sql), {"org": org_id, **{n: [r[i] for r in part] for i, n in enumerate(names)}})
    return len(rows)


# ---------------------------------------------------------------------------------------------------------- zones


def load_zones(conn: Connection, org_id: str) -> list[Zone]:
    rows = conn.execute(text("""
        select z.id::text, z.code, z.name, coalesce(z.population, 0) as population,
               st_asgeojson(z.boundary) as gj,
               (select value from civic_indicators i
                 where i.zone_id = z.id and i.metric = 'waste_tonnes_per_day' and i.category is null and i.month is null
                 order by year desc limit 1) as waste_tpd
          from city_zones z
         where z.organization_id = cast(:org as uuid)
         order by z.code"""), {"org": org_id}).mappings().all()
    zones = []
    for r in rows:
        area = Area.from_geojson(json.loads(r["gj"])) if r["gj"] else Area.box(72.87, 19.07)
        zones.append(Zone(r["id"], r["code"], r["name"], int(r["population"]), area,
                          float(r["waste_tpd"]) if r["waste_tpd"] is not None else None))
    return zones


# ------------------------------------------------------------------------------------------------------- dataset


def clear_operations(conn: Connection, org_id: str) -> None:
    """Removes this organization's operations data (cascades to readings, predictions and plans)."""
    for t in ("traffic_simulations", "traffic_incidents", "roads", "traffic_networks", "weather_readings",
              "collection_plans", "collection_vehicles", "waste_bins", "water_anomalies", "water_predictions",
              "water_sensors", "water_pipelines", "water_reservoirs", "model_runs", "ops_datasets"):
        conn.execute(text(f"delete from public.{t} where organization_id = cast(:org as uuid)"), {"org": org_id})


def save_dataset(conn: Connection, org_id: str, city: DemoCity, user_id: str | None) -> dict[str, dict[str, str]]:
    """Writes the demonstration network and readings. Returns key -> database id maps for each kind of asset."""
    org = {"org": org_id}
    w, ws, tr = city.water, city.waste, city.traffic
    truth = {"water_events": [e.__dict__ for e in w.events], "water_hours_start": w.hours[0].isoformat()}
    conn.execute(text("""
        insert into ops_datasets (organization_id, kind, generated_at, seed, config, truth, created_by)
        values (cast(:org as uuid), 'demo', :at, :seed, cast(:config as jsonb), cast(:truth as jsonb), cast(:uid as uuid))"""),
        {**org, "at": city.generated_at, "seed": city.config.seed, "config": json.dumps(city.config.__dict__),
         "truth": json.dumps(truth), "uid": user_id})
    ids: dict[str, dict[str, str]] = {}

    def insert_returning(sql: str, rows: list[dict]) -> dict[str, str]:
        out = {}
        for r in rows:
            out[r["key"]] = conn.execute(text(sql), {**org, **r}).scalar_one()
        return out

    ids["reservoir"] = insert_returning(f"""
        insert into water_reservoirs (organization_id, zone_id, code, name, capacity_ml, geom)
        values (cast(:org as uuid), cast(:zone as uuid), :code, :name, :cap, {_geom(':g')}) returning id::text""",
        [{"key": r.key, "zone": r.zone_id, "code": r.key, "name": r.name, "cap": r.capacity_ml, "g": _point(r.point)}
         for r in w.reservoirs])
    ids["pipeline"] = insert_returning(f"""
        insert into water_pipelines (organization_id, zone_id, code, material, diameter_mm, installed_year, length_m,
                                     failures_by_year, geom)
        values (cast(:org as uuid), cast(:zone as uuid), :code, :mat, :dia, :yr, :len, :fails, {_geom(':g')})
        returning id::text""",
        [{"key": p.key, "zone": p.zone_id, "code": p.code, "mat": p.material, "dia": p.diameter_mm, "yr": p.installed_year,
          "len": p.length_m, "fails": p.failures_by_year, "g": _line(p.coords)} for p in w.pipelines])
    ids["sensor"] = insert_returning(f"""
        insert into water_sensors (organization_id, zone_id, pipeline_id, code, share, geom)
        values (cast(:org as uuid), cast(:zone as uuid), cast(:pipe as uuid), :code, :share, {_geom(':g')}) returning id::text""",
        [{"key": s.key, "zone": s.zone_id, "pipe": ids["pipeline"][s.pipeline_key], "code": s.code, "share": s.share,
          "g": _point(s.point)} for s in w.sensors])

    n_h = len(w.hours)
    _bulk(conn, """
        insert into reservoir_readings (organization_id, reservoir_id, ts, level_pct, inflow_ml)
        select cast(:org as uuid), r, t, l, i
          from unnest(cast(:r as uuid[]), cast(:t as timestamptz[]), cast(:l as real[]), cast(:i as real[])) as u(r, t, l, i)""",
          org_id, ((ids["reservoir"][r.key], w.hours[h], float(r.level_pct[h]), float(r.inflow_ml[h]))
                   for r in w.reservoirs for h in range(n_h)), ["r", "t", "l", "i"])
    _bulk(conn, """
        insert into water_readings (organization_id, sensor_id, ts, flow_lps, pressure_bar, consumption_m3)
        select cast(:org as uuid), s, t, f, p, c
          from unnest(cast(:s as uuid[]), cast(:t as timestamptz[]), cast(:f as real[]), cast(:p as real[]), cast(:c as real[]))
               as u(s, t, f, p, c)""",
          org_id, ((ids["sensor"][s.key], w.hours[h], float(w.flow_lps[i, h]), float(w.pressure_bar[i, h]),
                    float(w.consumption_m3[i, h])) for i, s in enumerate(w.sensors) for h in range(n_h)),
          ["s", "t", "f", "p", "c"])

    # waste
    ids["vehicle"] = insert_returning(f"""
        insert into collection_vehicles (organization_id, zone_id, code, capacity_l, depot)
        values (cast(:org as uuid), cast(:zone as uuid), :code, :cap, {_geom(':g')}) returning id::text""",
        [{"key": v.key, "zone": v.zone_id, "code": v.code, "cap": v.capacity_l, "g": _point(v.depot)} for v in ws.vehicles])
    ids["bin"] = insert_returning(f"""
        insert into waste_bins (organization_id, zone_id, code, kind, capacity_l, collect_every_h, geom)
        values (cast(:org as uuid), cast(:zone as uuid), :code, :kind, :cap, :every, {_geom(':g')}) returning id::text""",
        [{"key": b.key, "zone": b.zone_id, "code": b.code, "kind": b.kind, "cap": b.capacity_l, "every": b.collect_every_h,
          "g": _point(b.point)} for b in ws.bins])
    _bulk(conn, """
        insert into waste_readings (organization_id, bin_id, ts, fill_pct, collected)
        select cast(:org as uuid), b, t, f, c
          from unnest(cast(:b as uuid[]), cast(:t as timestamptz[]), cast(:f as real[]), cast(:c as boolean[])) as u(b, t, f, c)""",
          org_id, ((ids["bin"][b.key], ws.times[j], float(ws.fill_pct[i, j]), bool(ws.collected[i, j]))
                   for i, b in enumerate(ws.bins) for j in range(len(ws.times))), ["b", "t", "f", "c"])

    # traffic
    conn.execute(text("""
        insert into traffic_networks (organization_id, nodes, node_zone_ids)
        values (cast(:org as uuid), cast(:nodes as jsonb), cast(:nz as jsonb))"""),
        {**org, "nodes": json.dumps([[x, y] for x, y in tr.nodes]), "nz": json.dumps(tr.node_zone)})
    ids["road"] = insert_returning(f"""
        insert into roads (organization_id, zone_id, code, name, from_node, to_node, lanes, speed_limit, capacity_vph,
                           length_m, monitored, geom)
        values (cast(:org as uuid), cast(:zone as uuid), :code, :name, :a, :b, :lanes, :lim, :cap, :len, :mon, {_geom(':g')})
        returning id::text""",
        [{"key": r.key, "zone": r.zone_id, "code": r.key, "name": r.name, "a": r.from_node, "b": r.to_node, "lanes": r.lanes,
          "lim": r.speed_limit, "cap": r.capacity_vph, "len": r.length_m, "mon": r.monitored, "g": _line(r.coords)}
         for r in tr.roads])
    _bulk(conn, """
        insert into traffic_readings (organization_id, road_id, ts, speed_kmh, volume_vph, incident)
        select cast(:org as uuid), r, t, s, v, i
          from unnest(cast(:r as uuid[]), cast(:t as timestamptz[]), cast(:s as real[]), cast(:v as real[]), cast(:i as boolean[]))
               as u(r, t, s, v, i)""",
          org_id, ((ids["road"][tr.roads[ri].key], tr.times[j], float(tr.speed_kmh[k, j]), float(tr.volume_vph[k, j]),
                    bool(tr.incident_active[k, j])) for k, ri in enumerate(tr.monitored) for j in range(len(tr.times))),
          ["r", "t", "s", "v", "i"])
    _bulk(conn, """
        insert into weather_readings (organization_id, ts, rain_mm_h)
        select cast(:org as uuid), t, r from unnest(cast(:t as timestamptz[]), cast(:r as real[])) as u(t, r)""",
          org_id, ((t, float(r)) for t, r in zip(tr.times, tr.rain_mm_h)), ["t", "r"])
    _bulk(conn, f"""
        insert into traffic_incidents (organization_id, road_id, kind, severity, occurred_at, duration_min, geom)
        select cast(:org as uuid), r, k, s, t, d, {_geom('g')}
          from unnest(cast(:r as uuid[]), cast(:k as text[]), cast(:s as text[]), cast(:t as timestamptz[]), cast(:d as int[]),
                      cast(:g as text[])) as u(r, k, s, t, d, g)""",
          org_id, ((ids["road"][i.road_key], i.kind, i.severity, i.occurred_at, i.duration_min, _point(i.point))
                   for i in tr.incidents), ["r", "k", "s", "t", "d", "g"])
    return ids


# ------------------------------------------------------------------------------------------------------- loading


def load_water(conn: Connection, org_id: str) -> WaterData | None:
    sensors = conn.execute(text("""
        select s.id::text, s.zone_id::text, coalesce(s.pipeline_id::text, '') as pipe, s.code,
               coalesce(s.share, 0.5) as share, st_asgeojson(s.geom) as g
          from water_sensors s
         where s.organization_id = cast(:org as uuid) order by s.code"""), {"org": org_id}).mappings().all()
    if not sensors:
        return None
    rows = conn.execute(text("""
        select sensor_id::text, ts, flow_lps, pressure_bar, consumption_m3 from water_readings
         where organization_id = cast(:org as uuid) order by ts"""), {"org": org_id}).all()
    hours = sorted({r[1] for r in rows})
    h_idx = {h: i for i, h in enumerate(hours)}
    s_idx = {s["id"]: i for i, s in enumerate(sensors)}
    F, P, C = (np.full((len(sensors), len(hours)), np.nan) for _ in range(3))
    for sid, ts, f, p, c in rows:
        i, j = s_idx[sid], h_idx[ts]
        F[i, j], P[i, j], C[i, j] = f, p, c
    for M in (F, P, C):                                    # gaps: carry the last reading forward
        for i in range(M.shape[0]):
            last = np.nanmean(M[i]) if np.isfinite(M[i]).any() else 0.0
            for j in range(M.shape[1]):
                if np.isnan(M[i, j]):
                    M[i, j] = last
                else:
                    last = M[i, j]
    sens = [Sensor(key=s["id"], zone_id=s["zone_id"], pipeline_key=s["pipe"], code=s["code"],
                   point=tuple(json.loads(s["g"])["coordinates"]) if s["g"] else (0.0, 0.0), share=float(s["share"]))
            for s in sensors]

    pipes = [Pipeline(key=r["id"], zone_id=r["zone_id"], code=r["code"], material=r["material"], diameter_mm=r["diameter_mm"],
                      installed_year=r["installed_year"], coords=[tuple(c) for c in json.loads(r["g"])["coordinates"]] if r["g"] else [],
                      length_m=float(r["length_m"]), failures_by_year=list(r["failures_by_year"]) or [0] * 6)
             for r in conn.execute(text("""
                select id::text, zone_id::text, code, material, diameter_mm, installed_year, length_m, failures_by_year,
                       st_asgeojson(geom) as g
                  from water_pipelines where organization_id = cast(:org as uuid) order by code"""), {"org": org_id}).mappings()]

    res = []
    for r in conn.execute(text("""
            select id::text, zone_id::text, code, name, capacity_ml, st_asgeojson(geom) as g
              from water_reservoirs where organization_id = cast(:org as uuid) order by code"""), {"org": org_id}).mappings():
        lv = conn.execute(text("select ts, level_pct, coalesce(inflow_ml, 0) from reservoir_readings where reservoir_id = cast(:id as uuid) order by ts"),
                          {"id": r["id"]}).all()
        res.append(Reservoir(key=r["id"], zone_id=r["zone_id"], name=r["name"], capacity_ml=float(r["capacity_ml"]),
                             point=tuple(json.loads(r["g"])["coordinates"]) if r["g"] else (0.0, 0.0),
                             level_pct=np.array([x[1] for x in lv], dtype=float), inflow_ml=np.array([x[2] for x in lv], dtype=float)))
    return WaterData(hours, res, pipes, sens, F, P, C, [])


def load_truth(conn: Connection, org_id: str, sensors: list[Sensor], hours: list[datetime]) -> list[dict] | None:
    """Injected faults of the demonstration dataset, re-keyed to database ids and the loaded hour index."""
    row = conn.execute(text("select truth from ops_datasets where organization_id = cast(:org as uuid) and kind = 'demo'"),
                       {"org": org_id}).scalar()
    if not row or not row.get("water_events"):
        return None
    start = datetime.fromisoformat(row["water_hours_start"])
    offset = int(round((hours[0] - start).total_seconds() / 3600))
    by_code = {}
    for s in sensors:                                     # demo keys are "<ward>-S<n>", codes "<ward>-FM<n>"
        by_code[s.code.replace("-FM", "-S")] = s.key
    out = []
    for e in row["water_events"]:
        if e["sensor_key"] in by_code and e["end"] - offset > 0:
            out.append({"sensor_key": by_code[e["sensor_key"]], "kind": e["kind"],
                        "start": max(0, e["start"] - offset), "end": e["end"] - offset})
    return out


def load_waste(conn: Connection, org_id: str) -> WasteData | None:
    bins_r = conn.execute(text("""
        select id::text, zone_id::text, code, kind, capacity_l, collect_every_h, st_asgeojson(geom) as g
          from waste_bins where organization_id = cast(:org as uuid) order by code"""), {"org": org_id}).mappings().all()
    if not bins_r:
        return None
    bins = [Bin(b["id"], b["zone_id"], b["code"], b["kind"], b["capacity_l"],
                tuple(json.loads(b["g"])["coordinates"]) if b["g"] else (0.0, 0.0), b["collect_every_h"]) for b in bins_r]
    vehicles = [Vehicle(v["id"], v["zone_id"], v["code"], v["capacity_l"], tuple(json.loads(v["g"])["coordinates"]))
                for v in conn.execute(text("""
                    select id::text, zone_id::text, code, capacity_l, st_asgeojson(depot) as g from collection_vehicles
                     where organization_id = cast(:org as uuid) and active order by code"""), {"org": org_id}).mappings()]
    rows = conn.execute(text("""
        select bin_id::text, ts, fill_pct, collected from waste_readings where organization_id = cast(:org as uuid) order by ts"""),
        {"org": org_id}).all()
    times = sorted({r[1] for r in rows})
    t_idx = {t: i for i, t in enumerate(times)}
    b_idx = {b.key: i for i, b in enumerate(bins)}
    fill = np.zeros((len(bins), len(times)))
    col = np.zeros((len(bins), len(times)), dtype=bool)
    for bid, ts, f, c in rows:
        fill[b_idx[bid], t_idx[ts]] = f
        col[b_idx[bid], t_idx[ts]] = c
    return WasteData(times, bins, vehicles, fill, col)


def load_traffic(conn: Connection, org_id: str) -> TrafficData | None:
    net = conn.execute(text("select nodes, node_zone_ids from traffic_networks where organization_id = cast(:org as uuid)"),
                       {"org": org_id}).first()
    if not net:
        return None
    roads_r = conn.execute(text("""
        select id::text, zone_id::text, name, from_node, to_node, st_asgeojson(geom) as g, length_m, lanes, speed_limit,
               capacity_vph, monitored
          from roads where organization_id = cast(:org as uuid) order by from_node, to_node, code"""), {"org": org_id}).mappings().all()
    roads = [Road(r["id"], r["zone_id"], r["name"], r["from_node"], r["to_node"],
                  [tuple(c) for c in json.loads(r["g"])["coordinates"]] if r["g"] else [], float(r["length_m"]), r["lanes"],
                  r["speed_limit"], r["capacity_vph"], r["monitored"]) for r in roads_r]
    monitored = [i for i, r in enumerate(roads) if r.monitored]
    rows = conn.execute(text("""
        select road_id::text, ts, speed_kmh, volume_vph, incident from traffic_readings
         where organization_id = cast(:org as uuid) order by ts"""), {"org": org_id}).all()
    times = sorted({r[1] for r in rows})
    t_idx = {t: i for i, t in enumerate(times)}
    m_idx = {roads[i].key: k for k, i in enumerate(monitored)}
    S = np.zeros((len(monitored), len(times)))
    V = np.zeros_like(S)
    I = np.zeros(S.shape, dtype=bool)
    for rid, ts, s, v, inc in rows:
        if rid in m_idx:
            S[m_idx[rid], t_idx[ts]], V[m_idx[rid], t_idx[ts]], I[m_idx[rid], t_idx[ts]] = s, v, inc
    rain_map = dict(conn.execute(text("select ts, rain_mm_h from weather_readings where organization_id = cast(:org as uuid)"),
                                 {"org": org_id}).all())
    rain = np.array([rain_map.get(t, 0.0) for t in times])
    return TrafficData(times, [tuple(p) for p in net[0]], list(net[1]), roads, monitored, S, V, rain, I, [])


# -------------------------------------------------------------------------------------------------------- outputs


def new_run(conn: Connection, org_id: str, module: str, model: str, method: str, metrics: dict, params: dict,
            is_demo: bool) -> str:
    return conn.execute(text("""
        insert into model_runs (organization_id, module, model, method, metrics, params, is_demo)
        values (cast(:org as uuid), :module, :model, :method, cast(:metrics as jsonb), cast(:params as jsonb), :demo)
        returning id::text"""), {"org": org_id, "module": module, "model": model, "method": method,
                                 "metrics": json.dumps(metrics, default=_json_default), "params": json.dumps(params, default=_json_default),
                                 "demo": is_demo}).scalar_one()


def _json_default(o: Any) -> Any:
    if isinstance(o, (np.floating, np.integer)):
        return o.item()
    if isinstance(o, (datetime, date)):
        return o.isoformat()
    if isinstance(o, float) and o != o:
        return None
    raise TypeError(type(o))


def is_demo(conn: Connection, org_id: str) -> bool:
    return bool(conn.execute(text("select kind = 'demo' from ops_datasets where organization_id = cast(:org as uuid)"),
                             {"org": org_id}).scalar())
