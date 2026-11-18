"""Isolation Forest (Liu, Ting and Zhou, 2008), in NumPy.

Each tree isolates points with random axis-aligned splits on a random subsample. Anomalies are few and different, so
they are isolated in fewer splits: a short average path length means a high anomaly score,

    s(x) = 2 ** (-E[h(x)] / c(psi)),   c(n) = 2 H(n - 1) - 2 (n - 1) / n,

where psi is the subsample size and H the harmonic number. s near 1 is anomalous, well below 0.5 is normal.
This is the same algorithm as scikit-learn's IsolationForest. It is written out here so the model has no compiled
dependency and behaves the same on every machine.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

EULER = 0.5772156649015329


def c_factor(n: int | np.ndarray) -> np.ndarray:
    """Average path length of an unsuccessful binary-search-tree search over n points."""
    n = np.asarray(n, dtype=float)
    out = np.zeros_like(n)
    big = n > 2
    out[big] = 2.0 * (np.log(n[big] - 1.0) + EULER) - 2.0 * (n[big] - 1.0) / n[big]
    out[n == 2] = 1.0
    return out


@dataclass
class _Tree:
    feature: np.ndarray       # -1 marks a leaf
    threshold: np.ndarray
    left: np.ndarray
    right: np.ndarray
    size: np.ndarray          # points that reached a leaf (for the c(n) correction)
    depth: np.ndarray

    def path_length(self, X: np.ndarray) -> np.ndarray:
        node = np.zeros(len(X), dtype=int)
        active = self.feature[node] >= 0
        while active.any():
            idx = np.where(active)[0]
            nd = node[idx]
            go_left = X[idx, self.feature[nd]] < self.threshold[nd]
            node[idx] = np.where(go_left, self.left[nd], self.right[nd])
            active = self.feature[node] >= 0
        return self.depth[node] + c_factor(self.size[node])


def _grow(X: np.ndarray, rng: np.random.Generator, max_depth: int) -> _Tree:
    feature, threshold, left, right, size, depth = [], [], [], [], [], []

    def new_node() -> int:
        for lst, v in ((feature, -1), (threshold, 0.0), (left, -1), (right, -1), (size, 0), (depth, 0)):
            lst.append(v)
        return len(feature) - 1

    stack = [(new_node(), np.arange(len(X)), 0)]
    while stack:
        nid, rows, d = stack.pop()
        depth[nid] = d
        size[nid] = len(rows)
        if d >= max_depth or len(rows) <= 1:
            continue
        sub = X[rows]
        lo, hi = sub.min(axis=0), sub.max(axis=0)
        splittable = np.where(hi > lo)[0]
        if len(splittable) == 0:
            continue
        f = int(rng.choice(splittable))
        t = float(rng.uniform(lo[f], hi[f]))
        mask = sub[:, f] < t
        feature[nid], threshold[nid] = f, t
        li, ri = new_node(), new_node()
        left[nid], right[nid] = li, ri
        stack.append((li, rows[mask], d + 1))
        stack.append((ri, rows[~mask], d + 1))

    return _Tree(np.array(feature), np.array(threshold), np.array(left), np.array(right), np.array(size),
                 np.array(depth, dtype=float))


@dataclass
class IsolationForest:
    n_estimators: int = 150
    max_samples: int = 256
    random_state: int = 0
    trees: list[_Tree] = field(default_factory=list, repr=False)
    psi: int = 0

    def fit(self, X: np.ndarray) -> IsolationForest:
        X = np.asarray(X, dtype=float)
        rng = np.random.default_rng(self.random_state)
        self.psi = min(self.max_samples, len(X))
        max_depth = math.ceil(math.log2(max(self.psi, 2)))
        self.trees = [_grow(X[rng.choice(len(X), self.psi, replace=False)], rng, max_depth) for _ in range(self.n_estimators)]
        return self

    def score(self, X: np.ndarray) -> np.ndarray:
        """Anomaly score in (0, 1]; higher is more anomalous."""
        X = np.asarray(X, dtype=float)
        mean_path = np.mean([t.path_length(X) for t in self.trees], axis=0)
        return np.power(2.0, -mean_path / float(c_factor(self.psi)))
