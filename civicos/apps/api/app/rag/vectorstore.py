"""A separate vector database for document search: Qdrant (VECTOR_STORE=qdrant).

Postgres stays the system of record: every chunk and its embedding are stored there (document_chunks,
document_embeddings), so the Qdrant collection is an index that can be rebuilt at any time without calling Gemini
(POST /v1/vector/sync). Qdrant answers "which chunks are nearest this question"; the chunks themselves are then read
from Postgres as the signed-in user, so Row Level Security still decides what anyone can see:

  * every Qdrant search is filtered to the caller's organization (and to public documents for residents), and
  * every hit is re-read through RLS, so a point that is stale or wrongly filtered can never leak a passage.

Spoken to over Qdrant's REST API with httpx (no extra client library). Works with Qdrant Cloud (QDRANT_URL and
QDRANT_API_KEY) or a local container (docker compose --profile vector).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx


class VectorStoreError(RuntimeError):
    pass


@dataclass
class VectorHit:
    chunk_id: int
    score: float                      # cosine similarity


class QdrantStore:
    BATCH = 256

    def __init__(self, url: str, api_key: str | None, collection: str, dim: int, client: httpx.Client | None = None):
        self.collection, self.dim = collection, dim
        headers = {"api-key": api_key} if api_key else {}
        self._http = client or httpx.Client(base_url=url.rstrip("/"), headers=headers, timeout=30)
        self._ready = False

    # ---------------------------------------------------------------------------------------------- plumbing
    def _call(self, method: str, path: str, body: dict | None = None, ok404: bool = False) -> dict:
        try:
            r = self._http.request(method, path, json=body)
        except httpx.HTTPError as e:
            raise VectorStoreError(f"The vector database could not be reached: {e}") from e
        if ok404 and r.status_code == 404:
            return {}
        if r.status_code >= 400:
            raise VectorStoreError(f"The vector database returned {r.status_code}: {r.text[:200]}")
        return r.json()

    def ensure(self) -> None:
        """Creates the collection and its payload indexes on first use (idempotent)."""
        if self._ready:
            return
        c = f"/collections/{self.collection}"
        info = self._call("GET", c, ok404=True)
        if not info:
            self._call("PUT", c, {"vectors": {"size": self.dim, "distance": "Cosine"}})
        else:
            size = info.get("result", {}).get("config", {}).get("params", {}).get("vectors", {}).get("size")
            if size and size != self.dim:
                raise VectorStoreError(f"Collection {self.collection} has {size}-dimensional vectors, not {self.dim}")
        for field in ("organization_id", "document_id", "access_level", "category"):
            self._call("PUT", f"{c}/index?wait=true", {"field_name": field, "field_schema": "keyword"})
        self._ready = True

    @staticmethod
    def _filter(org_id: str, public_only: bool = False, category: str | None = None, document_id: str | None = None) -> dict:
        must: list[dict[str, Any]] = [{"key": "organization_id", "match": {"value": org_id}}]
        if public_only:
            must.append({"key": "access_level", "match": {"value": "public"}})
        if category:
            must.append({"key": "category", "match": {"value": category}})
        if document_id:
            must.append({"key": "document_id", "match": {"value": document_id}})
        return {"must": must}

    # ---------------------------------------------------------------------------------------------- writes
    def upsert(self, points: list[dict[str, Any]]) -> int:
        """points: {"id": chunk_id, "vector": [...], "payload": {organization_id, document_id, access_level, category, model}}"""
        self.ensure()
        for s in range(0, len(points), self.BATCH):
            self._call("PUT", f"/collections/{self.collection}/points?wait=true", {"points": points[s:s + self.BATCH]})
        return len(points)

    def delete_document(self, org_id: str, document_id: str) -> None:
        self.ensure()
        self._call("POST", f"/collections/{self.collection}/points/delete?wait=true",
                   {"filter": self._filter(org_id, document_id=document_id)})

    def delete_organization(self, org_id: str) -> None:
        self.ensure()
        self._call("POST", f"/collections/{self.collection}/points/delete?wait=true", {"filter": self._filter(org_id)})

    # ---------------------------------------------------------------------------------------------- reads
    def search(self, org_id: str, vector: list[float], limit: int = 40, public_only: bool = False,
               category: str | None = None) -> list[VectorHit]:
        self.ensure()
        res = self._call("POST", f"/collections/{self.collection}/points/search",
                         {"vector": vector, "limit": limit, "with_payload": False,
                          "filter": self._filter(org_id, public_only, category)})
        return [VectorHit(int(p["id"]), float(p["score"])) for p in res.get("result", [])]

    def count(self, org_id: str) -> int:
        self.ensure()
        res = self._call("POST", f"/collections/{self.collection}/points/count", {"filter": self._filter(org_id), "exact": True})
        return int(res.get("result", {}).get("count", 0))

    def status(self) -> str:
        try:
            info = self._call("GET", f"/collections/{self.collection}", ok404=True)
        except VectorStoreError:
            return "unreachable"
        return "ok" if info else "empty (collection created on first use)"


_STORE: QdrantStore | None = None


def get_vector_store() -> QdrantStore | None:
    """The separate vector database when VECTOR_STORE=qdrant, else None (pgvector inside Supabase is used)."""
    global _STORE
    from ..config import get_settings

    s = get_settings()
    if s.vector_store.lower() != "qdrant":
        return None
    if not s.qdrant_url:
        raise VectorStoreError("VECTOR_STORE=qdrant needs QDRANT_URL")
    if _STORE is None:
        _STORE = QdrantStore(s.qdrant_url, s.qdrant_api_key, s.qdrant_collection, s.embedding_dim)
    return _STORE


def rrf(vector_hits: list[VectorHit], keyword_ids: list[int], min_similarity: float, limit: int, k: int = 60) -> list[tuple[int, float, float | None]]:
    """Reciprocal rank fusion of the vector ranking and the keyword ranking (as match_document_chunks does in SQL).
    A vector-only hit below min_similarity is dropped; a keyword hit is kept whatever its similarity.
    Returns (chunk_id, fused score, similarity or None) best first."""
    sim = {h.chunk_id: h.score for h in vector_hits}
    score: dict[int, float] = {}
    for r, h in enumerate(vector_hits, 1):
        score[h.chunk_id] = score.get(h.chunk_id, 0.0) + 1.0 / (k + r)
    kw = set()
    for r, cid in enumerate(keyword_ids, 1):
        kw.add(cid)
        score[cid] = score.get(cid, 0.0) + 1.0 / (k + r)
    kept = [(cid, s, sim.get(cid)) for cid, s in score.items() if cid in kw or sim.get(cid, 0.0) >= min_similarity]
    kept.sort(key=lambda t: -t[1])
    return kept[:limit]
