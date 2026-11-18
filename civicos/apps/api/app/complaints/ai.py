"""AI on complaints: category by meaning, duplicates by meaning and distance, a photo check, written back as
suggestions (supabase/migrations/0019_complaint_ai.sql). An officer still confirms everything.

Classification: the complaint and each category's description, examples and name are embedded with Gemini
(semantic-similarity task). A category's score is its best cosine similarity to the complaint; the top category is
suggested only when it is both similar enough and clearly ahead of the next. This needs no labelled training data,
which a new deployment does not have; once officers have confirmed enough complaints, the same scores can be
calibrated against their decisions.

Photo: Gemini vision reports, in a fixed JSON shape, whether visible road damage (a pothole, cracks, broken paving)
is present, how severe it looks, and whether the photo matches the description. Its own severity rating is shown as
the model's judgement, not as a calibrated probability.
"""
from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import text

from ..auth import User
from ..config import Settings
from ..db import as_org, as_user, vector_literal
from ..providers import Embedder, ProviderError, Vision
from ..rag.ingest import IngestError, download

# Thresholds measured on gemini-embedding-001 (768 dimensions, semantic-similarity task): unrelated civic texts score
# about 0.74-0.84, the same problem worded differently 0.92-0.96, different problems at the same place up to 0.89.
MIN_SIMILARITY = 0.80        # below this no category is suggested by meaning
MIN_MARGIN = 0.02            # the best category must lead the next by this much
DUPLICATE_RADIUS_M = 150
REPORT_SIMILARITY = 0.88     # listed for the officer as possibly related
LINK_SIMILARITY = 0.915      # linked as a possible duplicate (same category only; applied in complaint_ai_apply)

IMAGE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "road_damage": {"type": "boolean", "description": "Visible damage to a road or footpath surface"},
        "damage_type": {"type": "string", "enum": ["pothole", "cracks", "broken_paving", "sunken_road", "none", "other"]},
        "severity": {"type": "string", "enum": ["none", "low", "medium", "high"],
                     "description": "high = a hazard to vehicles or people now (deep or wide pothole, open hole, collapse)"},
        "other_issue": {"type": "string", "enum": ["garbage", "water_leak", "waterlogging", "sewage", "streetlight", "none", "other"],
                        "description": "Another civic problem visible in the photo, if any"},
        "matches_description": {"type": "boolean", "description": "The photo plausibly shows the problem described"},
        "summary": {"type": "string", "description": "One plain sentence: what the photo shows"},
    },
    "required": ["road_damage", "damage_type", "severity", "other_issue", "matches_description", "summary"],
}

IMAGE_PROMPT = """You check photos attached to civic complaints for a municipal corporation.
The complaint says: "{description}"
Look only at what is visible. Report whether there is visible damage to a road or footpath surface (a pothole, cracks,
broken paving, a sunken road), how severe it looks, any other civic problem visible, and whether the photo plausibly
shows the problem described. If the photo is unclear, unrelated or not of a street, say none/false. Do not guess."""


@dataclass
class Category:
    id: str
    code: str
    name: str
    description: str | None
    examples: list[str] = field(default_factory=list)

    def prototypes(self) -> list[str]:
        out = [self.name]
        if self.description:
            out.append(f"{self.name}: {self.description}")
        return out + [e for e in self.examples if e]


@dataclass
class Classification:
    category_id: str | None
    category: str | None
    similarity: float
    margin: float
    scores: dict[str, float]


def _cos(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b)) / ((math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))) or 1.0)


_PROTO_CACHE: dict[str, list[float]] = {}


def _proto_vectors(embedder: Embedder, texts: list[str]) -> list[list[float]]:
    keys = [hashlib.sha1(f"{embedder.model_id}|{t}".encode()).hexdigest() for t in texts]
    missing = [t for k, t in zip(keys, texts) if k not in _PROTO_CACHE]
    if missing:
        for t, v in zip(missing, embedder.embed_similarity(missing)):
            _PROTO_CACHE[hashlib.sha1(f"{embedder.model_id}|{t}".encode()).hexdigest()] = v
    return [_PROTO_CACHE[k] for k in keys]


def classify(vector: list[float], categories: list[Category], embedder: Embedder) -> Classification:
    scored = []
    for c in categories:
        if c.code == "other":
            continue
        protos = _proto_vectors(embedder, c.prototypes())
        scored.append((max(_cos(vector, p) for p in protos), c))
    if not scored:
        return Classification(None, None, 0.0, 0.0, {})
    scored.sort(key=lambda s: -s[0])
    best, cat = scored[0]
    margin = best - (scored[1][0] if len(scored) > 1 else 0.0)
    scores = {c.code: round(s, 3) for s, c in scored}
    if best < MIN_SIMILARITY or margin < MIN_MARGIN:
        return Classification(None, None, round(best, 3), round(margin, 3), scores)
    return Classification(cat.id, cat.name, round(best, 3), round(margin, 3), scores)


