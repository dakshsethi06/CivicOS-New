"""Hybrid assistant: the model routes the question to tools, then answers only from what they returned.

1. The model must call at least one tool first (tool_choice=required), so no answer is ever ungrounded.
2. It may call more tools (another search phrasing, a ward profile, live complaints) for up to max_tool_rounds.
3. It then writes the answer, citing [F#]/[D#] markers. Citations are checked; uncited or invented ones are removed.
4. Without a language model, or if it fails, the retrieved sources themselves are the answer (extractive mode).
"""
from dataclasses import dataclass, field
from typing import Any

from ..data import DataAccess
from ..providers import ChatModel, Embedder, ProviderError, Reranker
from .citations import NOT_ESTABLISHED, Sources, extractive_answer, validate_answer
from .tools import TOOL_SPECS, Toolbox

SYSTEM_PROMPT = f"""You are the CivicOS assistant for a municipal corporation. You help city officials and residents with
questions about municipal rules and documents, city statistics, forecasts, wards, complaints, and the water, waste and
traffic operations (meters, leaks, pipes, reservoirs, bins, collection routes, congestion, incidents).

How to work:
- Always use the tools to gather evidence before answering. Pick the tools that fit the question; use several when it
  needs both rules and figures (for example "why is water consumption high in ward Y": water_operations for the ward,
  then search_documents for the relevant guidelines or reports).
- Use the operations tools for current conditions and model predictions, city_figures for published statistics, and
  nearby for questions about a place or a complaint's surroundings.
- Tool results contain markers such as [F3] (a figure, forecast or count) and [D2] (a passage from an uploaded document).

How to answer:
- Answer ONLY from the tool results. Do not use outside knowledge and do not guess or extrapolate.
- After every sentence that states a fact, cite the markers it came from, like [F2] or [D1][D3]. Use only markers that
  appear in the tool results; never invent one.
- Forecasts and predictions are model estimates: say so and give the range when you use one. An anomaly is a pattern
  to inspect, not proof of a leak.
- When a tool says its figures are demonstration data, say so in the answer.
- If the results do not answer the question, reply exactly: "{NOT_ESTABLISHED}"
- If they answer only part of it, answer that part and say plainly what is not covered.
- Be concise: at most eight sentences or a short list. Plain language, no preamble, no headings."""


@dataclass
class AssistantAnswer:
    answer: str
    mode: str                                   # llm | extractive | none
    citations: list[dict[str, Any]]
    chunk_ids: list[int]
    fact_count: int
    tools: list[dict[str, Any]] = field(default_factory=list)
    note: str | None = None
    charts: list[dict[str, Any]] = field(default_factory=list)


def _charts(box: Toolbox, used: set[str]) -> list[dict[str, Any]]:
    """Charts whose facts the answer actually cites, without the internal marker list."""
    return [{k: v for k, v in c.items() if k != "markers"} for c in box.charts if used & set(c["markers"])][:2]


def answer_question(question: str, data: DataAccess, chat: ChatModel | None, embedder: Embedder | None,
                    top_k: int = 8, min_similarity: float = 0.55, max_rounds: int = 4,
                    reranker: Reranker | None = None, candidates: int = 16) -> AssistantAnswer:
    sources = Sources()
    box = Toolbox(data, embedder, sources, top_k, min_similarity, reranker, candidates)
    note: str | None = None
    raw: str | None = None

    if chat is not None:
        try:
            session = chat.start(SYSTEM_PROMPT, TOOL_SPECS)
            turn = session.send_user(question, tool_choice="required")
            rounds = 0
            while turn.calls:
                rounds += 1
                results = [(c, box.run(c.name, c.args)) for c in turn.calls]
                # after the last allowed round the model must answer in text
                turn = session.send_tool_results(results, tool_choice="none" if rounds >= max_rounds else "auto")
            raw = turn.text
        except ProviderError as e:
            note = f"The language model could not be reached ({e}), so the sources are shown directly."

    if raw is None:
        # no model (or it failed): deterministic routing to documents and figures
        if not box.log:
            box.run("search_documents", {"query": question})
            box.run("city_figures", {"question": question})
        elif not sources.all:
            box.run("city_figures", {"question": question})

    if box.retrieval_note:
        note = f"{note} {box.retrieval_note}".strip() if note else box.retrieval_note

    valid = {c["id"] for c in sources.all}
    if not valid:
        return AssistantAnswer(NOT_ESTABLISHED, "none" if raw is None else "llm", [], [], 0, box.log, note)

    if raw is not None:
        if NOT_ESTABLISHED.rstrip(".") in raw:
            return AssistantAnswer(NOT_ESTABLISHED, "llm", [], sources.chunk_ids, len(sources.figures), box.log, note)
        text, used, stripped = validate_answer(raw, valid)
        if used:
            if stripped:
                note = "Part of the answer cited a source that does not exist and was removed."
            return AssistantAnswer(text, "llm", sources.public(used), sources.chunk_ids, len(sources.figures), box.log, note,
                                   _charts(box, used))
        note = "The language model's answer cited no source, so the retrieved sources are shown instead."

    text = extractive_answer(sources)
    used = {m for m in valid if f"[{m}]" in text}
    return AssistantAnswer(text, "extractive", sources.public(used), sources.chunk_ids, len(sources.figures), box.log, note,
                           _charts(box, used))
