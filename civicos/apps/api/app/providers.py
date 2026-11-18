"""Model providers behind small interfaces, so Gemini can be swapped without touching the RAG pipeline.

Embedder: turns text into unit-length vectors (document side and query side differ for retrieval models).
ChatModel: a tool-calling conversation. The assistant orchestrator only sees Turn(text, calls), never SDK types.
"""
import math
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any, Protocol, TypeVar

from .config import Settings, get_settings

T = TypeVar("T")


# ---------------------------------------------------------------------------------------------------------------
# Interfaces
# ---------------------------------------------------------------------------------------------------------------
class Embedder(Protocol):
    model_id: str

    def embed_documents(self, texts: list[str], title: str | None = None) -> list[list[float]]: ...
    def embed_query(self, text: str) -> list[float]: ...
    def embed_similarity(self, texts: list[str]) -> list[list[float]]: ...   # symmetric: text against text


class Reranker(Protocol):
    def rerank(self, query: str, passages: list[str]) -> list[float]: ...   # one relevance score (0-3) per passage


class Vision(Protocol):
    name: str

    def analyse_image(self, image: bytes, mime: str, prompt: str, schema: dict[str, Any]) -> dict[str, Any]: ...


@dataclass
class ToolCall:
    name: str
    args: dict[str, Any]


@dataclass
class Turn:
    text: str
    calls: list[ToolCall] = field(default_factory=list)


@dataclass
class ToolSpec:
    name: str
    description: str
    parameters: dict[str, Any]          # JSON-schema-like: {"type": "object", "properties": {...}, "required": [...]}


class ChatSession(Protocol):
    def send_user(self, text: str, tool_choice: str = "auto") -> Turn: ...
    def send_tool_results(self, results: list[tuple[ToolCall, Any]], tool_choice: str = "auto") -> Turn: ...


class ChatModel(Protocol):
    name: str

    def start(self, system: str, tools: list[ToolSpec]) -> ChatSession: ...


TRANSIENT = (429, 500, 502, 503, 504)
COOLDOWN_SECONDS = 300
_COOLDOWN: dict[str, float] = {}       # model -> monotonic time until which it is tried last (it was overloaded)


class ProviderError(RuntimeError):
    def __init__(self, message: str, code: int | None = None):
        super().__init__(message)
        self.code = code


def _retry(fn: Callable[[], T], attempts: int = 4) -> T:
    """Retries rate limits and transient server errors with exponential backoff."""
    delay = 1.5
    for i in range(attempts):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001 - SDK errors vary; re-raised below when not transient
            code = getattr(e, "code", None) or getattr(e, "status_code", None)
            if i == attempts - 1 or code not in TRANSIENT:
                raise ProviderError(str(e), code if isinstance(code, int) else None) from e
            time.sleep(delay)
            delay *= 2
    raise AssertionError("unreachable")


def _unit(v: list[float]) -> list[float]:
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


# ---------------------------------------------------------------------------------------------------------------
# Gemini
# ---------------------------------------------------------------------------------------------------------------
class GeminiEmbedder:
    BATCH = 64

    def __init__(self, settings: Settings):
        from google import genai

        self._client = genai.Client(api_key=settings.gemini_api_key, http_options={"timeout": 60_000})  # ms; never hang a request
        self._model = settings.gemini_embedding_model
        self._dim = settings.embedding_dim
        self.model_id = settings.embedding_model_id

    def _embed(self, texts: list[str], task: str, title: str | None = None) -> list[list[float]]:
        from google.genai import types

        out: list[list[float]] = []
        for i in range(0, len(texts), self.BATCH):
            batch = texts[i:i + self.BATCH]
            cfg = types.EmbedContentConfig(task_type=task, output_dimensionality=self._dim,
                                           title=title if task == "RETRIEVAL_DOCUMENT" else None)
            res = _retry(lambda: self._client.models.embed_content(model=self._model, contents=batch, config=cfg))
            vecs = [list(e.values or []) for e in (res.embeddings or [])]
            if len(vecs) != len(batch) or any(len(v) != self._dim for v in vecs):
                raise ProviderError("The embedding service returned an unexpected result")
            # below 3072 dimensions Gemini's vectors are not normalised; cosine search wants unit length
            out.extend(_unit(v) for v in vecs)
        return out

    def embed_documents(self, texts: list[str], title: str | None = None) -> list[list[float]]:
        return self._embed(texts, "RETRIEVAL_DOCUMENT", title)

    def embed_query(self, text: str) -> list[float]:
        return self._embed([text], "RETRIEVAL_QUERY")[0]

    def embed_similarity(self, texts: list[str]) -> list[list[float]]:
        return self._embed(texts, "SEMANTIC_SIMILARITY")


