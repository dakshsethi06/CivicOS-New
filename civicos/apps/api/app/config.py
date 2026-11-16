"""Settings, read from environment variables (or apps/api/.env in development)."""
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Supabase. DATABASE_URL is the Postgres connection string (Project Settings -> Database). On hosts without IPv6
    # (Render), use the pooler string. The anon/publishable key lets the API read files from Storage as the user.
    database_url: str
    supabase_url: str
    supabase_anon_key: str
    # Only for projects that still sign tokens with the legacy shared secret (HS256). Projects using JWT signing keys
    # are verified against the project's public JWKS and need nothing here.
    supabase_jwt_secret: str | None = None

    # Google Gemini: answers and embeddings. Without a key the assistant still answers, by showing the retrieved
    # sources themselves, and retrieval falls back to keyword search.
    gemini_api_key: str | None = None
    gemini_model: str = "gemini-3.8-flash"
    # tried in order when the main model is overloaded or rate-limited (HTTP 429/5xx)
    gemini_fallback_models: list[str] = ["gemini-flash-lite-latest", "gemini-3.7-flash"]
    gemini_embedding_model: str = "gemini-embedding-001"
    embedding_dim: int = 768                 # must match vector(768) in supabase/migrations/0017_rag_vectors.sql

    # Retrieval and chunking
    rag_top_k: int = 8
    rag_min_similarity: float = 0.55         # vector-only hits below this are dropped (keyword hits are kept)
    chunk_size: int = 1100                   # characters
    chunk_overlap: int = 160
    max_tool_rounds: int = 4
    # Re-ranking: retrieve more candidates, then a fast model scores how well each passage answers the question
    rag_rerank: bool = True
    rag_candidates: int = 16
    gemini_rerank_model: str = "gemini-flash-lite-latest"

    # Background jobs. With a Redis URL, jobs run on the Celery worker (app/worker.py), which also retrains models
    # nightly. Without one, the API runs jobs in its own process.
    redis_url: str | None = None
    route_solver_seconds: int = 3            # OR-Tools time limit per ward

    cors_origins: list[str] = ["http://localhost:3000"]

    @property
    def sqlalchemy_url(self) -> str:
        url = self.database_url
        for prefix in ("postgresql://", "postgres://"):
            if url.startswith(prefix):
                return "postgresql+psycopg://" + url[len(prefix):]
        return url

    @property
    def embedding_model_id(self) -> str:
        return f"{self.gemini_embedding_model}@{self.embedding_dim}"


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
