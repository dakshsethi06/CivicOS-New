"""Concatenate supabase/migrations/*.sql, in order, into supabase/all_migrations.sql (pasted once into the
Supabase SQL Editor on a new project). Run after changing any migration: python3 build_all_migrations.py"""
import pathlib

here = pathlib.Path(__file__).parent
parts = ["-- CivicOS: all migrations in order (generated from supabase/migrations). Paste into the Supabase SQL Editor and run once on a new project.\n"]
for f in sorted((here / "migrations").glob("*.sql")):
    bar = "-- " + "=" * 60
    parts.append(f"\n{bar}\n-- {f.name}\n{bar}\n" + f.read_text(encoding="utf-8").rstrip("\n") + "\n")
(here / "all_migrations.sql").write_text("".join(parts), encoding="utf-8", newline="\n")
print("wrote all_migrations.sql from", len(parts) - 1, "migrations")