def _gemini_schema(s: dict[str, Any]) -> dict[str, Any]:
    """JSON-schema-like dict -> Gemini's OpenAPI-style schema (upper-case type names)."""
    out: dict[str, Any] = {"type": s["type"].upper()}
    for k in ("description", "enum", "required"):
        if k in s:
            out[k] = s[k]
    if "properties" in s:
        out["properties"] = {k: _gemini_schema(v) for k, v in s["properties"].items()}
    if "items" in s:
        out["items"] = _gemini_schema(s["items"])
    return out


class GeminiSession:
    def __init__(self, client: Any, model: str, system: str, tools: list[ToolSpec], fallbacks: list[str] | None = None):
        from google.genai import types

        self._types = types
        self._client, self._model = client, model
        self._fallbacks = [m for m in (fallbacks or []) if m != model]
        self._contents: list[Any] = []
        self._base = dict(
            system_instruction=system,
            temperature=0.1,
            max_output_tokens=2048,
            tools=[types.Tool(function_declarations=[
                types.FunctionDeclaration(name=t.name, description=t.description, parameters=_gemini_schema(t.parameters))
                for t in tools])],
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
        )

    def _send(self, tool_choice: str) -> Turn:
        types = self._types
        mode = {"required": "ANY", "auto": "AUTO", "none": "NONE"}[tool_choice]
        config = types.GenerateContentConfig(
            **self._base, tool_config=types.ToolConfig(function_calling_config=types.FunctionCallingConfig(mode=mode)))
        res = None
        everyone = [self._model] + self._fallbacks
        # models that were overloaded a moment ago are tried last, so a busy model does not slow every question
        now = time.monotonic()
        order = [m for m in everyone if _COOLDOWN.get(m, 0) <= now] + [m for m in everyone if _COOLDOWN.get(m, 0) > now]
        for i, model in enumerate(order):
            last = i == len(order) - 1
            try:
                res = _retry(lambda: self._client.models.generate_content(model=model, contents=self._contents, config=config),
                             attempts=3 if last else 1)
            except ProviderError as e:
                # an overloaded or rate-limited model: rest it, move to the next one, and stay there for this conversation
                if e.code in TRANSIENT and not last:
                    _COOLDOWN[model] = time.monotonic() + COOLDOWN_SECONDS
                    continue
                raise
            if model != self._model:
                self._fallbacks = [m for m in [self._model] + self._fallbacks if m != model]
                self._model = model
            break
        assert res is not None
        if not res.candidates or res.candidates[0].content is None:
            raise ProviderError("The language model returned no answer (it may have been blocked by a safety filter)")
        content = res.candidates[0].content
        self._contents.append(content)        # keep the model's own turn, including any thought signatures
        calls = [ToolCall(p.function_call.name or "", dict(p.function_call.args or {}))
                 for p in (content.parts or []) if p.function_call]
        text = "".join(p.text for p in (content.parts or []) if p.text and not getattr(p, "thought", False))
        return Turn(text=text.strip(), calls=calls)

    def send_user(self, text: str, tool_choice: str = "auto") -> Turn:
        self._contents.append(self._types.Content(role="user", parts=[self._types.Part(text=text)]))
        return self._send(tool_choice)

    def send_tool_results(self, results: list[tuple[ToolCall, Any]], tool_choice: str = "auto") -> Turn:
        parts = [self._types.Part.from_function_response(name=c.name, response={"result": r}) for c, r in results]
        self._contents.append(self._types.Content(role="user", parts=parts))
        return self._send(tool_choice)


class GeminiChat:
    def __init__(self, settings: Settings):
        from google import genai

        self._client = genai.Client(api_key=settings.gemini_api_key, http_options={"timeout": 60_000})  # ms; never hang a request
        self.name = settings.gemini_model
        self.fallbacks = settings.gemini_fallback_models

    def start(self, system: str, tools: list[ToolSpec]) -> ChatSession:
        return GeminiSession(self._client, self.name, system, tools, self.fallbacks)


