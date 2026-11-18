"""Complaint AI without network or database: classification by meaning and the photo result's shape."""
import math

from app.complaints import ai
from app.complaints.ai import Category, classify


class BagEmbedder:
    """Deterministic stand-in for an embedding model: a normalised bag of words over a small vocabulary, so texts
    sharing meaning-bearing words are close. Enough to test the decision rules, not the model."""
    model_id = "bag@test"
    VOCAB = ["pothole", "road", "gaddha", "crater", "water", "pipe", "leak", "burst", "garbage", "bin", "kachra", "waste",
             "light", "dark", "lamp", "drain", "flood", "sewage", "manhole", "park", "toilet"]
    SYN = {"gaddha": "pothole", "kachra": "garbage", "paani": "water", "potholes": "pothole", "lights": "light"}

    def _vec(self, t: str) -> list[float]:
        words = [self.SYN.get(w.strip(".,!?").lower(), w.strip(".,!?").lower()) for w in t.split()]
        v = [float(sum(1 for w in words if w == k)) for k in self.VOCAB]
        # other words land in hashed dimensions, weakly, so unrelated texts are not identical
        other = [0.0] * 32
        for w in words:
            if w not in self.VOCAB and len(w) > 3:
                other[sum(map(ord, w)) % 32] += 0.3
        v += other
        n = math.sqrt(sum(x * x for x in v)) or 1.0
        return [x / n for x in v]

    def embed_similarity(self, texts):
        return [self._vec(t) for t in texts]


CATS = [
    Category("c1", "road_damage", "Road damage", "potholes cracks road surface", ["big pothole on the road"]),
    Category("c2", "water_leakage", "Water leakage", "water pipe leak burst", ["water pipe burst"]),
    Category("c3", "garbage_overflow", "Garbage overflow", "garbage bin waste", ["garbage bin overflowing"]),
    Category("c4", "streetlight", "Streetlight malfunction", "light lamp dark", ["street light not working, dark"]),
    Category("c9", "other", "Other", "anything else", []),
]


def test_classifies_by_meaning_including_local_words(monkeypatch):
    # the stand-in embedder has its own similarity scale; the real thresholds are set for Gemini's
    monkeypatch.setattr(ai, "MIN_SIMILARITY", 0.4)
    e = BagEmbedder()
    r = classify(e.embed_similarity(["huge gaddha near the station, two-wheelers falling"])[0], CATS, e)
    assert r.category_id == "c1" and r.similarity > 0.4 and r.margin > 0
    r = classify(e.embed_similarity(["kachra not lifted, bin full"])[0], CATS, e)
    assert r.category_id == "c3"
    assert "other" not in r.scores                     # "Other" is never suggested by meaning


def test_no_suggestion_when_nothing_is_close_or_it_is_a_tie(monkeypatch):
    monkeypatch.setattr(ai, "MIN_SIMILARITY", 0.4)
    e = BagEmbedder()
    r = classify(e.embed_similarity(["the neighbours are noisy"])[0], CATS, e)
    assert r.category_id is None
    r = classify(e.embed_similarity(["water pipe burst and garbage bin overflowing"])[0], CATS, e)
    assert r.category_id is None or r.margin >= ai.MIN_MARGIN


def test_photo_result_is_normalised_and_labelled():
    class FakeVision:
        name = "vision@test"

        def analyse_image(self, image, mime, prompt, schema):
            assert "gaddha" in prompt and mime == "image/jpeg" and schema["required"]
            return {"road_damage": True, "damage_type": "pothole", "severity": "high", "other_issue": "none",
                    "matches_description": True, "summary": "A deep pothole in an asphalt road.", "extra": "dropped"}

    out = ai.analyse_photo(FakeVision(), b"jpeg-bytes", "image/jpeg", 'huge "gaddha" near the station')
    assert out["road_damage"] is True and out["severity"] == "high" and out["model"] == "vision@test"
    assert "extra" not in out and "not a measured" in out["note"]
