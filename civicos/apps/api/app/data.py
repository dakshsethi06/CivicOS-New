"""Read access for the assistant's tools, as the signed-in user. Each method is one short transaction under RLS.

All queries are fixed and parameterised: the question only fills parameters, it never becomes SQL.
"""
from typing import Any, Protocol

from sqlalchemy import text

from .auth import User
from .db import as_user, vector_literal
from .rag.vectorstore import QdrantStore, rrf


class DataAccess(Protocol):
    def match_chunks(self, query: str, embedding: list[float] | None, k: int, min_similarity: float,
                     category: str | None) -> list[dict[str, Any]]: ...
    def facts(self, question: str) -> list[dict[str, Any]]: ...
    def ward_profile(self, ward: str) -> dict[str, Any] | None: ...
    def complaint_summary(self, ward: str | None) -> dict[str, Any]: ...
    def quota(self) -> dict[str, Any]: ...
    def ops(self, module: str, ward: str | None) -> dict[str, Any]: ...
    def nearby(self, lon: float, lat: float, radius_m: int) -> dict[str, Any]: ...
    def complaint_location(self, reference: str) -> dict[str, Any] | None: ...
    def save(self, conversation: str | None, question: str, answer: str, citations: list[dict[str, Any]],
             chunk_ids: list[int], fact_count: int, mode: str, tools: list[dict[str, Any]],
             charts: list[dict[str, Any]] | None = None) -> str: ...


class SqlData:
    def __init__(self, user: User, store: QdrantStore | None = None):
        self.user, self.store = user, store

    def match_chunks(self, query, embedding, k, min_similarity, category):
        if self.store is not None and embedding is not None:
            return self._match_with_store(query, embedding, k, min_similarity, category)
        with as_user(self.user) as conn:
            return conn.execute(
                text("""select public.match_document_chunks(:q, cast(:emb as extensions.vector), :k,
                                                            cast(:min as float8), :cat)"""),
                {"q": query, "emb": vector_literal(embedding) if embedding else None, "k": k, "min": min_similarity,
                 "cat": category},
            ).scalar() or []

    def _match_with_store(self, query, embedding, k, min_similarity, category):
        """Vector search in the separate vector database, keyword search in Postgres, fused by reciprocal rank; then the
        chunks are read back through Row Level Security, which drops anything the caller may not see."""
        hits = self.store.search(self.user.org_id, embedding, limit=40, public_only=self.user.role == "citizen", category=category)
        with as_user(self.user) as conn:
            keyword = conn.execute(
                text("select public.match_document_chunks(:q, null, 12, 0, :cat)"), {"q": query, "cat": category}).scalar() or []
            fused = rrf(hits, [h["chunk_id"] for h in keyword], min_similarity, min(max(k, 1), 16))
            if not fused:
                return []
            rows = conn.execute(text("select public.document_chunks_by_ids(cast(:ids as bigint[]), :q)"),
                                {"ids": [cid for cid, _, _ in fused], "q": query}).scalar() or []
        by_id = {r["chunk_id"]: r for r in rows}
        out = []
        for cid, score, sim in fused:
            r = by_id.get(cid)
            if r is not None:                 # not visible to this user under RLS: dropped
                out.append({**r, "score": round(score, 5), "similarity": round(sim, 4) if sim is not None else None})
        return out

    def facts(self, question):
        with as_user(self.user) as conn:
            return conn.execute(text("select public.assistant_facts(:q)"), {"q": question}).scalar() or []

    def ward_profile(self, ward):
        with as_user(self.user) as conn:
            return conn.execute(text("""
                select to_jsonb(w) || jsonb_build_object('year', y.y)
                  from (select max(year) as y from public.civic_indicators where metric = 'complaints_registered') y,
                       lateral public.ward_stats(y.y, null::text) w
                 where upper(w.code) = upper(:ward)"""), {"ward": ward.strip()}).scalar()

    def complaint_summary(self, ward):
        with as_user(self.user) as conn:
            return conn.execute(text("select public.complaint_summary(:w)"), {"w": ward}).scalar() or {}

    def quota(self):
        with as_user(self.user) as conn:
            return conn.execute(text("select public.assistant_quota()")).scalar()

    def ops(self, module, ward):
        with as_user(self.user) as conn:
            return conn.execute(text("select public.assistant_ops(:m, :w)"), {"m": module, "w": ward}).scalar() or {}

    def nearby(self, lon, lat, radius_m):
        with as_user(self.user) as conn:
            return conn.execute(text("select public.assistant_nearby(:lon, :lat, :r)"),
                                {"lon": lon, "lat": lat, "r": radius_m}).scalar() or {}

    def complaint_location(self, reference):
        with as_user(self.user) as conn:
            row = conn.execute(text("""select reference, lon, lat from public.complaints
                                        where upper(reference) = upper(:r) and lat is not null"""),
                               {"r": reference.strip()}).mappings().first()
        return dict(row) if row else None

    def save(self, conversation, question, answer, citations, chunk_ids, fact_count, mode, tools, charts=None):
        import json

        with as_user(self.user) as conn:
            return str(conn.execute(
                text("""select public.assistant_save(cast(:c as uuid), :q, :a, cast(:cit as jsonb), cast(:chunks as bigint[]),
                                                     :n, :mode, cast(:tools as jsonb), cast(:charts as jsonb))"""),
                {"c": conversation, "q": question, "a": answer, "cit": json.dumps(citations), "chunks": chunk_ids,
                 "n": fact_count, "mode": mode, "tools": json.dumps(tools), "charts": json.dumps(charts or [])},
            ).scalar())
