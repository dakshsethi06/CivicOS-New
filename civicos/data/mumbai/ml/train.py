"""Train CivicOS's Mumbai models on the published ward figures (../praja_tables.json).

1. Ward groups: k-means on standardised ward indicators; k chosen by silhouette score.
2. Complaint forecasts for 2026, 2027 and 2028: three simple methods compared by a rolling
   backtest at every horizon (forecast each of 2022-2025 from the years up to 1, 2 and 3 years
   before it). The method with the lowest average error across a family of series and across
   horizons is used for every series in that family. Each year's 80% interval comes from that
   method's own backtest errors at that horizon.
3. Waste forecasts for 2026-2028: waste lifted (tonnes/day) per ward and city, 2021-2025, same
   three methods, backtest on 2024 and 2025.
4. Air-quality forecast for each month of 2026-2028: monthly AQI 2016-2025, four seasonal methods
   compared by forecasting each whole year 2022-2025 from the years up to 1, 2 and 3 years before.
5. Water forecasts for 2025-2028 (the latest published water year is 2024): drinking-water samples
   unfit per ward and city, and water drawn and supplied city-wide, 2020-2024.

Where a horizon cannot be tested on at least two past years (short series), its interval is the
widest tested one scaled by sqrt(horizon / tested horizon), and the model records that it did so.

Usage: python3 train.py ../praja_tables.json results.json [--keep-clusters]
--keep-clusters reuses the ward groups already in results.json instead of re-running k-means
(for machines where scikit-learn cannot run; the forecasts need only numpy).
Everything is deterministic (fixed seeds), so re-running gives the same output.
"""
import json, math, sys
from datetime import date
import numpy as np

KEEP_CLUSTERS = "--keep-clusters" in sys.argv
if not KEEP_CLUSTERS:
    from sklearn.cluster import KMeans
    from sklearn.metrics import silhouette_score
    from sklearn.preprocessing import StandardScaler

data = json.load(open(sys.argv[1]))
WARDS = data["wards"]
R = data["records"]
FORECAST_YEARS = [2026, 2027, 2028]

def val(zone, year, metric, category=None):
    for r in R:
        if r["zone"] == zone and r["year"] == year and r["metric"] == metric and r["category"] == category and r["month"] is None:
            return r["value"]
    return None

# ---------------------------------------------------------------------------
# 1. Ward groups
# ---------------------------------------------------------------------------
FEATURES = [  # (key, label, higher is better?)
    ("complaints_per_10k", "Complaints per 10,000 residents (2025)", False),
    ("closed_pct", "Complaints closed, % (2025)", True),
    ("avg_days", "Average days to close (2025)", False),
    ("water_hours", "Water supply, hours per day (2024)", True),
    ("water_unfit_pct", "Drinking-water samples unfit, % (2024)", False),
    ("waste_per_capita", "Waste per person, kg per day (2025)", None),
    ("slum_pct", "Slum population, % (2011)", None),
]

