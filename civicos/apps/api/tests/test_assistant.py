from typing import Any

from app.assistant.citations import NOT_ESTABLISHED, validate_answer
from app.assistant.orchestrator import answer_question
from app.providers import ProviderError, ToolCall, Turn

RULES = {"chunk_id": 11, "document_id": "doc-1", "title": "Solid Waste Rules", "page": 3, "section": "4. Duties",
         "category": "Regulation", "content": "Every bulk waste generator shall process biodegradable waste on site.",
         "excerpt": "Every «bulk» waste generator shall process", "similarity": 0.81}


class FakeData:
    def __init__(self, chunks=None, facts=None):
        self.chunks = chunks if chunks is not None else [RULES]
        self.fact_rows = facts if facts is not None else [{"text": "Waste lifted, Mumbai, 2025: 6,955 tonnes/day", "source": "Praja, Table 37"}]
        self.calls: list[tuple[str, Any]] = []

    def match_chunks(self, query, embedding, k, min_similarity, category):
        self.calls.append(("match", query, embedding is not None, category))
        return self.chunks

    def facts(self, question):
        self.calls.append(("facts", question))
        return self.fact_rows

    def ward_profile(self, ward):
        return {"code": ward.upper(), "year": 2025, "registered": 7722, "closed_pct": 98.47, "water_hours": 2.37,
                "water_hours_year": 2024} if ward.upper() == "K/W" else None

    def complaint_summary(self, ward):
        return {"ward": ward, "total": 3, "open": 2, "by_status": {"assigned": 2, "resolved": 1}}


class ScriptedChat:
    """Plays back model turns; records what it was sent."""
    name = "fake"

    def __init__(self, turns: list[Turn]):
        self.turns, self.sent = list(turns), []

    def start(self, system, tools):
        self.tools = [t.name for t in tools]
        return self

    def send_user(self, text, tool_choice="auto"):
        self.sent.append(("user", text, tool_choice))
        return self.turns.pop(0)

    def send_tool_results(self, results, tool_choice="auto"):
        self.sent.append(("tools", results, tool_choice))
        return self.turns.pop(0)


class FakeEmbedder:
    model_id = "fake@768"

    def embed_documents(self, texts, title=None):
        return [[1.0] + [0.0] * 767 for _ in texts]

    def embed_query(self, text):
        return [1.0] + [0.0] * 767


def test_routes_through_tools_and_keeps_only_real_citations():
    chat = ScriptedChat([
        Turn("", [ToolCall("search_documents", {"query": "bulk waste generator duty"}),
                  ToolCall("city_figures", {"question": "waste lifted 2025"})]),
        Turn("Bulk generators must process wet waste on site [D1]. The city lifted 6,955 tonnes a day [F1]. "
             "Fines are Rs 5,000 [D9]."),
    ])
    data = FakeData()
    a = answer_question("What must bulk generators do?", data, chat, FakeEmbedder())
    assert chat.sent[0][2] == "required"                       # the first turn must use a tool
    assert a.mode == "llm"
    assert "[D1]" in a.answer and "[F1]" in a.answer
    assert "D9" not in a.answer and "Rs 5,000" not in a.answer  # invented citation: sentence removed
    assert {c["id"] for c in a.citations} == {"D1", "F1"}
    assert a.citations[0]["kind"] == "figure" or a.citations[1]["kind"] == "figure"
    doc = next(c for c in a.citations if c["kind"] == "document")
    assert doc["page"] == 3 and doc["section"] == "4. Duties" and "content" not in doc
    assert a.chunk_ids == [11] and a.fact_count == 1
    assert [t["tool"] for t in a.tools] == ["search_documents", "city_figures"]
    assert ("match", "bulk waste generator duty", True, None) in data.calls   # semantic (embedding) search used
    assert a.note and "does not exist" in a.note


def test_tool_results_carry_markers_to_the_model():
    chat = ScriptedChat([Turn("", [ToolCall("ward_profile", {"ward": "k/w"})]), Turn("Ward K/W gets 2.37 hours [F3].")])
    answer_question("How much water does K/W get?", FakeData(), chat, None)
    results = chat.sent[1][1]
    payload = results[0][1]
    assert payload["ward"] == "K/W"
    assert any(f["marker"] == "F3" and "2.37 hours/day" in f["fact"] and "2024" in f["fact"] for f in payload["figures"])


def test_model_says_not_established():
    chat = ScriptedChat([Turn("", [ToolCall("search_documents", {"query": "lattice gauge"})]), Turn(NOT_ESTABLISHED)])
    a = answer_question("lattice gauge theory?", FakeData(), chat, None)
    assert a.answer == NOT_ESTABLISHED and a.mode == "llm" and a.citations == []


