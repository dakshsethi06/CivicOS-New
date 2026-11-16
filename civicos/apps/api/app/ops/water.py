"""Water models.

A. Anomaly detection: Isolation Forest over each meter's flow, pressure and consumption, the hour and weekday, and
   the meter's own baseline for that hour of the week. Readings are graded Normal, Suspicious or High anomaly, and
   consecutive flagged hours are grouped into events. An anomaly is a pattern worth inspecting, not proof of a leak.
B. Demand forecasting: XGBoost, per ward, for the next 24 hours (hourly) and the next 7 and 30 days (daily), each
   scored on held-out recent data with MAE and RMSE against simple baselines (same hour yesterday or last week; last
   week repeated; the four-week average).
C. Pipe failure risk: XGBoost classifier on age, material, diameter, length, past failures, pressure variability and
   recent flow anomalies, scored by cross-validated AUC and Brier score against an age-only baseline. Each score comes
   with the factors that raised or lowered it (XGBoost's per-feature contributions).
D. Shortage risk: each service reservoir's level projected seven days ahead from recent inflow and forecast demand.
"""
from __future__ import annotations

import warnings
from dataclasses import dataclass, field
from datetime import datetime, timedelta

import numpy as np
import xgboost as xgb

from .demo import Pipeline, Reservoir, Sensor
from .iforest import IsolationForest

SUSPICIOUS_Q = 0.99          # the top 1% of scores are Suspicious
HIGH_Q = 0.996               # the top 0.4% are High anomaly


def _xgb_reg(seed: int = 0) -> xgb.XGBRegressor:
    return xgb.XGBRegressor(n_estimators=300, max_depth=5, learning_rate=0.05, subsample=0.9, colsample_bytree=0.9,
                            tree_method="hist", random_state=seed, n_jobs=2)


def mae(y: np.ndarray, p: np.ndarray) -> float:
    return float(np.mean(np.abs(np.asarray(y) - np.asarray(p))))


def rmse(y: np.ndarray, p: np.ndarray) -> float:
    return float(np.sqrt(np.mean((np.asarray(y) - np.asarray(p)) ** 2)))


# --------------------------------------------------------------------------------------------------- A. anomalies


@dataclass
class AnomalyEvent:
    sensor_key: str
    start: int                     # hour index
    end: int                       # exclusive
    level: str                     # suspicious, high
    peak_score: float
    pattern: str                   # what the readings look like, in words
    evidence: dict


@dataclass
class AnomalyResult:
    scores: np.ndarray             # [sensor, hour]
    levels: np.ndarray             # 0 normal, 1 suspicious, 2 high
    thresholds: dict
    events: list[AnomalyEvent]
    metrics: dict
    features: list[str]


ANOMALY_FEATURES = ["consumption vs baseline (log ratio)", "6-hour mean of that ratio", "pressure vs baseline (bar)",
                    "flow (share of meter mean)", "pressure (share of meter mean)", "hour (sin)", "hour (cos)", "weekday"]


def _hour_of_week_median(x: np.ndarray, how: np.ndarray) -> np.ndarray:
    """The meter's usual value for this hour of the week: the median of the same hour over the previous four weeks
    (a trailing baseline, so it follows seasons and growth). The first week, which has no history, uses the median
    over the whole series for that hour of the week."""
    n = x.shape[1]
    lagged = np.full((4,) + x.shape, np.nan)
    for k in range(1, 5):
        lagged[k - 1, :, k * 168:] = x[:, : n - k * 168] if n > k * 168 else np.nan
    with np.errstate(all="ignore"), warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)        # the first week has no history: filled below
        out = np.nanmedian(lagged, axis=0)
    fallback = np.empty_like(x)
    for k in range(168):
        m = how == k
        if m.any():
            fallback[:, m] = np.median(x[:, m], axis=1, keepdims=True)
    return np.where(np.isnan(out), fallback, out)