def train_clusters():
    rows = []
    for w in WARDS:
        pop = val(w, 2025, "population")
        reg = val(w, 2025, "complaints_registered")
        closed = val(w, 2025, "complaints_closed")
        rows.append({
            "ward": w,
            "complaints_per_10k": round(10000 * reg / pop, 2),
            "closed_pct": round(100 * closed / reg, 2),
            "avg_days": val(w, 2025, "avg_days_to_close"),
            "water_hours": val(w, 2024, "water_supply_hours"),
            "water_unfit_pct": val(w, 2024, "water_unfit_samples_pct"),
            "waste_per_capita": val(w, 2025, "waste_per_capita"),
            "slum_pct": val(w, 2011, "slum_population_pct"),
        })
    keys = [f[0] for f in FEATURES]
    missing = [(r["ward"], k) for r in rows for k in keys if r[k] is None]
    assert not missing, missing      # every ward has every feature, so no imputation is needed
    X_raw = np.array([[r[k] for k in keys] for r in rows], dtype=float)
    # Water supply hours is very skewed (T = 24 h, most wards 2-6 h); log keeps one ward from dominating.
    X_t = X_raw.copy()
    X_t[:, keys.index("water_hours")] = np.log(X_t[:, keys.index("water_hours")])
    X = StandardScaler().fit_transform(X_t)

    scores = {}
    for k in range(2, 6):
        km = KMeans(n_clusters=k, n_init=50, random_state=42).fit(X)
        sizes = np.bincount(km.labels_)
        scores[k] = {"silhouette": round(float(silhouette_score(X, km.labels_)), 3), "smallest_group": int(sizes.min())}
    # best silhouette among solutions where every group has at least 3 wards
    eligible = {k: s for k, s in scores.items() if s["smallest_group"] >= 3}
    k_best = max(eligible, key=lambda k: eligible[k]["silhouette"])
    km = KMeans(n_clusters=k_best, n_init=50, random_state=42).fit(X)

    # z-scores on the untransformed features, for describing groups in plain units
    Z = StandardScaler().fit_transform(X_raw)
    groups = []
    for g in range(k_best):
        idx = np.where(km.labels_ == g)[0]
        groups.append({"cluster": g, "wards": [rows[i]["ward"] for i in idx],
                       "mean": {k: round(float(v), 2) for k, v in zip(keys, X_raw[idx].mean(axis=0))},
                       "z": {k: round(float(v), 2) for k, v in zip(keys, Z[idx].mean(axis=0))}})

    def describe(gr):
        """Label a group by its two most distinctive features (largest |z|), in plain words."""
        words = {
            "complaints_per_10k": ("many complaints", "few complaints"),
            "closed_pct": ("high closure", "low closure"),
            "avg_days": ("slow resolution", "fast resolution"),
            "water_hours": ("long water supply", "short water supply"),
            "water_unfit_pct": ("more unfit water", "cleaner water"),
            "waste_per_capita": ("high waste per person", "low waste per person"),
            "slum_pct": ("high slum share", "low slum share"),
        }
        top = sorted(keys, key=lambda k: -abs(gr["z"][k]))[:2]
        return ", ".join(words[k][0 if gr["z"][k] > 0 else 1] for k in top).capitalize()

    for gr in groups: gr["label"] = describe(gr)
    # number groups by size, largest first, so the ids are stable and readable
    groups.sort(key=lambda g: (-len(g["wards"]), g["wards"][0]))
    remap = {g["cluster"]: i + 1 for i, g in enumerate(groups)}
    for g in groups: g["cluster"] = remap[g["cluster"]]
    assignments = []
    for i, r in enumerate(rows):
        assignments.append({"ward": r["ward"], "cluster": remap[int(km.labels_[i])],
                            "features": {k: r[k] for k in keys},
                            "z": {k: round(float(v), 2) for k, v in zip(keys, Z[i])}})

    model = {
        "id": "ward-groups-2025",
        "name": "Ward groups",
        "kind": "clustering",
        "method": "k-means (scikit-learn), features standardised; water hours log-transformed",
        "description": "Groups wards that look alike across complaints, resolution, water and waste. Unsupervised: there are no right answers to train against, so it describes patterns rather than predicting anything.",
        "params": {"k": k_best, "features": [{"key": k, "label": l, "higher_is_better": h} for k, l, h in FEATURES],
                   "n_init": 50, "random_state": 42, "groups": groups},
        "metrics": {"silhouette": scores[k_best]["silhouette"], "candidates": scores},
        "trained_on": "24 wards; Praja Foundation 2026 report Tables 3, 11, 43; 2025 report Tables 4, 7",
    }
    return model, assignments

if KEEP_CLUSTERS:
    prev = json.load(open(sys.argv[2]))
    cluster_model = next({k: v for k, v in m.items() if k != "trained_at"} for m in prev["models"] if m["kind"] == "clustering")
    assignments = prev["clusters"]
else:
    cluster_model, assignments = train_clusters()

# ---------------------------------------------------------------------------
# Shared forecasting machinery
# ---------------------------------------------------------------------------
def f_naive(hist, h): return float(hist[-1])
def f_mean3(hist, h): return float(np.mean(hist[-3:]))
def f_trend(hist, h):
    x = np.arange(len(hist)); b, a = np.polyfit(x, hist, 1)
    return max(0.0, float(a + b * (len(hist) - 1 + h)))