def test_nothing_retrieved_is_not_established_without_calling_the_model_for_text():
    chat = ScriptedChat([Turn("", [ToolCall("search_documents", {"query": "x"})]), Turn("Made-up answer.")])
    a = answer_question("x?", FakeData(chunks=[], facts=[]), chat, None)
    assert a.answer == NOT_ESTABLISHED and a.citations == []


def test_uncited_model_answer_falls_back_to_sources():
    chat = ScriptedChat([Turn("", [ToolCall("search_documents", {"query": "bulk"})]), Turn("They should compost.")])
    a = answer_question("bulk?", FakeData(), chat, None)
    assert a.mode == "extractive" and "[D1]" in a.answer and a.note


def test_tool_round_limit_forces_a_text_answer():
    loop = [Turn("", [ToolCall("search_documents", {"query": f"q{i}"})]) for i in range(2)]
    chat = ScriptedChat(loop + [Turn("Answer [D1].")])
    a = answer_question("q", FakeData(), chat, None, max_rounds=2)
    assert chat.sent[-1][2] == "none" and a.answer == "Answer [D1]."


def test_without_a_model_answers_extractively():
    a = answer_question("bulk waste", FakeData(), None, None)
    assert a.mode == "extractive"
    assert "[F1]" in a.answer and "[D1]" in a.answer and "bulk" in a.answer
    assert {c["id"] for c in a.citations} == {"F1", "D1"}


def test_model_failure_falls_back():
    class Broken:
        name = "broken"

        def start(self, system, tools):
            raise ProviderError("quota exceeded")

    a = answer_question("bulk waste", FakeData(), Broken(), None)
    assert a.mode == "extractive" and "quota exceeded" in (a.note or "")


def test_live_complaints_tool():
    chat = ScriptedChat([Turn("", [ToolCall("live_complaints", {"ward": "A"})]), Turn("Two are open [F1].")])
    a = answer_question("open complaints in A?", FakeData(), chat, None)
    assert "2 not yet resolved" in a.citations[0]["text"]


def test_validate_answer():
    text, used, stripped = validate_answer("Fact one [F1]. Fake [F7]. Mixed [F1][D4].\n- item [D1]", {"F1", "D1"})
    assert text == "Fact one [F1]. Mixed [F1].\n- item [D1]"
    assert used == {"F1", "D1"} and stripped == 2


def test_gemini_session_falls_back_when_the_model_is_overloaded(monkeypatch):
    from types import SimpleNamespace

    from app.providers import GeminiSession, ToolSpec

    class Overloaded(Exception):
        code = 503

    calls = []

    class Models:
        def generate_content(self, model, contents, config):
            calls.append(model)
            if model == "main":
                raise Overloaded("high demand")
            part = SimpleNamespace(text="ok", function_call=None, thought=False)
            return SimpleNamespace(candidates=[SimpleNamespace(content=SimpleNamespace(role="model", parts=[part]))])

    import app.providers as p
    monkeypatch.setattr(p.time, "sleep", lambda s: None)     # no real backoff in the test
    monkeypatch.setattr(p, "_COOLDOWN", {})
    s = GeminiSession(SimpleNamespace(models=Models()), "main", "system",
                      [ToolSpec("t", "d", {"type": "object", "properties": {}})], fallbacks=["backup", "spare"])
    assert s.send_user("hi").text == "ok"
    assert calls == ["main", "backup"]                # one try on the busy main model, then the first fallback
    calls.clear()
    s.send_user("again")
    assert calls == ["backup"]                        # stays on the model that worked
    calls.clear()
    s2 = GeminiSession(SimpleNamespace(models=Models()), "main", "system", [], fallbacks=["backup"])
    s2.send_user("new conversation")
    assert calls == ["backup"]                        # the busy model is rested for a while, not tried first


