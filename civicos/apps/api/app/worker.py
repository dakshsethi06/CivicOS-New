"""Celery worker: background jobs and scheduled model runs.

    celery -A app.worker worker --loglevel=info          # runs queued jobs
    celery -A app.worker beat --loglevel=info            # schedules nightly retraining

Needs REDIS_URL. Without a worker the API runs jobs itself (see app/ops/runner.py).
"""
from celery import Celery
from celery.schedules import crontab

from .config import get_settings
from .ops import runner

settings = get_settings()
celery = Celery("civicos", broker=settings.redis_url or "redis://localhost:6379/0")
celery.conf.update(task_acks_late=True, worker_prefetch_multiplier=1, timezone="UTC",
                   beat_schedule={"nightly-retrain": {"task": "ops.nightly", "schedule": crontab(hour=20, minute=30)}})  # 02:00 IST


@celery.task(name="ops.run_job")
def run_job_task(job_id: str, org_id: str, user_id: str | None, kind: str) -> dict:
    return runner.run_job(job_id, org_id, user_id, kind)


@celery.task(name="ops.nightly")
def nightly() -> dict:
    """Retrains every organization's operations models on its latest readings."""
    started = {}
    for org_id in runner.organizations_with_data():
        try:
            job = runner.create_job(org_id, None, "scheduled")
            run_job_task.delay(job, org_id, None, "scheduled")
            started[org_id] = job
        except runner.JobBusy:
            started[org_id] = "busy"
    return started