def anomaly_features(hours: list[datetime], flow: np.ndarray, pressure: np.ndarray, consumption: np.ndarray) -> np.ndarray:
    """Feature tensor [sensor, hour, feature]."""
    hod = np.array([h.hour for h in hours])
    dow = np.array([h.weekday() for h in hours])
    how = dow * 24 + hod
    base_c = _hour_of_week_median(consumption, how)
    base_p = _hour_of_week_median(pressure, how)
    ratio = np.log((consumption + 1e-3) / (base_c + 1e-3))
    kernel = np.ones(6) / 6
    roll = np.array([np.convolve(r, kernel, mode="full")[: len(r)] for r in ratio])
    n_s, n_h = flow.shape
    f = np.stack([
        ratio, roll, pressure - base_p,
        flow / (flow.mean(axis=1, keepdims=True) + 1e-6),
        pressure / (pressure.mean(axis=1, keepdims=True) + 1e-6),
        np.broadcast_to(np.sin(2 * np.pi * hod / 24), (n_s, n_h)),
        np.broadcast_to(np.cos(2 * np.pi * hod / 24), (n_s, n_h)),
        np.broadcast_to(dow / 6.0, (n_s, n_h)),
    ], axis=-1)
    return f


def _describe(ev_feats: np.ndarray, hours_in_event: np.ndarray, hod: np.ndarray) -> tuple[str, dict]:
    ratio = float(np.mean(ev_feats[:, 0]))
    dp = float(np.mean(ev_feats[:, 2]))
    night = (hod[hours_in_event] < 5) | (hod[hours_in_event] >= 23)
    night_ratio = float(np.mean(ev_feats[night, 0])) if night.any() else None
    dur = len(hours_in_event)
    excess = float(np.expm1(ratio) * 100)
    evidence = {"hours": dur, "consumption_vs_baseline_pct": round(excess, 1), "pressure_change_bar": round(dp, 2),
                "night_consumption_vs_baseline_pct": round(float(np.expm1(night_ratio) * 100), 1) if night_ratio is not None else None}
    if ratio < -1.5:
        return "Flow near zero while pressure is normal: consistent with a meter or telemetry fault.", evidence
    if excess > 60 and dp < -0.6 and dur <= 12:
        return "Sharp short rise in flow with a pressure drop: consistent with a burst. Inspect to confirm.", evidence
    if excess > 15 and dp < -0.2:
        return "Sustained extra flow, including at night, with lower pressure: consistent with a leak. Inspect to confirm.", evidence
    if excess > 15:
        return "Consumption well above this meter's usual level for these hours.", evidence
    if dp < -0.3:
        return "Pressure below this meter's usual level for these hours.", evidence
    return "Unusual combination of flow and pressure for this time of week.", evidence


def detect_anomalies(hours: list[datetime], sensors: list[Sensor], flow: np.ndarray, pressure: np.ndarray,
                     consumption: np.ndarray, truth: list[dict] | None = None, seed: int = 0) -> AnomalyResult:
    F = anomaly_features(hours, flow, pressure, consumption)
    n_s, n_h, n_f = F.shape
    X = F.reshape(-1, n_f)
    model = IsolationForest(n_estimators=150, max_samples=256, random_state=seed).fit(X)
    scores = model.score(X).reshape(n_s, n_h)
    t_s, t_h, t_x = np.quantile(scores, SUSPICIOUS_Q), np.quantile(scores, HIGH_Q), np.quantile(scores, 0.9995)
    levels = np.where(scores >= t_h, 2, np.where(scores >= t_s, 1, 0))
    hod = np.array([h.hour for h in hours])

    events: list[AnomalyEvent] = []
    for s in range(n_s):
        flagged = np.where(levels[s] > 0)[0]
        if not len(flagged):
            continue
        groups, cur = [], [flagged[0]]
        for h in flagged[1:]:
            if h - cur[-1] <= 3:                     # gaps of up to two normal hours join one event
                cur.append(h)
            else:
                groups.append(cur)
                cur = [h]
        groups.append(cur)
        for g in groups:
            span = np.arange(g[0], g[-1] + 1)
            # alarm persistence: one or two flagged hours alone are usually noise, unless the score is extreme
            if len(g) < 3 and scores[s, span].max() < t_x:
                continue
            pattern, evidence = _describe(F[s, span], span, hod)
            events.append(AnomalyEvent(sensors[s].key, int(g[0]), int(g[-1]) + 1,
                                       "high" if (levels[s, span] == 2).any() else "suspicious",
                                       round(float(scores[s, span].max()), 4), pattern, evidence))

    metrics: dict = {"flagged_share": round(float((levels > 0).mean()), 4),
                     "threshold_suspicious": round(float(t_s), 4), "threshold_high": round(float(t_h), 4),
                     "events": len(events)}
    if truth:
        key_idx = {s.key: i for i, s in enumerate(sensors)}
        true_mask = np.zeros((n_s, n_h), dtype=bool)
        for t in truth:
            true_mask[key_idx[t["sensor_key"]], t["start"]:t["end"]] = True
        flagged = levels > 0
        tp = int((flagged & true_mask).sum())
        detected = sum(1 for t in truth if flagged[key_idx[t["sensor_key"]], t["start"]:t["end"]].any())
        ev_hits = sum(1 for e in events if true_mask[key_idx[e.sensor_key], e.start:e.end].any())
        metrics.update({
            "hour_precision": round(tp / max(1, int(flagged.sum())), 3),
            "hour_recall": round(tp / max(1, int(true_mask.sum())), 3),
            "faults_detected": f"{detected} of {len(truth)}",
            "event_precision": round(ev_hits / max(1, len(events)), 3),
            "scored_against": "faults injected into the demonstration data",
        })
    return AnomalyResult(scores, levels, {"suspicious": float(t_s), "high": float(t_h)}, events, metrics,
                         ANOMALY_FEATURES)