METHODS = {"naive": ("Last year's value", f_naive),
           "mean3": ("Average of the last three years", f_mean3),
           "trend": ("Straight-line trend over all earlier years", f_trend)}

def backtest(ser, years, test_years, methods, horizons, error="relative", min_hist=3):
    """Forecast every test year from the years up to h years before it, for each horizon h.

    ser maps a series key to its values, aligned with `years`. For each horizon that could be tested
    on at least two past years, the method with the lowest error at that distance is chosen (a trend
    can win one year ahead and drift badly three years ahead); a horizon that could not be tested
    uses the method of the furthest tested one. Returns the method and 80% interval per horizon and
    the error table. error="relative" scores by % of the real figure (MAPE) and gives relative
    intervals; "absolute" scores in the figure's own units (for percentages near zero, where a
    relative error is meaningless)."""
    per_h = {}
    for h in horizons:
        rel = {m: [] for m in methods}; ab = {m: [] for m in methods}; tested = set()
        for ys in ser.values():
            for t in test_years:
                i = years.index(t); n = i - h + 1               # history = the years up to t - h
                if n < min_hist: continue
                tested.add(t)
                for m, (_, fn) in methods.items():
                    p = fn(ys[:n], h)
                    ab[m].append(abs(p - ys[i]))
                    if ys[i] > 0: rel[m].append(abs(p - ys[i]) / ys[i])
        per_h[h] = {"rel": rel, "abs": ab, "years": sorted(tested)}
    tested_h = [h for h in horizons if len(per_h[h]["years"]) >= 2]
    assert tested_h and tested_h[0] == 1, "horizon 1 must be testable"
    key = "rel" if error == "relative" else "abs"
    score = {h: {m: float(np.mean(per_h[h][key][m])) for m in methods} for h in tested_h}
    chosen, intervals, basis = {}, {}, {}
    for h in horizons:
        if h in tested_h:
            chosen[h] = min(score[h], key=score[h].get)
            q = float(np.quantile(per_h[h][key][chosen[h]], 0.8)); basis[h] = "backtest"
        else:
            ref = max(tested_h); chosen[h] = chosen[ref]
            q = intervals[ref] * math.sqrt(h / ref); basis[h] = f"scaled from {ref}-year test"
        if h > 1: q = max(q, intervals[h - 1])                # a later year is never more certain
        intervals[h] = q

    out = {
        "series": len(ser), "backtest_years": per_h[1]["years"], "chosen": chosen[1], "error": error,
        "chosen_by_horizon": {str(h): chosen[h] for h in horizons},
        "horizons_tested": tested_h,
        "test_years_by_horizon": {str(h): per_h[h]["years"] for h in horizons},
        "mae": {m: round(float(np.mean(per_h[1]["abs"][m])), 3) for m in methods},
        "interval_basis_by_horizon": {str(h): basis[h] for h in horizons},
        "baseline": "naive",
    }
    if error == "relative":
        out["mape_pct"] = {m: round(100 * v, 1) for m, v in score[1].items()}            # one year ahead
        out["mape_pct_by_horizon"] = {str(h): {m: round(100 * v, 1) for m, v in score[h].items()} for h in tested_h}
        out["interval_pct"] = round(100 * intervals[1], 1)
        out["interval_pct_by_horizon"] = {str(h): round(100 * q, 1) for h, q in intervals.items()}
        n1 = score[1]["naive"]
        out["improvement_vs_naive_pct"] = round(100 * (n1 - score[1][chosen[1]]) / n1, 1) if n1 else None
    else:
        out["mae_by_horizon"] = {str(h): {m: round(v, 3) for m, v in score[h].items()} for h in tested_h}
        out["interval_abs"] = round(intervals[1], 3)
        out["interval_abs_by_horizon"] = {str(h): round(q, 3) for h, q in intervals.items()}
    return out, intervals, chosen

