"""Train CivicOS's Mumbai models on the published ward figures (../praja_tables.json).

1. Ward groups: k-means on standardised ward indicators; k chosen by silhouette score.
2. Complaint forecasts for 2026: three simple methods compared by a rolling backtest
   (forecast each of 2022-2025 from the years before it). The method with the lowest
   error across a family of series is used for every series in that family. The 80%
   interval comes from that method's own backtest errors.
3. Waste forecasts for 2026: waste lifted (tonnes/day) per ward and city, 2021-2025, same
   three methods, backtest on 2024 and 2025.
4. Air-quality forecast for each month of 2026: monthly AQI 2016-2025, four seasonal methods
   compared by forecasting each whole year 2022-2025 from the years before it.

Usage: python3 train.py ../praja_tables.json results.json
Everything is deterministic (fixed seeds), so re-running gives the same output.
"""
import json, sys
from datetime import date
import numpy as np
from sklearn.cluster import KMeans
from sklearn.metrics import silhouette_score
from sklearn.preprocessing import StandardScaler

data = json.load(open(sys.argv[1]))
WARDS = data["wards"]
R = data["records"]

def val(zone, year, metric, category=None):
    for r in R:
        if r["zone"] == zone and r["year"] == year and r["metric"] == metric and r["category"] == category and r["month"] is None:
            return r["value"]
    return None

# ---------------------------------------------------------------------------
# 1. Ward groups
# ---------------------------------------------------------------------------
FEATURES = [  # (key, label, how to read it, higher is better?)
    ("complaints_per_10k", "Complaints per 10,000 residents (2025)", False),
    ("closed_pct", "Complaints closed, % (2025)", True),
    ("avg_days", "Average days to close (2025)", False),
    ("water_hours", "Water supply, hours per day (2024)", True),
    ("water_unfit_pct", "Drinking-water samples unfit, % (2024)", False),
    ("waste_per_capita", "Waste per person, kg per day (2025)", None),
    ("slum_pct", "Slum population, % (2011)", None),
]
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
city_mean = X_raw.mean(axis=0)
groups = []
for g in range(k_best):
    idx = np.where(km.labels_ == g)[0]
    mean_raw = X_raw[idx].mean(axis=0)
    mean_z = Z[idx].mean(axis=0)
    groups.append({"cluster": g, "wards": [rows[i]["ward"] for i in idx],
                   "mean": {k: round(float(v), 2) for k, v in zip(keys, mean_raw)},
                   "z": {k: round(float(v), 2) for k, v in zip(keys, mean_z)}})

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
    g = remap[int(km.labels_[i])]
    assignments.append({"ward": r["ward"], "cluster": g,
                        "features": {k: r[k] for k in keys},
                        "z": {k: round(float(v), 2) for k, v in zip(keys, Z[i])}})