# --------------------------------------------------------------------------------------------------- B. forecasts


@dataclass
class ZoneForecast:
    zone_id: str
    hourly: list[tuple[datetime, float, float, float]]       # next 24 hours: time, value, lower, upper (m3)
    daily: list[tuple[datetime, float, float, float]]        # next 30 days (m3 per day)


@dataclass
class ForecastResult:
    zones: list[ZoneForecast]
    metrics: dict
    history_daily: dict[str, list[tuple[datetime, float]]] = field(default_factory=dict)


def _zone_series(sensors: list[Sensor], consumption: np.ndarray) -> tuple[list[str], np.ndarray]:
    zones = sorted({s.zone_id for s in sensors})
    zs = np.array([consumption[[i for i, s in enumerate(sensors) if s.zone_id == z]].sum(axis=0) for z in zones])
    return zones, zs


def _hourly_design(y: np.ndarray, hod: np.ndarray, dow: np.ndarray, idx: np.ndarray) -> np.ndarray:
    """Features for target hours `idx` using only data at least 24 hours older: a direct 24-hour-ahead model."""
    day_mean = np.array([y[max(0, i - 48):i - 24].mean() if i >= 48 else y[:max(1, i - 24)].mean() for i in idx])
    return np.column_stack([hod[idx], dow[idx], y[idx - 24], y[idx - 48], y[idx - 168], day_mean])


def _daily_design(d: np.ndarray, dows: np.ndarray, i: int) -> list[float]:
    return [dows[i], d[i - 1], d[i - 7], d[i - 14], d[i - 7:i].mean(), d[i - 28:i].mean()]


def _recursive_daily(model: xgb.XGBRegressor, hist: np.ndarray, dows: np.ndarray, steps: int) -> np.ndarray:
    d = list(hist)
    out = []
    for k in range(steps):
        i = len(d)
        x = _daily_design(np.array(d), dows, i)
        p = float(model.predict(np.array([x]))[0])
        d.append(p)
        out.append(p)
    return np.array(out)