def emit(model, metric, fam, zone, category, ys, last_year, years_out, chosen, intervals, error, decimals=0):
    """One forecast row per target year, each made by the method and with the interval for its horizon."""
    rnd = (lambda v: round(v)) if decimals == 0 else (lambda v: round(v, decimals))
    for y in years_out:
        h = y - last_year; p = METHODS[chosen[h]][1](ys, h); q = intervals[h]
        lo, hi = (p * (1 - q), p * (1 + q)) if error == "relative" else (p - q, p + q)
        forecasts.append({"model": model, "metric": metric, "month": None, "zone": zone, "category": category,
                          "year": y, "value": rnd(p), "lower": max(0, rnd(lo)), "upper": rnd(hi),
                          "method": chosen[h], "family": fam})

forecasts = []

# ---------------------------------------------------------------------------
# 2. Complaint forecasts, 2016-2025 -> 2026, 2027, 2028
# ---------------------------------------------------------------------------
YEARS = list(range(2016, 2026))
BACKTEST = [2022, 2023, 2024, 2025]
HORIZONS = [y - YEARS[-1] for y in FORECAST_YEARS]

def series(zone, metric, category, years):
    ys = [val(zone, y, metric, category) for y in years]
    return ys if all(v is not None for v in ys) else None

families = {
    "ward_total": [(w, None) for w in WARDS],
    "ward_swm": [(w, "Solid Waste Management (SWM)") for w in WARDS],
    "ward_drainage": [(w, "Drainage") for w in WARDS],
    "city_issue": [(None, c) for c in sorted({r["category"] for r in R if r["metric"] == "complaints_registered" and r["zone"] is None and r["category"]})],
    "city_total": [(None, None)],
}
FAMILY_LABEL = {"ward_total": "All complaints, by ward", "ward_swm": "Solid waste complaints, by ward",
                "ward_drainage": "Drainage complaints, by ward", "city_issue": "City complaints, by issue",
                "city_total": "City complaints, all issues"}

family_metrics = {}
for fam, keys_ in families.items():
    ser = {k: series(k[0], "complaints_registered", k[1], YEARS) for k in keys_}
    ser = {k: v for k, v in ser.items() if v}
    m, iv, ch = backtest(ser, YEARS, BACKTEST, METHODS, HORIZONS)
    family_metrics[fam] = {"label": FAMILY_LABEL[fam], **m}
    for (z, c), ys in ser.items():
        emit("complaints-forecast-2026", "complaints_registered", fam, z, c, ys, YEARS[-1], FORECAST_YEARS, ch, iv, "relative")

forecast_model = {
    "id": "complaints-forecast-2026",
    "name": "Complaint forecasts",
    "kind": "forecast",
    "method": "Per family of series and per forecast year, the best of three simple methods by rolling backtest at that distance (1, 2 or 3 years ahead); each year's 80% interval from that method's backtest errors",
    "description": "Predicts how many complaints will be registered in 2026, 2027 and 2028, with a range that widens each year. Built on ten yearly figures per series, so the ranges are wide on purpose.",
    "params": {"methods": {m: l for m, (l, _) in METHODS.items()}, "backtest_years": BACKTEST, "forecast_years": FORECAST_YEARS,
               "families": family_metrics},
    "metrics": {fam: {"mape_pct": m["mape_pct"][m["chosen"]], "naive_mape_pct": m["mape_pct"]["naive"]} for fam, m in family_metrics.items()},
    "trained_on": "Complaints registered 2016-2025; Praja Foundation 2026 report Tables 1, 39, 41, 43",
}

