import time

import jwt
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.auth import decode_token, user_from_claims
from app.config import get_settings
from app.main import app

SECRET = "test-secret-with-at-least-thirty-two-bytes!"


def token(**overrides):
    claims = {"sub": "a0000000-0000-0000-0000-000000000002", "aud": "authenticated", "exp": int(time.time()) + 600,
              "email": "officer@example.org", "role": "authenticated",
              "app_metadata": {"org_id": "11111111-1111-1111-1111-111111111111", "role": "dept_officer"}}
    claims.update(overrides)
    return jwt.encode(claims, SECRET, algorithm="HS256")


def test_hs256_token_verified_and_mapped_to_user():
    user = user_from_claims(decode_token(token(), get_settings()))
    assert user.role == "dept_officer" and user.is_officer and user.org_id.startswith("1111")


@pytest.mark.parametrize("bad", [
    token(exp=int(time.time()) - 10),                     # expired
    token(aud="anon"),                                    # wrong audience
    jwt.encode({"sub": "x", "aud": "authenticated", "exp": int(time.time()) + 60}, "another-secret-of-32-bytes-or-more", algorithm="HS256"),
    "not-a-token",
])
def test_bad_tokens_rejected(bad):
    with pytest.raises(HTTPException) as e:
        decode_token(bad, get_settings())
    assert e.value.status_code == 401


def test_user_without_organization_rejected():
    with pytest.raises(HTTPException) as e:
        user_from_claims(decode_token(token(app_metadata={}), get_settings()))
    assert e.value.status_code == 403


client = TestClient(app)


def test_endpoints_require_a_session():
    assert client.post("/v1/assistant/ask", json={"question": "hello there"}).status_code == 401
    assert client.post("/v1/documents/x/ingest").status_code == 401


def test_residents_cannot_ingest_or_reindex():
    resident = token(app_metadata={"org_id": "11111111-1111-1111-1111-111111111111", "role": "citizen"})
    h = {"authorization": f"Bearer {resident}"}
    assert client.post("/v1/documents/x/ingest", headers=h).status_code == 403
    assert client.post("/v1/documents/reindex", headers=h).status_code == 403


def test_operations_endpoints_are_role_gated():
    officer = {"authorization": f"Bearer {token()}"}
    resident = {"authorization": "Bearer " + token(app_metadata={"org_id": "11111111-1111-1111-1111-111111111111", "role": "citizen"})}
    assert client.post("/v1/ops/demo").status_code == 401
    assert client.post("/v1/ops/demo", headers=officer).status_code == 403          # administrators only
    assert client.post("/v1/ops/train", headers=officer).status_code == 403
    assert client.post("/v1/traffic/simulate", headers=resident, json={"road_id": "x", "action": "close"}).status_code == 403
    assert client.post("/v1/traffic/simulate", headers=officer, json={"road_id": "x", "action": "explode"}).status_code == 422


def test_health_reports_without_crashing_when_db_is_down():
    r = client.get("/health")
    assert r.status_code == 200 and r.json()["database"] == "unreachable" and r.json()["llm"] is None
