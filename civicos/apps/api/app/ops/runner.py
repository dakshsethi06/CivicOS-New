"""Running operations jobs in the background.

A job row in ops_jobs records each run, so the app can show its progress. With REDIS_URL set, jobs go to the Celery
worker (app/worker.py), which also retrains every organization's models nightly. Without it, the API runs the job in
a background thread of its own process, which suits a single small instance; scheduled retraining then needs a cron
call to POST /v1/ops/train.
"""
from __future__ import annotations

import json
import logging
import traceback
from datetime import datetime, timedelta, timezone

from sqlalchemy import text

from ..db import as_org, get_engine
from . import jobs

log = logging.getLogger("civicos.ops")
STALE = timedelta(minutes=45)                 # a job "running" for longer than this is assumed dead


class JobBusy(Exception):
    pass


def create_job(org_id: str, user_id: str | None, kind: str) -> str:
    with as_org(org_id, user_id) as conn:
        busy = conn.execute(text("""
            select id from ops_jobs where organization_id = cast(:org as uuid) and status in ('queued', 'running')
               and created_at > :since limit 1"""), {"org": org_id, "since": datetime.now(timezone.utc) - STALE}).scalar()
        if busy:
            raise JobBusy("A job is already running for this workspace. Wait for it to finish.")
        return conn.execute(text("""
            insert into ops_jobs (organization_id, kind, created_by) values (cast(:org as uuid), :kind, cast(:uid as uuid))
            returning id::text"""), {"org": org_id, "kind": kind, "uid": user_id}).scalar_one()


def _update(org_id: str, job_id: str, **fields) -> None:
    sets = ", ".join(f"{k} = :{k}" if k != "result" else "result = cast(:result as jsonb)" for k in fields)
    with as_org(org_id) as conn:
        conn.execute(text(f"update ops_jobs set {sets} where id = cast(:id as uuid)"), {"id": job_id, **fields})


def run_job(job_id: str, org_id: str, user_id: str | None, kind: str) -> dict:
    """Builds the demonstration dataset (kind 'demo'), then trains water, waste and traffic, each in its own
    transaction. Safe to call from a thread or a Celery worker."""
    result: dict = {}
    try:
        if kind == "demo":
            _update(org_id, job_id, status="running", step="Building the demonstration dataset")
            with as_org(org_id, user_id) as conn:
                result["dataset"] = jobs.seed_demo(conn, org_id, user_id)
        for name, fn, label in (("water", jobs.train_water, "Training water models"),
                                ("waste", jobs.train_waste, "Training waste models and planning routes"),
                                ("traffic", jobs.train_traffic, "Training traffic models")):
            _update(org_id, job_id, status="running", step=label)
            try:
                with as_org(org_id) as conn:
                    result[name] = fn(conn, org_id)
            except Exception as e:  # noqa: BLE001 - one module failing does not stop the others
                log.exception("ops job %s: %s failed", job_id, name)
                result[name] = {"error": f"{type(e).__name__}: {e}"}
        # recommendations draw on the new model outputs
        try:
            with as_org(org_id) as conn:
                result["recommendations"] = conn.execute(text("select public.refresh_recommendations()")).scalar()
        except Exception as e:  # noqa: BLE001
            result["recommendations"] = {"error": f"{type(e).__name__}: {e}"}
        failed = [k for k in ("water", "waste", "traffic") if isinstance(result.get(k), dict) and "error" in result[k]]
        _update(org_id, job_id, status="failed" if len(failed) == 3 else "done", step=None,
                result=json.dumps(result, default=str), finished_at=datetime.now(timezone.utc),
                error=f"Failed: {', '.join(failed)}" if failed else None)
    except Exception as e:  # noqa: BLE001 - recorded on the job
        log.error("ops job %s failed: %s", job_id, traceback.format_exc())
        _update(org_id, job_id, status="failed", step=None, error=f"{type(e).__name__}: {e}",
                finished_at=datetime.now(timezone.utc), result=json.dumps(result, default=str))
    return result


def organizations_with_data() -> list[str]:
    """For the nightly schedule: organizations that have operations data. Reads only ids, as the database owner."""
    with get_engine().connect() as conn:
        return [r[0] for r in conn.execute(text("select organization_id::text from public.ops_datasets")).all()]


def dispatch(job_id: str, org_id: str, user_id: str | None, kind: str, background=None) -> str:
    """Queues the job on Celery if configured, else on the API's own background tasks. Returns where it went."""
    from ..config import get_settings
    if get_settings().redis_url:
        from ..worker import run_job_task
        run_job_task.delay(job_id, org_id, user_id, kind)
        return "worker"
    if background is not None:
        background.add_task(run_job, job_id, org_id, user_id, kind)
        return "api"
    run_job(job_id, org_id, user_id, kind)
    return "inline"