# ---------------------------------------------------------------------------
# 3. Waste forecasts (tonnes lifted per day), 2021-2025 -> 2026, 2027, 2028
# ---------------------------------------------------------------------------
W_YEARS = list(range(2021, 2026))
W_BACKTEST = [2024, 2025]            # each needs at least three earlier years for the 3-year average
waste_families = {"ward_waste": [w for w in WARDS], "city_waste": [None]}
WASTE_LABEL = {"ward_waste": "Waste lifted, by ward", "city_waste": "Waste lifted, whole city"}
waste_metrics = {}
for fam, zones in waste_families.items():
    ser = {z: series(z, "waste_tonnes_per_day", None, W_YEARS) for z in zones}
    ser = {z: v for z, v in ser.items() if v}
    m, iv, ch = backtest(ser, W_YEARS, W_BACKTEST, METHODS, HORIZONS)
    if fam == "city_waste":
        # one series x two test years is only two errors, too few for a range on its own:
        # use the wider of its own and the ward family's interval, year by year
        ward_iv = waste_metrics["ward_waste"]["interval_pct_by_horizon"]
        iv = {h: max(q, ward_iv[str(h)] / 100) for h, q in iv.items()}
        m["interval_pct_by_horizon"] = {str(h): round(100 * q, 1) for h, q in iv.items()}
        m["interval_pct"] = m["interval_pct_by_horizon"]["1"]
    waste_metrics[fam] = {"label": WASTE_LABEL[fam], **m}
    for z, ys in ser.items():
        emit("waste-forecast-2026", "waste_tonnes_per_day", fam, z, None, ys, W_YEARS[-1], FORECAST_YEARS, ch, iv, "relative")

waste_model = {
    "id": "waste-forecast-2026",
    "name": "Waste forecasts",
    "kind": "forecast",
    "method": "Best of three simple methods by backtest on 2024 and 2025; 80% interval from that method's backtest errors, widened for 2027 and 2028",
    "description": "Predicts the tonnes of waste BMC will lift per day in 2026, 2027 and 2028, for the city and each ward. Only five years are published, so only one year ahead could be tested on two years; the 2027 and 2028 ranges are widened from that test.",
    "params": {"methods": {m: l for m, (l, _) in METHODS.items()}, "backtest_years": W_BACKTEST, "forecast_years": FORECAST_YEARS,
               "families": waste_metrics},
    "metrics": {fam: {"mape_pct": m["mape_pct"][m["chosen"]], "naive_mape_pct": m["mape_pct"]["naive"]} for fam, m in waste_metrics.items()},
    "trained_on": "Waste lifted per day 2021-2025; Praja Foundation 2026 report Table 37",
}

# ---------------------------------------------------------------------------
# 4. Monthly air quality (AQI), 2016-2025 -> each month of 2026, 2027, 2028
# ---------------------------------------------------------------------------
AQ_YEARS = list(range(2016, 2026))
aq = np.array([[next(r["value"] for r in R if r["metric"] == "aqi_monthly_avg" and r["year"] == y and r["month"] == m)
                for m in range(1, 13)] for y in AQ_YEARS], dtype=float)          # rows = years, columns = months
AQ_BACKTEST = [2022, 2023, 2024, 2025]

def a_snaive(h): return h[-1]                                  # same month last year
def a_smean3(h): return h[-3:].mean(axis=0)                    # same month, average of the last three years
def a_clim(h):   return h.mean(axis=0)                         # same month, average of every earlier year
def a_profile(h):                                              # the city's seasonal shape, at the latest year's level
    shape = (h / h.mean(axis=1, keepdims=True)).mean(axis=0)
    return shape * h[-1].mean()
AQ_METHODS = {"snaive": ("Same month last year", a_snaive),
              "smean3": ("Same month, average of the last three years", a_smean3),
              "climatology": ("Same month, average of all earlier years", a_clim),
              "profile": ("Seasonal shape of all earlier years, at last year's level", a_profile)}

# Each method gives the same twelve months for any future year; what changes with distance is which
# method holds up best and how wrong it gets, measured by forecasting each test year from h years earlier.
aq_err = {h: {m: [] for m in AQ_METHODS} for h in HORIZONS}; aq_abs = {h: {m: [] for m in AQ_METHODS} for h in HORIZONS}
for h in HORIZONS:
    for t in AQ_BACKTEST:
        i = AQ_YEARS.index(t); hist, actual = aq[:i - h + 1], aq[i]
        for m, (_, fn) in AQ_METHODS.items():
            pr = fn(hist)
            aq_abs[h][m] += list(np.abs(pr - actual)); aq_err[h][m] += list(np.abs(pr - actual) / actual)