def forecast_demand(hours: list[datetime], sensors: list[Sensor], consumption: np.ndarray, seed: int = 0) -> ForecastResult:
    zones, Z = _zone_series(sensors, consumption)
    scale = Z.mean(axis=1, keepdims=True)
    Y = Z / scale                                            # each ward on its own scale, so one model serves all
    n_h = Y.shape[1]
    hod = np.array([h.hour for h in hours])
    dow = np.array([h.weekday() for h in hours])
    last = hours[-1]

    # ---- hourly, next 24 hours. Backtest: the last 7 days, one day at a time from each midnight-ish origin
    test_h = 24 * 7
    tr_idx = np.arange(24 * 9, n_h - test_h)
    te_idx = np.arange(n_h - test_h, n_h)
    Xtr = np.vstack([_hourly_design(Y[z], hod, dow, tr_idx) for z in range(len(zones))])
    ytr = np.concatenate([Y[z, tr_idx] for z in range(len(zones))])
    m_h = _xgb_reg(seed).fit(Xtr, ytr)
    pred, y_true, naive_d, naive_w = [], [], [], []
    for z in range(len(zones)):
        p = m_h.predict(_hourly_design(Y[z], hod, dow, te_idx)) * scale[z, 0]
        pred.append(p)
        y_true.append(Z[z, te_idx])
        naive_d.append(Z[z, te_idx - 24])
        naive_w.append(Z[z, te_idx - 168])
    pred, y_true, naive_d, naive_w = map(np.concatenate, (pred, y_true, naive_d, naive_w))
    rel_err_h = np.abs(pred - y_true) / np.maximum(y_true, 1e-6)
    q_h = float(np.quantile(rel_err_h, 0.9))

    hourly_metrics = {"unit": "m3 per hour, per ward", "test": "last 7 days, each day forecast from the day before",
                      "xgboost": {"mae": round(mae(y_true, pred), 2), "rmse": round(rmse(y_true, pred), 2)},
                      "same_hour_yesterday": {"mae": round(mae(y_true, naive_d), 2), "rmse": round(rmse(y_true, naive_d), 2)},
                      "same_hour_last_week": {"mae": round(mae(y_true, naive_w), 2), "rmse": round(rmse(y_true, naive_w), 2)},
                      "interval": "90% of test errors fell within this band"}

    # refit on everything, then forecast the next 24 hours (lags reach back into observed data only)
    all_idx = np.arange(24 * 9, n_h)
    m_h = _xgb_reg(seed).fit(np.vstack([_hourly_design(Y[z], hod, dow, all_idx) for z in range(len(zones))]),
                             np.concatenate([Y[z, all_idx] for z in range(len(zones))]))
    fut_hours = [last + timedelta(hours=k + 1) for k in range(24)]

    # ---- daily, next 7 and 30 days, recursive. Backtest: forecast the last 30 days from the day before them
    n_d = n_h // 24
    D = Z[:, n_h - n_d * 24:].reshape(len(zones), n_d, 24).sum(axis=2)
    day0 = hours[n_h - n_d * 24]
    day_starts = [day0 + timedelta(days=i) for i in range(n_d)]
    dows_hist = np.array([d.weekday() for d in day_starts])
    dscale = D.mean(axis=1, keepdims=True)
    Dn = D / dscale
    horizon = 30
    cut = n_d - horizon

    def fit_daily(upto: int) -> xgb.XGBRegressor:
        Xs, ys = [], []
        for z in range(len(zones)):
            for i in range(28, upto):
                Xs.append(_daily_design(Dn[z], dows_hist, i))
                ys.append(Dn[z, i])
        return _xgb_reg(seed).fit(np.array(Xs), np.array(ys))

    m_d = fit_daily(cut)
    dows_ext = np.array([(day_starts[0] + timedelta(days=i)).weekday() for i in range(n_d + horizon + 1)])
    bt, actual, nv_week, nv_mean = [], [], [], []
    for z in range(len(zones)):
        bt.append(_recursive_daily(m_d, Dn[z, :cut], dows_ext, horizon) * dscale[z, 0])
        actual.append(D[z, cut:])
        nv_week.append(np.tile(D[z, cut - 7:cut], 5)[:horizon])
        nv_mean.append(np.full(horizon, D[z, cut - 28:cut].mean()))
    bt, actual, nv_week, nv_mean = map(np.array, (bt, actual, nv_week, nv_mean))

    def block(n: int) -> dict:
        return {"xgboost": {"mae": round(mae(actual[:, :n], bt[:, :n]), 1), "rmse": round(rmse(actual[:, :n], bt[:, :n]), 1)},
                "last_week_repeated": {"mae": round(mae(actual[:, :n], nv_week[:, :n]), 1), "rmse": round(rmse(actual[:, :n], nv_week[:, :n]), 1)},
                "four_week_average": {"mae": round(mae(actual[:, :n], nv_mean[:, :n]), 1), "rmse": round(rmse(actual[:, :n], nv_mean[:, :n]), 1)}}

    rel_d = np.abs(bt - actual) / np.maximum(actual, 1e-6)
    q_d = np.quantile(rel_d, 0.9, axis=0)                     # error band widens with the horizon
    q_d = np.maximum.accumulate(q_d)

    m_d = fit_daily(n_d)
    out: list[ZoneForecast] = []
    history: dict[str, list[tuple[datetime, float]]] = {}
    for z, zid in enumerate(zones):
        ph = m_h.predict(_hourly_design(np.concatenate([Y[z], np.zeros(24)]), np.concatenate([hod, [h.hour for h in fut_hours]]),
                                        np.concatenate([dow, [h.weekday() for h in fut_hours]]), np.arange(n_h, n_h + 24)))
        ph = ph * scale[z, 0]
        pd_ = _recursive_daily(m_d, Dn[z], dows_ext, horizon) * dscale[z, 0]
        next_day = day_starts[-1] + timedelta(days=1)
        out.append(ZoneForecast(
            zid,
            [(t, round(float(v), 2), round(float(v * (1 - q_h)), 2), round(float(v * (1 + q_h)), 2)) for t, v in zip(fut_hours, ph)],
            [(next_day + timedelta(days=k), round(float(v), 1), round(float(v * (1 - q_d[k])), 1), round(float(v * (1 + q_d[k])), 1))
             for k, v in enumerate(pd_)],
        ))
        history[zid] = [(day_starts[i], round(float(D[z, i]), 1)) for i in range(n_d)]

    metrics = {"next_24_hours": hourly_metrics,
               "next_7_days": {"unit": "m3 per day, per ward", "test": "the 7 days after a cut-off 30 days back", **block(7)},
               "next_30_days": {"unit": "m3 per day, per ward", "test": "the last 30 days, forecast from the day before them", **block(30)},
               "features_hourly": ["hour", "weekday", "same hour 1, 2 and 7 days earlier", "mean of the previous day"],
               "features_daily": ["weekday", "previous day", "same weekday 1 and 2 weeks earlier", "7- and 28-day means"]}
    return ForecastResult(out, metrics, history)


