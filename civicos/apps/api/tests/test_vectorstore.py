"""The Qdrant client against an in-memory stand-in that speaks the same REST API, and rank fusion."""
import json
import math
import re

import httpx
import pytest

from app.rag.vectorstore import QdrantStore, VectorHit, VectorStoreError, rrf


class FakeQdrant:
    """Implements the Qdrant REST calls QdrantStore makes: collections, payload indexes, upsert, filtered search,
    filtered delete and count. Cosine scores, exact match filters."""

    def __init__(self):
        self.collections: dict[str, dict] = {}
        self.indexes: dict[str, set] = {}
        self.calls: list[tuple[str, str]] = []

    @staticmethod
    def _match(payload, flt):
        return all(payload.get(c["key"]) == c["match"]["value"] for c in (flt or {}).get("must", []))

    @staticmethod
    def _cos(a, b):
        return sum(x * y for x, y in zip(a, b)) / (math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b)) or 1)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path, method = request.url.path, request.method
        self.calls.append((method, path))
        body = json.loads(request.content) if request.content else {}
        m = re.match(r"^/collections/([^/]+)(/.*)?$", path)
        name, rest = m.group(1), m.group(2) or ""
        col = self.collections.get(name)
        if rest == "" and method == "GET":
            return httpx.Response(200, json={"result": {"config": {"params": {"vectors": col["vectors"]}}}}) if col else httpx.Response(404, json={})
        if rest == "" and method == "PUT":
            self.collections[name] = {"vectors": body["vectors"], "points": {}}
            return httpx.Response(200, json={"result": True})
        if col is None:
            return httpx.Response(404, json={"status": {"error": "Not found"}})
        if rest == "/index":
            self.indexes.setdefault(name, set()).add(body["field_name"])
            return httpx.Response(200, json={"result": {}})
        if rest == "/points" and method == "PUT":
            for p in body["points"]:
                if len(p["vector"]) != col["vectors"]["size"]:
                    return httpx.Response(400, json={"status": {"error": "Wrong input: Vector dimension error"}})
                col["points"][p["id"]] = p
            return httpx.Response(200, json={"result": {"status": "completed"}})
        if rest == "/points/search":
            pts = [p for p in col["points"].values() if self._match(p["payload"], body.get("filter"))]
            scored = sorted(({"id": p["id"], "score": self._cos(body["vector"], p["vector"])} for p in pts), key=lambda x: -x["score"])
            return httpx.Response(200, json={"result": scored[: body["limit"]]})
        if rest == "/points/delete":
            for pid in [i for i, p in col["points"].items() if self._match(p["payload"], body["filter"])]:
                del col["points"][pid]
            return httpx.Response(200, json={"result": {"status": "completed"}})
        if rest == "/points/count":
            return httpx.Response(200, json={"result": {"count": sum(self._match(p["payload"], body["filter"]) for p in col["points"].values())}})
        return httpx.Response(400, json={"status": {"error": f"unexpected {method} {path}"}})


def store(fake, dim=3):
    return QdrantStore("http://qdrant.test", "key", "chunks", dim, client=httpx.Client(base_url="http://qdrant.test", transport=httpx.MockTransport(fake)))


def pt(i, v, org="A", doc="d1", access="staff", category="Regulation"):
    return {"id": i, "vector": v, "payload": {"organization_id": org, "document_id": doc, "access_level": access, "category": category, "model": "m"}}


def test_creates_collection_and_indexes_once():
    fake = FakeQdrant()
    s = store(fake)
    s.upsert([pt(1, [1, 0, 0])])
    s.upsert([pt(2, [0, 1, 0])])
    assert fake.collections["chunks"]["vectors"] == {"size": 3, "distance": "Cosine"}
    assert fake.indexes["chunks"] == {"organization_id", "document_id", "access_level", "category"}
    assert sum(1 for m, p in fake.calls if m == "PUT" and p == "/collections/chunks") == 1


def test_search_never_crosses_organizations_and_respects_access_and_category():
    fake = FakeQdrant()
    s = store(fake)
    s.upsert([pt(1, [1, 0, 0], org="A", access="staff"), pt(2, [0.9, 0.1, 0], org="A", access="public"),
              pt(3, [1, 0, 0], org="B", access="public"), pt(4, [1, 0.05, 0], org="A", access="public", category="Notice")])
    assert {h.chunk_id for h in s.search("A", [1, 0, 0])} == {1, 2, 4}
    assert {h.chunk_id for h in s.search("A", [1, 0, 0], public_only=True)} == {2, 4}
    assert [h.chunk_id for h in s.search("A", [1, 0, 0], category="Notice")] == [4]
    assert [h.chunk_id for h in s.search("B", [1, 0, 0])] == [3]
    top = s.search("A", [1, 0, 0])[0]
    assert top.chunk_id == 1 and top.score == pytest.approx(1.0)


def test_delete_document_and_organization_and_count():
    fake = FakeQdrant()
    s = store(fake)
    s.upsert([pt(1, [1, 0, 0], doc="d1"), pt(2, [0, 1, 0], doc="d2"), pt(3, [0, 0, 1], org="B", doc="d1")])
    s.delete_document("A", "d1")
    assert s.count("A") == 1 and s.count("B") == 1        # B's document with the same id is untouched
    s.delete_organization("A")
    assert s.count("A") == 0 and s.count("B") == 1


def test_dimension_mismatch_and_unreachable_are_reported():
    fake = FakeQdrant()
    store(fake, dim=3).upsert([pt(1, [1, 0, 0])])
    with pytest.raises(VectorStoreError, match="3-dimensional"):
        store(fake, dim=768).ensure()

    def down(request):
        raise httpx.ConnectError("refused")

    s = QdrantStore("http://x", None, "c", 3, client=httpx.Client(base_url="http://x", transport=httpx.MockTransport(down)))
    with pytest.raises(VectorStoreError, match="could not be reached"):
        s.search("A", [1, 0, 0])
    assert s.status() == "unreachable"


def test_rank_fusion_keeps_keyword_hits_and_drops_weak_vector_only_hits():
    vec = [VectorHit(10, 0.82), VectorHit(11, 0.71), VectorHit(12, 0.40)]
    out = rrf(vec, keyword_ids=[12, 13], min_similarity=0.55, limit=8)
    ids = [cid for cid, _, _ in out]
    assert 12 in ids and 13 in ids                 # keyword matches stay even with low similarity
    assert ids[0] == 12                            # in both rankings: fused score highest
    assert 11 in ids and 10 in ids
    out = rrf([VectorHit(20, 0.30)], keyword_ids=[], min_similarity=0.55, limit=8)
    assert out == []                               # vector-only and below the floor: dropped
    sims = {cid: s for cid, _, s in rrf(vec, [13], 0.55, 8)}
    assert sims[13] is None and sims[10] == 0.82