aq_mape_h = {h: {m: 100 * float(np.mean(e)) for m, e in aq_err[h].items()} for h in HORIZONS}
aq_mae_h = {h: {m: float(np.mean(e)) for m, e in aq_abs[h].items()} for h in HORIZONS}
aq_chosen = {h: min(aq_mape_h[h], key=aq_mape_h[h].get) for h in HORIZONS}
aq_best = aq_chosen[1]
aq_mape = {m: round(v, 1) for m, v in aq_mape_h[1].items()}           # one year ahead, as shown on the page
aq_mae = {m: round(v, 1) for m, v in aq_mae_h[1].items()}
aq_q = {}
for h in HORIZONS:
    aq_q[h] = max(float(np.quantile(aq_err[h][aq_chosen[h]], 0.8)), aq_q.get(h - 1, 0.0))
for y in FORECAST_YEARS:
    h = y - AQ_YEARS[-1]; q = aq_q[h]; pred = AQ_METHODS[aq_chosen[h]][1](aq)
    for m in range(12):
        p_ = float(pred[m])
        forecasts.append({"model": "aqi-forecast-2026", "metric": "aqi_monthly_avg", "month": m + 1,
                          "zone": None, "category": None, "year": y, "value": round(p_),
                          "lower": max(0, round(p_ * (1 - q))), "upper": round(p_ * (1 + q)), "method": aq_chosen[h], "family": "city_aqi"})
# how the chosen method did one year ahead, year by year, so the page can show the backtest honestly
aq_backtest = []
for t in AQ_BACKTEST:
    i = AQ_YEARS.index(t); pr = AQ_METHODS[aq_best][1](aq[:i])
    aq_backtest.append({"year": t, "predicted": [round(float(v)) for v in pr], "actual": [int(v) for v in aq[i]],
                        "mae": round(float(np.mean(np.abs(pr - aq[i]))), 1)})

aqi_model = {
    "id": "aqi-forecast-2026",
    "name": "Air-quality forecast",
    "kind": "forecast",
    "method": "For each forecast year, the best of four seasonal methods by forecasting each whole year 2022-2025 from the years up to 1, 2 or 3 years before it; 80% interval from that method's errors at that distance",
    "description": "Predicts Mumbai's average AQI for each month of 2026, 2027 and 2028. Air quality follows a strong yearly cycle (worst in winter, best in the monsoon), so every method is built around that cycle. Each year uses the method that held up best that many years ahead.",
    "params": {"methods": {m: l for m, (l, _) in AQ_METHODS.items()}, "backtest_years": AQ_BACKTEST, "forecast_years": FORECAST_YEARS,
               "chosen": aq_best, "chosen_by_horizon": {str(h): m for h, m in aq_chosen.items()}, "mape_pct": aq_mape, "mae": aq_mae,
               "mape_pct_by_horizon": {str(h): {m: round(v, 1) for m, v in aq_mape_h[h].items()} for h in HORIZONS},
               "interval_pct": round(100 * aq_q[1], 1),
               "interval_pct_by_horizon": {str(h): round(100 * q, 1) for h, q in aq_q.items()},
               "backtest": aq_backtest, "naive": "snaive"},
    "metrics": {"mape_pct": aq_mape[aq_best], "mae": aq_mae[aq_best], "naive_mape_pct": aq_mape["snaive"],
                "improvement_vs_naive_pct": round(100 * (aq_mape["snaive"] - aq_mape[aq_best]) / aq_mape["snaive"], 1)},
    "trained_on": "Monthly average AQI 2016-2025 (120 months); Praja Foundation 2026 report Table 29",
}

# ---------------------------------------------------------------------------
# 5. Water, 2020-2024 -> 2025, 2026, 2027, 2028
# ---------------------------------------------------------------------------
WT_YEARS = list(range(2020, 2025))
WT_BACKTEST = [2023, 2024]
WT_OUT = list(range(WT_YEARS[-1] + 1, FORECAST_YEARS[-1] + 1))
WT_HORIZONS = [y - WT_YEARS[-1] for y in WT_OUT]