def analyse_photo(vision: Vision, image: bytes, mime: str, description: str) -> dict[str, Any]:
    out = vision.analyse_image(image, mime, IMAGE_PROMPT.format(description=description[:600].replace('"', "'")), IMAGE_SCHEMA)
    clean = {k: out.get(k) for k in IMAGE_SCHEMA["properties"]}
    clean["road_damage"] = bool(clean.get("road_damage"))
    clean["matches_description"] = bool(clean.get("matches_description")) if clean.get("matches_description") is not None else None
    clean["model"] = getattr(vision, "name", None)
    clean["note"] = "The vision model's own judgement of the photo, not a measured or calibrated rating."
    return clean


@dataclass
class Analysis:
    complaint_id: str
    classification: Classification | None
    duplicates: list[dict]
    image: dict | None
    notes: list[str]


def _mime(path: str) -> str:
    p = path.lower()
    return "image/png" if p.endswith(".png") else "image/webp" if p.endswith(".webp") else "image/jpeg"


def analyse_complaint(user: User, token: str, complaint_id: str, settings: Settings, embedder: Embedder | None,
                      vision: Vision | None) -> Analysis:
    # 1. read the complaint as the caller: if they cannot see it, nothing happens
    with as_user(user) as conn:
        c = conn.execute(text("""select c.id::text, c.organization_id::text as org, c.description, c.photo_path, c.lat, c.lon,
                                        cc.name as category
                                   from public.complaints c left join public.complaint_categories cc on cc.id = c.category_id
                                  where c.id = cast(:id as uuid)"""), {"id": complaint_id}).mappings().first()
    if not c:
        raise LookupError("Complaint not found.")
    org = c["org"]

    classification, duplicates, image = None, [], None
    with as_org(org) as conn:
        cats = [Category(r["id"], r["code"], r["name"], r["description"], list(r["examples"] or []))
                for r in conn.execute(text("""select id::text, code, name, description, examples from public.complaint_categories
                                               order by code""")).mappings()]

    # 2. embedding, category by meaning, duplicates by meaning within 150 m
    if embedder is not None:
        vec = embedder.embed_similarity([c["description"]])[0]
        classification = classify(vec, cats, embedder)
        with as_org(org) as conn:
            conn.execute(text("""insert into public.complaint_embeddings (complaint_id, organization_id, model, embedding)
                                 values (cast(:id as uuid), cast(:org as uuid), :m, cast(:e as vector))
                                 on conflict (complaint_id) do update set model = excluded.model, embedding = excluded.embedding"""),
                         {"id": complaint_id, "org": org, "m": embedder.model_id, "e": vector_literal(vec)})
            if c["lat"] is not None:
                duplicates = [
                    {"id": str(r["id"]), "reference": r["reference"], "status": r["status"], "category": r["category"],
                     "same_category": r["category"] is not None and r["category"] == (classification.category or c["category"]),
                     "distance_m": r["distance_m"], "similarity": round(float(r["similarity"]), 3)}
                    for r in conn.execute(text("""select * from public.complaint_similar(cast(:id as uuid), cast(:e as vector), :r, 5)"""),
                                          {"id": complaint_id, "e": vector_literal(vec), "r": DUPLICATE_RADIUS_M}).mappings()
                    if float(r["similarity"]) >= REPORT_SIMILARITY]

    # 3. the photo
    if vision is not None and c["photo_path"]:
        try:
            data = download(settings, token, c["photo_path"], bucket="complaint-photos")
            image = analyse_photo(vision, data, _mime(c["photo_path"]), c["description"])
        except (IngestError, ProviderError) as e:
            image = {"error": str(e)[:200]}

    # 4. record the suggestions (as the organization's analysis service, under RLS)
    with as_org(org) as conn:
        res = conn.execute(text("""select public.complaint_ai_apply(cast(:id as uuid), :model, cast(:cat as uuid), :sim,
                                          cast(:scores as jsonb), cast(:dups as jsonb), cast(:img as jsonb))"""),
                           {"id": complaint_id, "model": ", ".join(x for x in (embedder.model_id if embedder else None,
                                                                               (image or {}).get("model")) if x) or None,
                            "cat": classification.category_id if classification else None,
                            "sim": classification.similarity if classification else None,
                            "scores": json.dumps(classification.scores) if classification else None,
                            "dups": json.dumps(duplicates), "img": json.dumps(image) if image else None}).scalar()
    return Analysis(complaint_id, classification, duplicates, image, list((res or {}).get("notes", [])))


def embed_missing(user: User, embedder: Embedder, limit: int = 500) -> int:
    """Stores embeddings for complaints that have none, so older complaints can be found as duplicates."""
    with as_user(user) as conn:
        rows = conn.execute(text("""select c.id::text, c.description from public.complaints c
                                     where not exists (select 1 from public.complaint_embeddings e where e.complaint_id = c.id)
                                     order by c.created_at desc limit :n"""), {"n": limit}).all()
    if not rows:
        return 0
    vecs = embedder.embed_similarity([r[1] for r in rows])
    with as_org(user.org_id) as conn:
        for (cid, _), v in zip(rows, vecs):
            conn.execute(text("""insert into public.complaint_embeddings (complaint_id, organization_id, model, embedding)
                                 values (cast(:id as uuid), cast(:org as uuid), :m, cast(:e as vector))
                                 on conflict (complaint_id) do nothing"""),
                         {"id": cid, "org": user.org_id, "m": embedder.model_id, "e": vector_literal(v)})
    return len(rows)