# ---- Phase 3: operations tools, places, charts, re-ranking -------------------------------------------------------
class OpsData(FakeData):
    def ops(self, module, ward):
        self.calls.append(("ops", module, ward))
        return {"scope": f"Ward {ward}" if ward else "Mumbai", "is_demo": True,
                "source": "CivicOS water network meters and models (demonstration data)",
                "facts": ["Water drawn in the 24 hours to 16 Nov 19:30, Ward K/W: 98,000 m3 (+12.0% against the same day a week earlier)",
                          "Open water anomalies, Ward K/W: 2"],
                "chart": {"type": "line", "title": "Water drawn per day", "x": "day", "unit": "m3",
                          "series": [{"key": "observed", "label": "Observed"}], "data": [{"day": "15 Nov", "observed": 97000}]}}

    def complaint_location(self, reference):
        return {"reference": reference, "lat": 19.13, "lon": 72.84} if reference.upper() == "CMP-000012" else None

    def nearby(self, lon, lat, radius_m):
        self.calls.append(("nearby", lon, lat, radius_m))
        return {"ward": "K/W", "radius_m": radius_m,
                "facts": [{"text": "The point 19.13, 72.84 is in Ward K/W (Andheri West)", "source": "Ward boundaries"},
                          {"text": "Open complaints within 300 m: 2", "source": "CivicOS complaints"}]}


def test_operations_tool_cites_figures_flags_demo_data_and_attaches_its_chart():
    chat = ScriptedChat([Turn("", [ToolCall("water_operations", {"ward": "K/W"})]),
                         Turn("Consumption in K/W rose 12% against last week [F1]; two anomalies are open [F2].")])
    data = OpsData()
    a = answer_question("Why is water use high in K/W?", data, chat, None)
    assert ("ops", "water", "K/W") in data.calls
    payload = chat.sent[1][1][0][1]
    assert "demonstration dataset" in payload["note"]          # the model is told to say it is demo data
    assert {c["id"] for c in a.citations} == {"F1", "F2"}
    assert len(a.charts) == 1 and a.charts[0]["title"] == "Water drawn per day" and "markers" not in a.charts[0]


def test_chart_is_dropped_when_its_facts_are_not_cited():
    chat = ScriptedChat([Turn("", [ToolCall("water_operations", {}), ToolCall("city_figures", {"question": "waste"})]),
                         Turn("The city lifted 6,955 tonnes a day [F3].")])
    a = answer_question("How much waste?", OpsData(), chat, None)
    assert a.charts == []


def test_nearby_resolves_a_complaint_reference_to_its_location():
    chat = ScriptedChat([Turn("", [ToolCall("nearby", {"complaint_reference": "cmp-000012", "radius_m": 300})]),
                         Turn("It is in Ward K/W [F1], with two open complaints within 300 m [F2].")])
    data = OpsData()
    a = answer_question("What is around CMP-000012?", data, chat, None)
    assert ("nearby", 72.84, 19.13, 300) in data.calls and {c["id"] for c in a.citations} == {"F1", "F2"}
    chat = ScriptedChat([Turn("", [ToolCall("nearby", {"complaint_reference": "CMP-999"})]), Turn(NOT_ESTABLISHED)])
    a = answer_question("What is around CMP-999?", OpsData(), chat, None)
    assert "No complaint CMP-999" in chat.sent[1][1][0][1]["note"]


def _chunk(i, text):
    return {**RULES, "chunk_id": i, "content": text, "excerpt": text[:40]}


class Reranker:
    def __init__(self, scores=None, fail=False):
        self.scores, self.fail, self.seen = scores, fail, None

    def rerank(self, query, passages):
        self.seen = passages
        if self.fail:
            raise ProviderError("overloaded", 503)
        return self.scores


def test_reranking_reorders_and_drops_unrelated_passages():
    chunks = [_chunk(1, "Street sweeping timings"), _chunk(2, "Bulk generators must compost wet waste"), _chunk(3, "Parking fees")]
    data = FakeData(chunks=chunks)
    rr = Reranker([1, 3, 0])
    chat = ScriptedChat([Turn("", [ToolCall("search_documents", {"query": "bulk generator wet waste"})]), Turn("Compost on site [D1].")])
    a = answer_question("What must bulk generators do?", data, chat, None, top_k=2, reranker=rr, candidates=6)
    passages = chat.sent[1][1][0][1]["passages"]
    assert [p["text"] for p in passages] == ["Bulk generators must compost wet waste", "Street sweeping timings"]   # 0 dropped
    assert rr.seen == [c["content"] for c in chunks]
    assert ("match", "bulk generator wet waste", False, None) in data.calls


def test_reranker_failure_keeps_the_fused_order():
    chunks = [_chunk(1, "A"), _chunk(2, "B"), _chunk(3, "C")]
    chat = ScriptedChat([Turn("", [ToolCall("search_documents", {"query": "x"})]), Turn("A [D1].")])
    answer_question("x?", FakeData(chunks=chunks), chat, None, top_k=2, reranker=Reranker(fail=True))
    assert [p["text"] for p in chat.sent[1][1][0][1]["passages"]] == ["A", "B"]