class GeminiVision:
    """Image understanding with structured (JSON) output, using the chat model and its fallbacks."""

    def __init__(self, settings: Settings):
        from google import genai

        self._client = genai.Client(api_key=settings.gemini_api_key, http_options={"timeout": 60_000})
        self.name = settings.gemini_model
        self._models = [settings.gemini_model] + [m for m in settings.gemini_fallback_models if m != settings.gemini_model]

    def analyse_image(self, image: bytes, mime: str, prompt: str, schema: dict[str, Any]) -> dict[str, Any]:
        import json

        from google.genai import types

        config = types.GenerateContentConfig(temperature=0.0, max_output_tokens=1024, response_mime_type="application/json",
                                             response_schema=_gemini_schema(schema))
        contents = [types.Part.from_bytes(data=image, mime_type=mime), prompt]
        now = time.monotonic()
        order = [m for m in self._models if _COOLDOWN.get(m, 0) <= now] + [m for m in self._models if _COOLDOWN.get(m, 0) > now]
        for i, model in enumerate(order):
            last = i == len(order) - 1
            try:
                res = _retry(lambda: self._client.models.generate_content(model=model, contents=contents, config=config),
                             attempts=3 if last else 1)
            except ProviderError as e:
                if e.code in TRANSIENT and not last:
                    _COOLDOWN[model] = time.monotonic() + COOLDOWN_SECONDS
                    continue
                raise
            self.name = model
            try:
                return json.loads(res.text or "{}")
            except json.JSONDecodeError as e:
                raise ProviderError("The vision model returned an unreadable result") from e
        raise ProviderError("No vision model available")


class GeminiReranker:
    """Scores retrieved passages for how well they answer the question (0 = unrelated ... 3 = answers it directly),
    in one call to a fast model. Used after hybrid retrieval, which is good at recall but ranks by surface closeness."""

    PROMPT = """Rate how well each numbered passage helps answer the question.
3 = directly answers it, 2 = clearly relevant, 1 = loosely related, 0 = unrelated.
Return one integer per passage, in order, and nothing else.

Question: {query}

{passages}"""

    def __init__(self, settings: Settings):
        from google import genai

        self._client = genai.Client(api_key=settings.gemini_api_key, http_options={"timeout": 30_000})
        self._models = [settings.gemini_rerank_model] + [m for m in settings.gemini_fallback_models if m != settings.gemini_rerank_model]

    def rerank(self, query: str, passages: list[str]) -> list[float]:
        import json

        from google.genai import types

        body = "\n\n".join(f"[{i + 1}] {p[:900]}" for i, p in enumerate(passages))
        config = types.GenerateContentConfig(
            temperature=0.0, max_output_tokens=256, response_mime_type="application/json",
            response_schema=_gemini_schema({"type": "object", "properties": {"scores": {"type": "array", "items": {"type": "integer"}}},
                                            "required": ["scores"]}))
        prompt = self.PROMPT.format(query=query[:500], passages=body)
        for i, model in enumerate(self._models):
            try:
                res = _retry(lambda: self._client.models.generate_content(model=model, contents=prompt, config=config), attempts=1)
                scores = json.loads(res.text or "{}").get("scores", [])
                if len(scores) != len(passages):
                    raise ProviderError("The re-ranker returned the wrong number of scores")
                return [float(max(0, min(3, s))) for s in scores]
            except ProviderError as e:
                if e.code in TRANSIENT and i < len(self._models) - 1:
                    continue
                raise
            except (json.JSONDecodeError, TypeError, ValueError) as e:
                raise ProviderError("The re-ranker returned an unreadable result") from e
        raise ProviderError("No re-ranking model available")


# ---------------------------------------------------------------------------------------------------------------
# Factories (None = not configured)
# ---------------------------------------------------------------------------------------------------------------
@lru_cache
def get_embedder() -> Embedder | None:
    s = get_settings()
    return GeminiEmbedder(s) if s.gemini_api_key else None


@lru_cache
def get_chat_model() -> ChatModel | None:
    s = get_settings()
    return GeminiChat(s) if s.gemini_api_key else None


@lru_cache
def get_reranker() -> Reranker | None:
    s = get_settings()
    return GeminiReranker(s) if s.gemini_api_key and s.rag_rerank else None


@lru_cache
def get_vision() -> Vision | None:
    s = get_settings()
    return GeminiVision(s) if s.gemini_api_key else None
