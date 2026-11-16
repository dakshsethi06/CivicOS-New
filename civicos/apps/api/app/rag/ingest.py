"""Document ingestion: download -> extract -> clean -> chunk -> embed -> store, as the uploading officer."""
from dataclasses import dataclass
from typing import Any

import httpx
from sqlalchemy import text

from ..auth import User
from ..config import Settings
from ..db import as_user, vector_literal
from ..providers import Embedder, ProviderError
from .chunking import chunk_pages
from .extract import ExtractionError, extract


@dataclass
class IngestResult:
    document_id: str
    pages: int
    chunks: int
    embedded: bool
    warning: str | None = None


class IngestError(ValueError):
    pass


def load_document(user: User, document_id: str) -> dict[str, Any]:
    with as_user(user) as conn:
        row = conn.execute(
            text("select id, title, storage_path, mime_type, status from public.documents where id = cast(:id as uuid)"),
            {"id": document_id},
        ).mappings().first()
    if not row:
        raise IngestError("Document not found.")
    return dict(row)


def download(settings: Settings, token: str, path: str, bucket: str = "documents") -> bytes:
    """Reads the file from private Storage with the caller's own token, so Storage policies apply too."""
    url = f"{settings.supabase_url.rstrip('/')}/storage/v1/object/authenticated/{bucket}/{path}"
    r = httpx.get(url, headers={"authorization": f"Bearer {token}", "apikey": settings.supabase_anon_key}, timeout=60)
    if r.status_code != 200:
        raise IngestError(f"Could not read the uploaded file from storage ({r.status_code}).")
    return r.content


def mark_failed(user: User, document_id: str, message: str) -> None:
    with as_user(user) as conn:
        conn.execute(text("update public.documents set status = 'failed', error = :e, processed_at = now() where id = cast(:id as uuid)"),
                     {"id": document_id, "e": message[:500]})


def ingest(user: User, token: str, document_id: str, settings: Settings, embedder: Embedder | None) -> IngestResult:
    doc = load_document(user, document_id)
    try:
        data = download(settings, token, doc["storage_path"])
        pages = extract(data, doc["storage_path"], doc["mime_type"])
    except (IngestError, ExtractionError) as e:
        mark_failed(user, document_id, str(e))
        raise IngestError(str(e)) from e

    chunks = chunk_pages(pages, settings.chunk_size, settings.chunk_overlap)
    if not chunks:
        msg = "No text could be read from this file. Scanned PDFs without a text layer are not supported."
        mark_failed(user, document_id, msg)
        raise IngestError(msg)

    vectors: list[list[float]] | None = None
    warning = None
    if embedder is None:
        warning = "No embedding model is configured, so this document is searchable by keywords only."
    else:
        try:
            vectors = embedder.embed_documents([c.embedding_text() for c in chunks], title=doc["title"])
        except ProviderError as e:
            warning = f"Embedding failed ({e}); the document is searchable by keywords only. Re-index it later."

    with as_user(user) as conn:
        conn.execute(text("delete from public.document_chunks where document_id = cast(:id as uuid)"), {"id": document_id})
        ids = conn.execute(
            text("""
              insert into public.document_chunks (organization_id, document_id, page_number, chunk_index, content, section)
              select cast(:org as uuid), cast(:doc as uuid), t.p, t.i, t.c, t.s
                from unnest(cast(:pages as int[]), cast(:idx as int[]), cast(:contents as text[]), cast(:sections as text[])) as t(p, i, c, s)
              returning id, chunk_index"""),
            {"org": user.org_id, "doc": document_id, "pages": [c.page for c in chunks], "idx": [c.index for c in chunks],
             "contents": [c.content for c in chunks], "sections": [c.section for c in chunks]},
        ).all()
        if vectors is not None:
            by_index = {i: cid for cid, i in ids}
            conn.execute(
                text("""
                  insert into public.document_embeddings (chunk_id, organization_id, document_id, model, embedding)
                  select t.id, cast(:org as uuid), cast(:doc as uuid), :model, cast(t.e as extensions.vector)
                    from unnest(cast(:ids as bigint[]), cast(:embs as text[])) as t(id, e)"""),
                {"org": user.org_id, "doc": document_id, "model": embedder.model_id,  # type: ignore[union-attr]
                 "ids": [by_index[c.index] for c in chunks], "embs": [vector_literal(v) for v in vectors]},
            )
        conn.execute(
            text("""update public.documents
                       set status = 'ready', error = null, page_count = :pages, chunk_count = :n,
                           embedding_model = :model, processed_at = now()
                     where id = cast(:id as uuid)"""),
            {"id": document_id, "pages": len(pages), "n": len(chunks),
             "model": embedder.model_id if vectors is not None else None},  # type: ignore[union-attr]
        )
    return IngestResult(document_id, len(pages), len(chunks), vectors is not None, warning)


def embed_missing(user: User, embedder: Embedder, limit: int = 2000) -> int:
    """Embeds chunks that have no vector yet (documents added before semantic search, or embedded by another model)."""
    with as_user(user) as conn:
        rows = conn.execute(text("""
            select c.id, c.document_id, c.content, c.section, d.title
              from public.document_chunks c
              join public.documents d on d.id = c.document_id
              left join public.document_embeddings e on e.chunk_id = c.id
             where e.chunk_id is null or e.model <> :model
             order by c.document_id, c.chunk_index
             limit :lim"""), {"model": embedder.model_id, "lim": limit}).mappings().all()
    done = 0
    by_doc: dict[str, list[Any]] = {}
    for r in rows:
        by_doc.setdefault(str(r["document_id"]), []).append(r)
    for doc_id, items in by_doc.items():
        texts = [f"{r['section']}\n\n{r['content']}" if r["section"] else r["content"] for r in items]
        vecs = embedder.embed_documents(texts, title=items[0]["title"])
        with as_user(user) as conn:
            conn.execute(text("delete from public.document_embeddings where chunk_id = any(cast(:ids as bigint[]))"),
                         {"ids": [r["id"] for r in items]})
            conn.execute(text("""
                insert into public.document_embeddings (chunk_id, organization_id, document_id, model, embedding)
                select t.id, cast(:org as uuid), cast(:doc as uuid), :model, cast(t.e as extensions.vector)
                  from unnest(cast(:ids as bigint[]), cast(:embs as text[])) as t(id, e)"""),
                {"org": user.org_id, "doc": doc_id, "model": embedder.model_id,
                 "ids": [r["id"] for r in items], "embs": [vector_literal(v) for v in vecs]})
            conn.execute(text("update public.documents set embedding_model = :m where id = cast(:id as uuid)"),
                         {"m": embedder.model_id, "id": doc_id})
        done += len(items)
    return done