# ----------------------------------------------------------------------------------------------- C. pipe risk

MATERIAL_ORDER = ["Cast iron", "Mild steel", "PVC", "Ductile iron", "HDPE"]
RISK_FEATURES = ["age (years)", "diameter (mm)", "length (m)", "failures in the previous 5 years",
                 "pressure variability in the ward", "flow-anomaly hours on the pipe, last 30 days"] + \
                [f"material: {m}" for m in MATERIAL_ORDER]


@dataclass
class PipeRisk:
    pipeline_key: str
    probability: float                     # of at least one failure in the next 12 months
    level: str                             # low, medium, high
    factors: list[dict]                    # top contributions, signed


@dataclass
class RiskResult:
    pipes: list[PipeRisk]
    metrics: dict


def _pipe_matrix(pipes: list[Pipeline], year: int, pressure_cv: dict[str, float], anomaly_hours: dict[str, int],
                 shift: int) -> np.ndarray:
    """shift=1: features as of a year ago (for training on last year's outcome); shift=0: as of now."""
    rows = []
    for p in pipes:
        fails = p.failures_by_year[:-1] if shift else p.failures_by_year[1:]
        rows.append([year - shift - p.installed_year, p.diameter_mm, p.length_m, sum(fails),
                     pressure_cv.get(p.zone_id, 0.0), anomaly_hours.get(p.key, 0) if not shift else 0] +
                    [1.0 if p.material == m else 0.0 for m in MATERIAL_ORDER])
    return np.array(rows, dtype=float)


def _auc(y: np.ndarray, p: np.ndarray) -> float:
    pos, neg = p[y == 1], p[y == 0]
    if not len(pos) or not len(neg):
        return float("nan")
    ranks = np.argsort(np.argsort(np.concatenate([pos, neg]))) + 1
    return float((ranks[: len(pos)].sum() - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)))