cluster_model = {
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

# ---------------------------------------------------------------------------
# 2. Complaint forecasts
# ---------------------------------------------------------------------------
YEARS = list(range(2016, 2026))
BACKTEST = [2022, 2023, 2024, 2025]

def series(zone, metric, category):
    ys = [val(zone, y, metric, category) for y in YEARS]
    return ys if all(v is not None for v in ys) else None

def f_naive(hist): return hist[-1]
def f_mean3(hist): return float(np.mean(hist[-3:]))
def f_trend(hist):
    x = np.arange(len(hist)); b, a = np.polyfit(x, hist, 1)
    return max(0.0, a + b * len(hist))
METHODS = {"naive": ("Last year's value", f_naive),
           "mean3": ("Average of the last three years", f_mean3),
           "trend": ("Straight-line trend over all earlier years", f_trend)}

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

forecasts, family_metrics = [], {}
for fam, keys_ in families.items():
    ser = {(z, c): series(z, "complaints_registered", c) for z, c in keys_}
    ser = {k: v for k, v in ser.items() if v}
    errs = {m: [] for m in METHODS}          # absolute % errors
    abs_errs = {m: [] for m in METHODS}
    for (z, c), ys in ser.items():
        for t in BACKTEST:
            i = YEARS.index(t); hist, actual = ys[:i], ys[i]
            for m, (_, fn) in METHODS.items():
                p = fn(hist)
                abs_errs[m].append(abs(p - actual))
                if actual > 0: errs[m].append(abs(p - actual) / actual)
    mape = {m: round(100 * float(np.mean(e)), 1) for m, e in errs.items()}
    mae = {m: round(float(np.mean(e)), 1) for m, e in abs_errs.items()}
    best = min(mape, key=mape.get)
    q80 = float(np.quantile(errs[best], 0.8))          # 80% of backtest forecasts were within this % of the actual
    family_metrics[fam] = {"label": FAMILY_LABEL[fam], "series": len(ser), "backtest_years": BACKTEST,
                           "chosen": best, "mape_pct": mape, "mae": mae, "interval_pct": round(100 * q80, 1),
                           "baseline": "naive",
                           "improvement_vs_naive_pct": round(100 * (mape["naive"] - mape[best]) / mape["naive"], 1) if mape["naive"] else None}
    for (z, c), ys in ser.items():
        p = METHODS[best][1](ys)
        forecasts.append({"model": "complaints-forecast-2026", "metric": "complaints_registered", "month": None,
                          "zone": z, "category": c, "year": 2026, "value": round(p),
                          "lower": max(0, round(p * (1 - q80))), "upper": round(p * (1 + q80)), "method": best, "family": fam})

forecast_model = {
    "id": "complaints-forecast-2026",
    "name": "Complaint forecasts",
    "kind": "forecast",
    "method": "Per family of series, the best of three simple methods by rolling backtest; 80% interval from that method's backtest errors",
    "description": "Predicts how many complaints will be registered in 2026, with a range. Built on ten yearly figures per series, so the ranges are wide on purpose.",
    "params": {"methods": {m: l for m, (l, _) in METHODS.items()}, "backtest_years": BACKTEST, "families": family_metrics},
    "metrics": {fam: {"mape_pct": m["mape_pct"][m["chosen"]], "naive_mape_pct": m["mape_pct"]["naive"]} for fam, m in family_metrics.items()},
    "trained_on": "Complaints registered 2016-2025; Praja Foundation 2026 report Tables 1, 39, 41, 43",
}

# ---------------------------------------------------------------------------
# 3. Waste forecasts (tonnes lifted per day), 2021-2025 -> 2026
# ---------------------------------------------------------------------------
W_YEARS = list(range(2021, 2026))
W_BACKTEST = [2024, 2025]            # each needs at least three earlier years for the 3-year average
def wseries(zone):
    ys = [val(zone, y, "waste_tonnes_per_day") for y in W_YEARS]
    return ys if all(v is not None for v in ys) else None

waste_families = {"ward_waste": [w for w in WARDS], "city_waste": [None]}
WASTE_LABEL = {"ward_waste": "Waste lifted, by ward", "city_waste": "Waste lifted, whole city"}
waste_metrics = {}
for fam, zones in waste_families.items():
    ser = {z: wseries(z) for z in zones}
    ser = {z: v for z, v in ser.items() if v}
    errs = {m: [] for m in METHODS}; abs_errs = {m: [] for m in METHODS}
    for z, ys in ser.items():
        for t in W_BACKTEST:
            i = W_YEARS.index(t); hist, actual = ys[:i], ys[i]
            for m, (_, fn) in METHODS.items():
                pr = fn(hist); abs_errs[m].append(abs(pr - actual))
                if actual > 0: errs[m].append(abs(pr - actual) / actual)
    mape = {m: round(100 * float(np.mean(e)), 1) for m, e in errs.items()}
    mae = {m: round(float(np.mean(e)), 1) for m, e in abs_errs.items()}
    best = min(mape, key=mape.get)
    q80 = float(np.quantile(errs[best], 0.8))
    if fam == "city_waste":
        # one series x two test years is only two errors, too few for a range on its own:
        # use the wider of its own and the ward family's interval
        q80 = max(q80, waste_metrics["ward_waste"]["interval_pct"] / 100)
    waste_metrics[fam] = {"label": WASTE_LABEL[fam], "series": len(ser), "backtest_years": W_BACKTEST, "chosen": best,
                          "mape_pct": mape, "mae": mae, "interval_pct": round(100 * q80, 1), "baseline": "naive",
                          "improvement_vs_naive_pct": round(100 * (mape["naive"] - mape[best]) / mape["naive"], 1) if mape["naive"] else None}
    for z, ys in ser.items():
        pr = METHODS[best][1](ys)
        forecasts.append({"model": "waste-forecast-2026", "metric": "waste_tonnes_per_day", "month": None,
                          "zone": z, "category": None, "year": 2026, "value": round(pr),
                          "lower": max(0, round(pr * (1 - q80))), "upper": round(pr * (1 + q80)), "method": best, "family": fam})

waste_model = {
    "id": "waste-forecast-2026",
    "name": "Waste forecasts",
    "kind": "forecast",
    "method": "Best of three simple methods by backtest on 2024 and 2025; 80% interval from that method's backtest errors",
    "description": "Predicts the tonnes of waste BMC will lift per day in 2026, for the city and each ward. Only five years are published, so it is tested on two years and the ranges are wide.",
    "params": {"methods": {m: l for m, (l, _) in METHODS.items()}, "backtest_years": W_BACKTEST, "families": waste_metrics},
    "metrics": {fam: {"mape_pct": m["mape_pct"][m["chosen"]], "naive_mape_pct": m["mape_pct"]["naive"]} for fam, m in waste_metrics.items()},
    "trained_on": "Waste lifted per day 2021-2025; Praja Foundation 2026 report Table 37",
}

# ---------------------------------------------------------------------------
# 4. Monthly air quality (AQI), 2016-2025 -> each month of 2026
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

aq_err = {m: [] for m in AQ_METHODS}; aq_abs = {m: [] for m in AQ_METHODS}
for t in AQ_BACKTEST:
    i = AQ_YEARS.index(t); hist, actual = aq[:i], aq[i]
    for m, (_, fn) in AQ_METHODS.items():
        pr = fn(hist)
        aq_abs[m] += list(np.abs(pr - actual)); aq_err[m] += list(np.abs(pr - actual) / actual)
aq_mape = {m: round(100 * float(np.mean(e)), 1) for m, e in aq_err.items()}
aq_mae = {m: round(float(np.mean(e)), 1) for m, e in aq_abs.items()}
aq_best = min(aq_mape, key=aq_mape.get)
aq_q80 = float(np.quantile(aq_err[aq_best], 0.8))
aq_pred = AQ_METHODS[aq_best][1](aq)
for m in range(12):
    p_ = float(aq_pred[m])
    forecasts.append({"model": "aqi-forecast-2026", "metric": "aqi_monthly_avg", "month": m + 1,
                      "zone": None, "category": None, "year": 2026, "value": round(p_),
                      "lower": max(0, round(p_ * (1 - aq_q80))), "upper": round(p_ * (1 + aq_q80)), "method": aq_best, "family": "city_aqi"})
# how the chosen method did, year by year, so the page can show the backtest honestly
aq_backtest = []
for t in AQ_BACKTEST:
    i = AQ_YEARS.index(t); pr = AQ_METHODS[aq_best][1](aq[:i])
    aq_backtest.append({"year": t, "predicted": [round(float(v)) for v in pr], "actual": [int(v) for v in aq[i]],
                        "mae": round(float(np.mean(np.abs(pr - aq[i]))), 1)})

aqi_model = {
    "id": "aqi-forecast-2026",
    "name": "Air-quality forecast",
    "kind": "forecast",
    "method": "Best of four seasonal methods by forecasting each whole year 2022-2025 from the years before it; 80% interval from that method's errors",
    "description": "Predicts Mumbai's average AQI for each month of 2026. Air quality follows a strong yearly cycle (worst in winter, best in the monsoon), so every method is built around that cycle.",
    "params": {"methods": {m: l for m, (l, _) in AQ_METHODS.items()}, "backtest_years": AQ_BACKTEST, "chosen": aq_best,
               "mape_pct": aq_mape, "mae": aq_mae, "interval_pct": round(100 * aq_q80, 1), "backtest": aq_backtest,
               "naive": "snaive"},
    "metrics": {"mape_pct": aq_mape[aq_best], "mae": aq_mae[aq_best], "naive_mape_pct": aq_mape["snaive"],
                "improvement_vs_naive_pct": round(100 * (aq_mape["snaive"] - aq_mape[aq_best]) / aq_mape["snaive"], 1)},
    "trained_on": "Monthly average AQI 2016-2025 (120 months); Praja Foundation 2026 report Table 29",
}

json.dump({"trained_at": date.today().isoformat(), "models": [cluster_model, forecast_model, waste_model, aqi_model],
           "clusters": assignments, "forecasts": forecasts}, open(sys.argv[2], "w"), indent=1)

print("k candidates:", scores, "-> k =", k_best)
for g in groups: print(f"  group {g['cluster']} ({len(g['wards'])}): {g['label']}: {' '.join(g['wards'])}")
for fam, m in family_metrics.items():
    print(f"  {fam:14} chosen={m['chosen']:6} MAPE {m['mape_pct']}  interval ±{m['interval_pct']}%  vs naive {m['improvement_vs_naive_pct']}%")
city = next(f for f in forecasts if f["family"] == "city_total")
print("  city 2026:", city)
for fam, m in waste_metrics.items():
    print(f"  {fam:14} chosen={m['chosen']:6} MAPE {m['mape_pct']}  interval ±{m['interval_pct']}%")
print("  AQI chosen", aq_best, "MAPE", aq_mape, "MAE", aq_mae, "interval ±", round(100 * aq_q80, 1), "%")
print("  AQI 2026:", [f["value"] for f in forecasts if f["model"] == "aqi-forecast-2026"])
print("  city waste 2026:", next(f for f in forecasts if f["family"] == "city_waste"))
