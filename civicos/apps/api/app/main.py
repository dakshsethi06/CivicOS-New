"""CivicOS API: the Python backend. The AI layer (RAG ingestion, retrieval, the hybrid assistant) and the operations
models (water, waste, traffic: training, route planning, simulation). Run: uvicorn app.main:app --reload"""
from typing import Any

from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from . import __version__
from .assistant.orchestrator import answer_question
from .auth import User, current_officer, current_user
from .config import Settings, get_settings
from .data import SqlData
from .db import as_user, get_engine
from .ops import jobs as ops_jobs
from .ops import runner
from .complaints import ai as complaint_ai
from .providers import ProviderError, get_chat_model, get_embedder, get_reranker, get_vision
from .rag.ingest import IngestError, embed_missing, ingest, sync_vector_store
from .rag.vectorstore import VectorStoreError, get_vector_store

app = FastAPI(title="CivicOS API", version=__version__,
              description="AI layer of CivicOS: document ingestion, semantic retrieval, the hybrid assistant, and the "
                          "water, waste and traffic models.")
app.add_middleware(CORSMiddleware, allow_origins=get_settings().cors_origins, allow_methods=["*"],
                   allow_headers=["authorization", "content-type"])


@app.exception_handler(DBAPIError)
def db_error(_: Request, exc: DBAPIError) -> JSONResponse:
    """Errors the database raises on purpose (P0001: plan limits, permissions) are shown; others are not leaked."""
    orig = getattr(exc, "orig", None)
    code = getattr(orig, "sqlstate", None)
    if code == "P0001":
        diag = getattr(orig, "diag", None)
        return JSONResponse({"detail": (diag.message_primary if diag else None) or str(orig)}, 400)
    if code == "42501":  # insufficient_privilege / RLS violation
        return JSONResponse({"detail": "You do not have permission to do this."}, 403)
    return JSONResponse({"detail": "Database error."}, 500)


def bearer(authorization: str = Header()) -> str:
    return authorization.split(" ", 1)[1].strip()


# ---------------------------------------------------------------------------------------------------------------
@app.get("/health")
def health(settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    db = "ok"
    try:
        with get_engine().connect() as conn:
            conn.execute(text("select 1"))
    except Exception:  # noqa: BLE001 - health reports, never raises
        db = "unreachable"
    try:
        store = get_vector_store()
        vectors = {"store": "qdrant", "status": store.status()} if store else {"store": "pgvector", "status": db}
    except VectorStoreError as e:
        vectors = {"store": "qdrant", "status": str(e)}
    return {"status": "ok" if db == "ok" else "degraded", "version": __version__, "database": db, "vectors": vectors,
            "llm": settings.gemini_model if settings.gemini_api_key else None,
            "embeddings": settings.embedding_model_id if settings.gemini_api_key else None}


# ---------------------------------------------------------------------------------------------------------------
class AskIn(BaseModel):
    question: str = Field(min_length=3, max_length=600)
    conversation_id: str | None = None


class AskOut(BaseModel):
    conversation_id: str
    answer: str
    mode: str
    citations: list[dict[str, Any]]
    tools: list[dict[str, Any]]
    note: str | None = None
    charts: list[dict[str, Any]] = []


@app.post("/v1/assistant/ask", response_model=AskOut)
def ask(body: AskIn, user: User = Depends(current_user), settings: Settings = Depends(get_settings)) -> AskOut:
    data = SqlData(user, get_vector_store())
    q = data.quota()
    if not q.get("allowed"):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS,
                            f"This workspace has used its {q.get('limit')} assistant questions for the month. "
                            "A City Administrator can change the plan in Settings.")
    a = answer_question(body.question.strip(), data, get_chat_model(), get_embedder(),
                        settings.rag_top_k, settings.rag_min_similarity, settings.max_tool_rounds,
                        get_reranker(), settings.rag_candidates)
    shown = a.answer + (f" ({a.note})" if a.note else "")
    conv = data.save(body.conversation_id, body.question.strip(), shown, a.citations, a.chunk_ids, a.fact_count,
                     a.mode, a.tools, a.charts)
    return AskOut(conversation_id=conv, answer=shown, mode=a.mode, citations=a.citations, tools=a.tools, note=a.note,
                  charts=a.charts)


# ---------------------------------------------------------------------------------------------------------------
@app.post("/v1/documents/{document_id}/ingest")
def ingest_document(document_id: str, user: User = Depends(current_officer), token: str = Depends(bearer),
                    settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    try:
        r = ingest(user, token, document_id, settings, get_embedder())
    except IngestError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e
    return {"document_id": r.document_id, "pages": r.pages, "chunks": r.chunks, "embedded": r.embedded, "warning": r.warning}


@app.post("/v1/documents/reindex")
def reindex(user: User = Depends(current_officer)) -> dict[str, Any]:
    """Embeds every chunk of this municipality that has no vector yet (or one from an older model)."""
    embedder = get_embedder()
    if embedder is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "No embedding model is configured (set GEMINI_API_KEY).")
    try:
        return {"embedded": embed_missing(user, embedder)}
    except ProviderError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Embedding failed: {e}") from e


