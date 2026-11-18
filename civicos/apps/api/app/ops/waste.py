"""Waste models.

A. Fill-level forecasting: XGBoost regression of how much a bin fills over the next 2 to 24 hours, from its current
   level, hours since it was emptied, the hour and weekday, the bin's type and size, its usual filling rate and how
   fast it filled in the last six hours.
B. Overflow prediction: XGBoost classifier, the probability a bin reaches 95% within 6, 12 or 24 hours if it is not
   collected. Scored on the most recent week (held out) by AUC and Brier score against straight-line extrapolation,
   with a calibration table, so a probability shown is one the test supports.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

import numpy as np
import xgboost as xgb

from .demo import Bin
from .water import _auc, mae

FULL = 95.0                      # a bin at 95% or more counts as full (overflowing or about to)
STEP_H = 2
HORIZONS_H = (6, 12, 24)
KINDS = ["residential", "market", "commercial"]
FEATURES = ["current fill (%)", "hours since emptied", "hour", "weekday", "horizon (hours)", "usual fill rate (%/hour)",
            "fill rate, last 6 hours (%/hour)", "capacity (litres)"] + [f"type: {k}" for k in KINDS]


@dataclass
class BinPrediction:
    bin_key: str
    fill_now: float
    fill: dict[int, float]                 # horizon hours -> predicted fill %
    p_overflow: dict[int, float]           # horizon hours -> probability of reaching 95%


@dataclass
class WasteResult:
    bins: list[BinPrediction]
    metrics: dict
    generated_at: datetime


def _since_emptied(collected: np.ndarray) -> np.ndarray:
    out = np.zeros(collected.shape)
    for b in range(collected.shape[0]):
        h = 48.0
        for t in range(collected.shape[1]):
            h = 0.0 if collected[b, t] else h + STEP_H
            out[b, t] = h
    return out


def _usual_rate(fill: np.ndarray, collected: np.ndarray, upto: int) -> np.ndarray:
    inc = np.diff(fill[:, :upto], axis=1)
    ok = ~collected[:, 1:upto] & (fill[:, 1:upto] < 99)
    with np.errstate(invalid="ignore"):
        r = np.where(ok, inc, np.nan)
        return np.nan_to_num(np.nanmean(np.clip(r, 0, None), axis=1) / STEP_H, nan=1.0)


def _rows(bins: list[Bin], times: list[datetime], fill: np.ndarray, collected: np.ndarray, since: np.ndarray,
          rate: np.ndarray, t_range: range, horizons: list[int], need_target: bool):
    X, y_inc, y_full, meta = [], [], [], []
    n_t = fill.shape[1]
    for b, bn in enumerate(bins):
        onehot = [1.0 if bn.kind == k else 0.0 for k in KINDS]
        for t in t_range:
            recent = (fill[b, t] - fill[b, t - 3]) / 6 if t >= 3 and not collected[b, t - 2:t + 1].any() else rate[b]
            for h in horizons:
                k = h // STEP_H
                if need_target:
                    if t + k >= n_t or collected[b, t + 1:t + k + 1].any() or fill[b, t] >= FULL:
                        continue                    # windows the crew did not empty ("if not collected"), bin not yet full
                    y_inc.append(fill[b, t + k] - fill[b, t])
                    y_full.append(1 if fill[b, t + 1:t + k + 1].max() >= FULL else 0)
                X.append([fill[b, t], since[b, t], times[t].hour, times[t].weekday(), h, rate[b], recent, bn.capacity_l] + onehot)
                meta.append((b, t, h))
    return np.array(X, dtype=float), np.array(y_inc), np.array(y_full), meta


def predict_bins(bins: list[Bin], times: list[datetime], fill: np.ndarray, collected: np.ndarray, seed: int = 0) -> WasteResult:
    n_t = fill.shape[1]
    since = _since_emptied(collected)
    test_from = n_t - 7 * 24 // STEP_H                     # the last week is held out
    horizons = [2, 4, 6, 12, 18, 24]

    rate_tr = _usual_rate(fill, collected, test_from)
    Xtr, ytr_inc, ytr_full, _ = _rows(bins, times, fill, collected, since, rate_tr, range(3, test_from), horizons, True)
    Xte, yte_inc, yte_full, mte = _rows(bins, times, fill, collected, since, rate_tr, range(test_from, n_t), list(HORIZONS_H), True)

    reg = xgb.XGBRegressor(n_estimators=300, max_depth=5, learning_rate=0.05, subsample=0.9, tree_method="hist",
                           random_state=seed, n_jobs=2)
    clf = xgb.XGBClassifier(n_estimators=300, max_depth=4, learning_rate=0.05, subsample=0.9, min_child_weight=3,
                            tree_method="hist", random_state=seed, n_jobs=2, eval_metric="logloss")
    keep = np.isin(Xtr[:, 4], HORIZONS_H)
    reg.fit(Xtr, ytr_inc)
    clf.fit(Xtr[keep], ytr_full[keep])

    metrics: dict = {"test": "the most recent 7 days, held out; bins not yet full, in windows in which they were not emptied",
                     "full_means": f"{FULL:.0f}% or more", "features": FEATURES}
    p_inc = reg.predict(Xte)
    p_full = clf.predict_proba(Xte)[:, 1]
    lin_inc = Xte[:, 5] * Xte[:, 4]                         # usual rate x hours
    lin_full = (np.minimum(100, Xte[:, 0] + lin_inc) >= FULL).astype(float)
    for h in HORIZONS_H:
        m = Xte[:, 4] == h
        if not m.any():
            continue
        y_f = Xte[m, 0] + yte_inc[m]
        p_f = np.minimum(100, Xte[m, 0] + p_inc[m])
        l_f = np.minimum(100, Xte[m, 0] + lin_inc[m])
        yb, pb, lb = yte_full[m], p_full[m], lin_full[m]
        buckets = np.clip((pb * 5).astype(int), 0, 4)
        metrics[f"{h}h"] = {
            "windows": int(m.sum()), "reached_full": int(yb.sum()),
            "fill_mae_pct": {"xgboost": round(mae(y_f, p_f), 2), "straight_line": round(mae(y_f, l_f), 2)},
            "overflow": {"xgboost": {"auc": round(_auc(yb, pb), 3), "brier": round(float(np.mean((pb - yb) ** 2)), 4),
                                     "precision_at_50": round(float(yb[pb >= 0.5].mean()) if (pb >= 0.5).any() else 0.0, 3),
                                     "recall_at_50": round(float((pb[yb == 1] >= 0.5).mean()) if yb.any() else 0.0, 3)},
                         "straight_line": {"precision": round(float(yb[lb == 1].mean()) if lb.any() else 0.0, 3),
                                           "recall": round(float(lb[yb == 1].mean()) if yb.any() else 0.0, 3),
                                           "brier": round(float(np.mean((lb - yb) ** 2)), 4)}},
            "calibration": [{"predicted": round(float(pb[buckets == k].mean()), 3), "observed": round(float(yb[buckets == k].mean()), 3),
                             "windows": int((buckets == k).sum())} for k in range(5) if (buckets == k).any()],
        }

    # refit on all history, predict from the latest reading
    rate = _usual_rate(fill, collected, n_t)
    Xa, ya_inc, ya_full, _ = _rows(bins, times, fill, collected, since, rate, range(3, n_t), horizons, True)
    keep = np.isin(Xa[:, 4], HORIZONS_H)
    reg.fit(Xa, ya_inc)
    clf.fit(Xa[keep], ya_full[keep])
    Xn, _, _, mn = _rows(bins, times, fill, collected, since, rate, range(n_t - 1, n_t), list(HORIZONS_H), False)
    inc = reg.predict(Xn)
    pf = clf.predict_proba(Xn)[:, 1]
    out: dict[int, BinPrediction] = {}
    for (b, _t, h), i, p in zip(mn, inc, pf):
        bp = out.setdefault(b, BinPrediction(bins[b].key, float(fill[b, -1]), {}, {}))
        bp.fill[h] = round(float(min(100.0, max(fill[b, -1], fill[b, -1] + i))), 1)
        # if the bin is already full, it overflows in any window
        bp.p_overflow[h] = 1.0 if fill[b, -1] >= FULL else round(float(p), 4)
    # monotone in the horizon: a bin cannot be less likely to fill within 24 hours than within 6
    for bp in out.values():
        for a, b_ in ((6, 12), (12, 24)):
            bp.p_overflow[b_] = max(bp.p_overflow[b_], bp.p_overflow[a])
            bp.fill[b_] = max(bp.fill[b_], bp.fill[a])
    return WasteResult([out[b] for b in sorted(out)], metrics, times[-1])