def pipe_risk(pipes: list[Pipeline], year: int, pressure_cv: dict[str, float], anomaly_hours: dict[str, int],
              seed: int = 0) -> RiskResult:
    X = _pipe_matrix(pipes, year, pressure_cv, anomaly_hours, shift=1)
    y = np.array([1 if p.failed_last_year else 0 for p in pipes])

    def clf() -> xgb.XGBClassifier:
        # shallow and strongly regularised: a few hundred pipes is a small training set
        return xgb.XGBClassifier(n_estimators=150, max_depth=2, learning_rate=0.05, subsample=0.8, min_child_weight=5,
                                 reg_lambda=5.0, tree_method="hist", random_state=seed, n_jobs=2, eval_metric="logloss")

    # 5-fold cross-validation (stratified by hand), out-of-fold probabilities
    rng = np.random.default_rng(seed)
    folds = np.zeros(len(y), dtype=int)
    for cls in (0, 1):
        idx = rng.permutation(np.where(y == cls)[0])
        folds[idx] = np.arange(len(idx)) % 5
    oof = np.zeros(len(y))
    oof_base = np.zeros(len(y))
    for k in range(5):
        tr, te = folds != k, folds == k
        if len(set(y[tr])) < 2:
            continue
        oof[te] = clf().fit(X[tr], y[tr]).predict_proba(X[te])[:, 1]
        # baseline: failure rate by age band in the training folds
        bands = np.digitize(X[:, 0], [20, 40, 60, 80])
        rate = {b: y[tr][bands[tr] == b].mean() if (bands[tr] == b).any() else y[tr].mean() for b in range(5)}
        oof_base[te] = [rate[b] for b in bands[te]]

    bins = np.clip((oof * 5).astype(int), 0, 4)
    calibration = [{"predicted": round(float(oof[bins == b].mean()), 3), "observed": round(float(y[bins == b].mean()), 3),
                    "pipes": int((bins == b).sum())} for b in range(5) if (bins == b).any()]
    metrics = {"pipes": len(pipes), "failed_last_year": int(y.sum()),
               "xgboost": {"auc": round(_auc(y, oof), 3), "brier": round(float(np.mean((oof - y) ** 2)), 4)},
               "age_band_baseline": {"auc": round(_auc(y, oof_base), 3), "brier": round(float(np.mean((oof_base - y) ** 2)), 4)},
               "validation": "5-fold cross-validation: trained on features as of a year ago, scored on last year's failures",
               "calibration": calibration, "features": RISK_FEATURES}

    model = clf().fit(X, y)
    Xn = _pipe_matrix(pipes, year, pressure_cv, anomaly_hours, shift=0)
    prob = model.predict_proba(Xn)[:, 1]
    contrib = model.get_booster().predict(xgb.DMatrix(Xn), pred_contribs=True)[:, :-1]
    out = []
    for i, p in enumerate(pipes):
        order = np.argsort(-np.abs(contrib[i]))[:4]
        factors = [{"factor": RISK_FEATURES[j], "value": round(float(Xn[i, j]), 3),
                    "effect": "raises risk" if contrib[i, j] > 0 else "lowers risk", "weight": round(float(contrib[i, j]), 3)}
                   for j in order if abs(contrib[i, j]) > 1e-3]
        level = "high" if prob[i] >= 0.5 else "medium" if prob[i] >= 0.25 else "low"
        out.append(PipeRisk(p.key, round(float(prob[i]), 4), level, factors))
    return RiskResult(out, metrics)


# ----------------------------------------------------------------------------------------------- D. shortage


@dataclass
class ShortageRisk:
    reservoir_key: str
    current_pct: float
    projected_pct: list[float]             # end of each of the next 7 days
    min_pct: float
    days_to_20pct: int | None
    risk: str


def shortage_risk(reservoirs: list[Reservoir], forecasts: dict[str, list[float]]) -> list[ShortageRisk]:
    """forecasts: zone_id -> forecast demand, m3 per day, next 7 days."""
    out = []
    for r in reservoirs:
        demand = np.array(forecasts.get(r.zone_id, [0] * 7)[:7]) / 1000          # megalitres
        inflow = float(r.inflow_ml[-24 * 7:].sum() / 7)
        vol = r.level_pct[-1] / 100 * r.capacity_ml
        proj = []
        for d in demand:
            vol = min(r.capacity_ml, max(0.0, vol + inflow - d))
            proj.append(round(vol / r.capacity_ml * 100, 1))
        below = next((k + 1 for k, v in enumerate(proj) if v < 20), None)
        mn = min(proj)
        risk = "high" if mn < 20 else "medium" if mn < 35 else "low"
        out.append(ShortageRisk(r.key, round(float(r.level_pct[-1]), 1), proj, mn, below, risk))
    return out
