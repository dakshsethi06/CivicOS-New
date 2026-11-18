"""The assistant's tools. The model chooses among them (routing); each returns evidence with citation markers.

  search_documents  -> RAG over the municipality's uploaded documents (policies, regulations, reports)
  city_figures      -> published statistics, model forecasts and the City Health Index (structured SQL)
  ward_profile      -> everything published about one ward (location-specific)
  live_complaints   -> complaints submitted through CivicOS, as the caller is allowed to see them
  water_operations  -> meters, anomalies, pipe failure risk, reservoirs and demand forecasts (ML inference)
  waste_operations  -> bin fill levels, overflow predictions, collection routes and efficiency
  traffic_operations-> congestion now and forecast, peak hours, incidents
  nearby            -> what is around a place: ward, complaints, anomalies, risky pipes, bins, roads (PostGIS)

Tools may also return a chart, shown with the answer when the facts it illustrates are cited.
"""
from typing import Any

from ..data import DataAccess
from ..providers import Embedder, ProviderError, Reranker, ToolSpec
from .citations import Sources

DOC_CATEGORIES = ["Policy", "Regulation", "Guideline", "Development plan", "Report", "Notice", "Manual", "Other"]

TOOL_SPECS = [
    ToolSpec(
        name="search_documents",
        description=(
            "Semantic search over the municipality's uploaded documents: policies, regulations, building and waste rules, "
            "guidelines, development plans, reports, notices and manuals. Use for any question about what a rule, policy "
            "or document says, who is responsible, procedures, requirements, or to explain causes using reports. "
            "Write the query as a focused search phrase; call again with a different phrasing if results are weak."),
        parameters={"type": "object", "properties": {
            "query": {"type": "string", "description": "What to look for, in plain words"},
            "category": {"type": "string", "enum": DOC_CATEGORIES, "description": "Optional: only this kind of document"},
        }, "required": ["query"]},
    ),
    ToolSpec(
        name="city_figures",
        description=(
            "Published civic statistics for the city and its wards (complaints registered and closed, days to close, "
            "water supply hours, unfit drinking-water samples, water supply and demand, waste tonnage and per person, "
            "bulk waste generators), model forecasts for 2026-2028 (complaints, waste, air quality, water), and the "
            "prototype City Health Index. Pass the user's question or a focused version of it; mention ward codes "
            "(e.g. 'ward K/W'), years, and words like 'forecast' or 'next three years' when relevant."),
        parameters={"type": "object", "properties": {
            "question": {"type": "string", "description": "A question about city or ward figures"},
        }, "required": ["question"]},
    ),
    ToolSpec(
        name="ward_profile",
        description=("All published figures for one ward at once: population, complaints and closure, water hours and "
                     "quality, waste, air quality days, slum share, health score and model ward group. Use when the "
                     "question is about a specific ward or compares wards."),
        parameters={"type": "object", "properties": {
            "ward": {"type": "string", "description": "Ward code, e.g. 'K/W', 'A', 'M/E'"},
        }, "required": ["ward"]},
    ),
    ToolSpec(
        name="live_complaints",
        description=("Complaints submitted through CivicOS itself (not the published statistics): totals, open "
                     "complaints, by status, by category and open complaints by ward. Use for questions about current "
                     "or unresolved complaints in the system."),
        parameters={"type": "object", "properties": {
            "ward": {"type": "string", "description": "Optional ward code"},
        }},
    ),
    ToolSpec(
        name="water_operations",
        description=("Water network operations from meters and models: water drawn now against last week, wards with "
                     "unusually high consumption, open leak/burst anomalies, pipes most likely to fail, reservoirs at "
                     "shortage risk, and forecast demand for the next 7 days. Use for questions about water consumption, "
                     "leaks, pipelines, pressure, reservoirs or water demand forecasts. Optional ward code."),
        parameters={"type": "object", "properties": {"ward": {"type": "string", "description": "Optional ward code, e.g. 'K/W'"}}},
    ),
    ToolSpec(
        name="waste_operations",
        description=("Waste collection operations: bin fill levels, bins predicted to overflow within 6, 12 or 24 hours, "
                     "the optimised collection routes against the fixed schedule, and collection efficiency. Use for "
                     "questions about overflowing bins, collection, routes or garbage zones. Optional ward code."),
        parameters={"type": "object", "properties": {"ward": {"type": "string", "description": "Optional ward code"}}},
    ),
    ToolSpec(
        name="traffic_operations",
        description=("Traffic: congestion now on monitored roads, the slowest roads, the 60-minute congestion forecast, "
                     "peak hours and accident/incident hotspots. Use for questions about traffic, congestion, roads, peak "
                     "hours or accidents. Optional ward code."),
        parameters={"type": "object", "properties": {"ward": {"type": "string", "description": "Optional ward code"}}},
    ),
    ToolSpec(
        name="nearby",
        description=("What is around a place: which ward it is in, open complaints, water anomalies, pipes at risk, bins "
                     "about to fill, congested roads and recent incidents within a radius. Give a complaint reference "
                     "(e.g. CMP-000012) or latitude and longitude."),
        parameters={"type": "object", "properties": {
            "complaint_reference": {"type": "string", "description": "A complaint reference such as CMP-000012"},
            "lat": {"type": "number"}, "lon": {"type": "number"},
            "radius_m": {"type": "integer", "description": "Search radius in metres (default 500)"},
        }},
    ),
]

