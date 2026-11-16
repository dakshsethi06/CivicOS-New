import os

# settings are read at import time; tests never touch a real database or model
os.environ.setdefault("DATABASE_URL", "postgresql://test:test@localhost:5/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_ANON_KEY", "anon")
os.environ.setdefault("SUPABASE_JWT_SECRET", "test-secret-with-at-least-thirty-two-bytes!")
os.environ["GEMINI_API_KEY"] = ""          # empty, so a real key in apps/api/.env is never used by tests