# unfit drinking-water samples, %: wards and city together (25 series). Many values are near or at
# zero, so methods are scored and ranges set in percentage points, not as a share of the figure.
unfit_ser = {z: series(z, "water_unfit_samples_pct", None, WT_YEARS) for z in WARDS + [None]}
unfit_ser = {z: v for z, v in unfit_ser.items() if v}
um, uiv, uch = backtest(unfit_ser, WT_YEARS, WT_BACKTEST, METHODS, WT_HORIZONS, error="absolute")
# water drawn from the lakes and water supplied to the city, MLD, by financial year (2024 = 2023-24)
fy_ser = {k: series(None, k, None, WT_YEARS) for k in ["water_yield_fy", "water_supply_fy"]}
fy_ser = {k: v for k, v in fy_ser.items() if v}
fm_, fiv, fch = backtest(fy_ser, WT_YEARS, WT_BACKTEST, METHODS, WT_HORIZONS)
water_metrics = {"unfit": {"label": "Drinking-water samples unfit, wards and city", **um},
                 "city_water_fy": {"label": "Water drawn and supplied, city", **fm_}}
for z, ys in unfit_ser.items():
    emit("water-forecast", "water_unfit_samples_pct", "unfit", z, None, ys, WT_YEARS[-1], WT_OUT, uch, uiv, "absolute", decimals=2)
for k, ys in fy_ser.items():
    emit("water-forecast", k, "city_water_fy", None, None, ys, WT_YEARS[-1], WT_OUT, fch, fiv, "relative")

water_model = {
    "id": "water-forecast",
    "name": "Water forecasts",
    "kind": "forecast",
    "method": "Best of three simple methods by backtest on 2023 and 2024; 80% interval from that method's backtest errors, widened for later years",
    "description": f"Predicts the share of drinking-water samples found unfit (by ward and city-wide) and the water drawn and supplied city-wide, for {WT_OUT[0]} to {WT_OUT[-1]}. Water figures are published only to {WT_YEARS[-1]}, from five years, so only one year ahead could be tested and later ranges are widened from that test.",
    "params": {"methods": {m: l for m, (l, _) in METHODS.items()}, "backtest_years": WT_BACKTEST, "forecast_years": WT_OUT,
               "families": water_metrics},
    "metrics": {"unfit": {"mae_points": um["mae"][um["chosen"]], "naive_mae_points": um["mae"]["naive"]},
                "city_water_fy": {"mape_pct": fm_["mape_pct"][fm_["chosen"]], "naive_mape_pct": fm_["mape_pct"]["naive"]}},
    "trained_on": "Drinking-water samples unfit 2020-2024 (Praja Foundation 2025 report, Table 7); water drawn and supplied FY 2019-20 to 2023-24 (Table 2)",
}

json.dump({"trained_at": date.today().isoformat(), "models": [cluster_model, forecast_model, waste_model, aqi_model, water_model],
           "clusters": assignments, "forecasts": forecasts}, open(sys.argv[2], "w", newline="\n"), indent=1)

print("ward groups:", "reused from previous results" if KEEP_CLUSTERS else "retrained",
      "k =", cluster_model["params"]["k"])
for name, fams in [("complaints", family_metrics), ("waste", waste_metrics), ("water", water_metrics)]:
    for fam, m in fams.items():
        iv_ = m.get("interval_pct_by_horizon") or m.get("interval_abs_by_horizon")
        err = m.get("mape_pct") or m["mae"]
        print(f"  {name:10} {fam:14} chosen={m['chosen_by_horizon']} 1-yr error {err}  ranges {iv_}  tested h={m['horizons_tested']}")
print("  AQI chosen", aq_chosen, "1-yr MAPE", aq_mape, "ranges", {h: round(100 * q, 1) for h, q in aq_q.items()})
for f in forecasts:
    if f["zone"] is None and f["category"] is None and f["month"] is None:
        print("  city", f["metric"], f["year"], f["value"], f"({f['lower']} to {f['upper']})", f["method"])