_WARD_FIELDS = [  # (key, label, unit, year key or None)
    ("population", "Population", "people", None),
    ("registered", "Complaints registered", "", "year"),
    ("closed", "Complaints closed", "", "year"),
    ("closed_pct", "Share of complaints closed", "%", "year"),
    ("avg_days", "Average days to close a complaint", "days", "year"),
    ("per_10k", "Complaints per 10,000 residents", "", "year"),
    ("waste_tpd", "Waste lifted", "tonnes/day", "year"),
    ("waste_per_capita", "Waste per person", "kg/day", None),
    ("water_hours", "Water supply", "hours/day", "water_hours_year"),
    ("water_unfit_pct", "Drinking-water samples found unfit", "%", "water_unfit_year"),
    ("slum_pct", "Slum population (2011)", "%", None),
    ("health_score", "City Health Index (prototype)", "out of 100", None),
    ("ward_group", "Model ward group", "", None),
]


def _num(v: Any) -> str:
    if isinstance(v, (int, float)):
        return f"{v:,.2f}".rstrip("0").rstrip(".") if isinstance(v, float) and not float(v).is_integer() else f"{int(v):,}"
    return str(v)


class Toolbox:
    def __init__(self, data: DataAccess, embedder: Embedder | None, sources: Sources, top_k: int, min_similarity: float,
                 reranker: Reranker | None = None, candidates: int = 16):
        self.data, self.embedder, self.sources = data, embedder, sources
        self.top_k, self.min_similarity = top_k, min_similarity
        self.reranker, self.candidates = reranker, max(candidates, top_k)
        self.log: list[dict[str, Any]] = []
        self.retrieval_note: str | None = None
        self.charts: list[dict[str, Any]] = []      # each with the markers of the facts it illustrates

    def run(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        fn = {"search_documents": self.search_documents, "city_figures": self.city_figures,
              "ward_profile": self.ward_profile, "live_complaints": self.live_complaints,
              "water_operations": lambda ward=None: self.operations("water", ward),
              "waste_operations": lambda ward=None: self.operations("waste", ward),
              "traffic_operations": lambda ward=None: self.operations("traffic", ward),
              "nearby": self.nearby}.get(name)
        if fn is None:
            result: dict[str, Any] = {"error": f"Unknown tool {name}"}
        else:
            try:
                result = fn(**{k: v for k, v in args.items() if v not in (None, "")})
            except TypeError as e:
                result = {"error": f"Bad arguments: {e}"}
        self.log.append({"tool": name, "args": args, "returned": result.get("count", 0)})
        return result

    def search_documents(self, query: str, category: str | None = None) -> dict[str, Any]:
        embedding = None
        if self.embedder is not None:
            try:
                embedding = self.embedder.embed_query(query)
            except ProviderError as e:
                self.retrieval_note = f"Semantic search was unavailable ({e}); keyword search was used."
        want = self.candidates if self.reranker is not None else self.top_k
        hits = self.data.match_chunks(query, embedding, want, self.min_similarity, category)
        if self.reranker is not None and len(hits) > 1:
            try:
                scores = self.reranker.rerank(query, [h["content"] for h in hits])
                ranked = sorted(zip(scores, range(len(hits)), hits), key=lambda t: (-t[0], t[1]))
                kept = [h for s, _, h in ranked if s >= 1] or [h for _, _, h in ranked[:2]]
                hits = kept[: self.top_k]
            except ProviderError:
                hits = hits[: self.top_k]              # fused order stands
        else:
            hits = hits[: self.top_k]
        passages = []
        for h in hits:
            sid = self.sources.add_document(h)
            passages.append({"marker": sid, "document": h["title"], "page": h.get("page"), "section": h.get("section"),
                             "category": h.get("category"), "text": h["content"]})
        return {"count": len(passages), "passages": passages,
                "note": None if passages else "No passage in the uploaded documents matches this query."}

    def city_figures(self, question: str) -> dict[str, Any]:
        facts = self.data.facts(question)
        out = [{"marker": self.sources.add_figure(f["text"], f["source"]), "fact": f["text"]} for f in facts]
        return {"count": len(out), "figures": out,
                "note": None if out else "No published figure matches; try naming the indicator, ward or year."}

    def ward_profile(self, ward: str) -> dict[str, Any]:
        w = self.data.ward_profile(ward)
        if not w:
            return {"count": 0, "figures": [], "note": f"There is no ward '{ward}' in this city's data."}
        out = []
        for key, label, unit, year_key in _WARD_FIELDS:
            v = w.get(key)
            if v is None:
                continue
            yr = w.get(year_key) if year_key else None
            text = f"{label}, Ward {w['code']}{f', {yr}' if yr else ''}: {_num(v)}{f' {unit}' if unit else ''}"
            out.append({"marker": self.sources.add_figure(text, "Praja Foundation reports (BMC data), via CivicOS ward statistics"),
                        "fact": text})
        return {"count": len(out), "ward": w["code"], "figures": out}

    def live_complaints(self, ward: str | None = None) -> dict[str, Any]:
        s = self.data.complaint_summary(ward)
        scope = f"Ward {s['ward']}" if s.get("ward") else "all wards"
        src = "CivicOS complaints submitted through the platform (live, as visible to you)"
        lines = [f"Complaints submitted through CivicOS, {scope}: {s.get('total', 0)} in total, {s.get('open', 0)} not yet resolved"]
        if s.get("by_status"):
            lines.append("By status, " + scope + ": " + ", ".join(f"{k.replace('_', ' ')} {v}" for k, v in s["by_status"].items()))
        if s.get("by_category"):
            lines.append("By category, " + scope + ": " + ", ".join(f"{k} {v}" for k, v in s["by_category"].items()))
        if s.get("open_by_ward") and not s.get("ward"):
            lines.append("Unresolved by ward: " + ", ".join(f"{k} {v}" for k, v in s["open_by_ward"].items()))
        if s.get("oldest_open"):
            lines.append(f"Oldest unresolved complaint submitted on {str(s['oldest_open'])[:10]}")
        out = [{"marker": self.sources.add_figure(t, src), "fact": t} for t in lines]
        return {"count": len(out), "figures": out}

    def operations(self, module: str, ward: str | None = None) -> dict[str, Any]:
        r = self.data.ops(module, ward)
        facts = r.get("facts") or []
        src = r.get("source") or f"CivicOS {module} operations"
        out = [{"marker": self.sources.add_figure(t, src), "fact": t} for t in facts]
        chart = r.get("chart")
        if chart and chart.get("data") and out:
            self.charts.append({**chart, "markers": [o["marker"] for o in out]})
        note = r.get("note")
        if r.get("is_demo"):
            note = ((note + " ") if note else "") + "These figures are from the demonstration dataset, not measurements: say so in the answer."
        return {"count": len(out), "scope": r.get("scope"), "figures": out, "note": note}

    def nearby(self, complaint_reference: str | None = None, lat: float | None = None, lon: float | None = None,
               radius_m: int | None = None) -> dict[str, Any]:
        if complaint_reference:
            loc = self.data.complaint_location(complaint_reference)
            if not loc:
                return {"count": 0, "figures": [], "note": f"No complaint {complaint_reference} with a location is visible to you."}
            lat, lon = loc["lat"], loc["lon"]
        if lat is None or lon is None:
            return {"count": 0, "figures": [], "note": "Give a complaint reference or a latitude and longitude."}
        r = self.data.nearby(float(lon), float(lat), int(radius_m or 500))
        out = [{"marker": self.sources.add_figure(f["text"], f["source"]), "fact": f["text"]} for f in (r.get("facts") or [])]
        return {"count": len(out), "ward": r.get("ward"), "radius_m": r.get("radius_m"), "figures": out}