@app.get("/v1/documents/search")
def search(q: str, k: int = 8, user: User = Depends(current_user), settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    """Retrieval only, for inspecting what the assistant would see. Scoped by RLS like everything else."""
    embedder = get_embedder()
    try:
        emb = embedder.embed_query(q) if embedder else None
    except ProviderError:
        emb = None                       # keyword search still works
    store = get_vector_store()
    hits = SqlData(user, store).match_chunks(q, emb, min(max(k, 1), 12), settings.rag_min_similarity, None)
    return {"semantic": emb is not None, "vector_store": "qdrant" if store else "pgvector",
            "hits": [{k_: v for k_, v in h.items() if k_ != "content"} for h in hits]}


@app.post("/v1/vector/sync")
def vector_sync(user: User = Depends(current_officer)) -> dict[str, Any]:
    """Rebuilds this organization's points in the separate vector database from the vectors in Postgres (no
    embedding calls). Use after switching VECTOR_STORE to qdrant, or if the index and Postgres have drifted."""
    store = get_vector_store()
    if store is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "VECTOR_STORE is pgvector: vectors are searched inside Supabase, nothing to sync.")
    try:
        n = sync_vector_store(user, store)
        return {"synced": n, "in_index": store.count(user.org_id)}
    except VectorStoreError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e)) from e


@app.post("/v1/documents/{document_id}/forget")
def document_forget(document_id: str, user: User = Depends(current_officer)) -> dict[str, Any]:
    """Removes a deleted document's points from the vector database. (Even before this runs, its passages can no
    longer be returned: every hit is re-read through Postgres, where the document is gone.)"""
    store = get_vector_store()
    if store is None:
        return {"removed": False, "reason": "pgvector: rows were deleted with the document"}
    try:
        store.delete_document(user.org_id, document_id)
    except VectorStoreError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e)) from e
    return {"removed": True}


# ---------------------------------------------------------------------------------------------------------- complaints
@app.post("/v1/complaints/{complaint_id}/analyse")
def complaint_analyse(complaint_id: str, user: User = Depends(current_user), token: str = Depends(bearer),
                      settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    """Category by meaning, duplicates by meaning within 150 m, and a photo check, recorded as suggestions.
    Anyone who can see the complaint (its submitter, or staff) may run it; the web app calls it on submission."""
    try:
        a = complaint_ai.analyse_complaint(user, token, complaint_id, settings, get_embedder(), get_vision())
    except LookupError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from e
    except ProviderError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"The AI service failed: {e}") from e
    c = a.classification
    return {"complaint_id": a.complaint_id, "notes": a.notes, "duplicates": a.duplicates, "image": a.image,
            "category": {"id": c.category_id, "name": c.category, "similarity": c.similarity, "margin": c.margin,
                         "scores": c.scores} if c else None}


@app.post("/v1/complaints/embed-missing")
def complaint_embed_missing(user: User = Depends(current_officer)) -> dict[str, Any]:
    """Embeds complaints submitted before AI analysis was switched on, so they can be matched as duplicates."""
    embedder = get_embedder()
    if embedder is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "No embedding model is configured (set GEMINI_API_KEY).")
    return {"embedded": complaint_ai.embed_missing(user, embedder)}


# --------------------------------------------------------------------------------------- operations: water, waste, traffic
def _require_admin(user: User) -> None:
    if user.role != "city_admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only a City Administrator can do this.")


def _require_feature(user: User, feature: str, what: str) -> None:
    with as_user(user) as conn:
        ok = conn.execute(text("select app.plan_feature(app.org_id(), :f)"), {"f": feature}).scalar()
    if not ok:
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED,
                            f"{what} is part of the Professional and Enterprise plans. A City Administrator can change "
                            "the plan in Settings (test mode, no payment).")


def _start(user: User, kind: str, background: BackgroundTasks) -> dict[str, Any]:
    try:
        job = runner.create_job(user.org_id, user.id, kind)
    except runner.JobBusy as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from e
    return {"job_id": job, "runs_on": runner.dispatch(job, user.org_id, user.id, kind, background)}


@app.post("/v1/ops/demo", status_code=202)
def ops_demo(background: BackgroundTasks, user: User = Depends(current_user)) -> dict[str, Any]:
    """Replaces this workspace's operations data with the labelled demonstration dataset, then trains every model.
    Takes about a minute; follow it in ops_status()."""
    _require_admin(user)
    return _start(user, "demo", background)


@app.post("/v1/ops/train", status_code=202)
def ops_train(background: BackgroundTasks, user: User = Depends(current_user)) -> dict[str, Any]:
    """Retrains the water, waste and traffic models on the latest readings and re-plans collection routes."""
    _require_admin(user)
    _require_feature(user, "predictions", "Retraining the predictive models")
    return _start(user, "train", background)


class SimulateIn(BaseModel):
    road_id: str
    action: str = Field(pattern="^(close|reduce_capacity|add_demand)$")
    capacity_factor: float = Field(0.5, ge=0.05, le=1.0)
    extra_trips: float = Field(1500, ge=0, le=20000)


@app.post("/v1/traffic/simulate")
def traffic_simulate(body: SimulateIn, user: User = Depends(current_officer)) -> dict[str, Any]:
    """What-if: re-assigns peak-hour traffic with one road closed, narrowed or loaded with extra trips. Simulated."""
    _require_feature(user, "predictions", "Traffic simulation")
    try:
        with as_user(user) as conn:
            return ops_jobs.simulate(conn, user.org_id, user.id, body.road_id, body.action, body.capacity_factor,
                                     body.extra_trips)
    except ValueError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from e


@app.get("/v1/me")
def me(user: User = Depends(current_user)) -> dict[str, Any]:
    with as_user(user) as conn:
        org = conn.execute(text("select name, plan_code from public.organizations where id = cast(:id as uuid)"),
                           {"id": user.org_id}).mappings().first()
    return {"id": user.id, "email": user.email, "role": user.role, "organization": dict(org) if org else None}
