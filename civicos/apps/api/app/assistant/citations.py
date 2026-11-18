"""Numbered sources and citation checking.

Every piece of evidence a tool returns gets a stable marker: [D#] for a document passage, [F#] for a published figure,
a forecast or a live count. The model may cite only those markers; the answer is checked against them afterwards, and
any sentence whose only citations point at sources that were never retrieved is removed.
"""
import re
from dataclasses import dataclass, field
from typing import Any

NOT_ESTABLISHED = "The available documents and published figures do not establish this."

MARKER = re.compile(r"\[([FD]\d+)\]")


@dataclass
class Sources:
    figures: list[dict[str, Any]] = field(default_factory=list)     # {id, kind: figure, text, source}
    documents: list[dict[str, Any]] = field(default_factory=list)   # {id, kind: document, title, page, ...}
    _seen: dict[str, str] = field(default_factory=dict)

    def add_figure(self, text: str, source: str) -> str:
        key = f"F|{text}"
        if key in self._seen:
            return self._seen[key]
        sid = f"F{len(self.figures) + 1}"
        self.figures.append({"id": sid, "kind": "figure", "text": text, "source": source})
        self._seen[key] = sid
        return sid

    def add_document(self, hit: dict[str, Any]) -> str:
        key = f"D|{hit['chunk_id']}"
        if key in self._seen:
            return self._seen[key]
        sid = f"D{len(self.documents) + 1}"
        self.documents.append({
            "id": sid, "kind": "document", "title": hit["title"], "page": hit.get("page"), "section": hit.get("section"),
            "excerpt": hit.get("excerpt") or hit["content"][:320], "document_id": hit["document_id"],
            "chunk_id": hit["chunk_id"], "category": hit.get("category"), "content": hit["content"],
            "similarity": hit.get("similarity"),
        })
        self._seen[key] = sid
        return sid

    @property
    def all(self) -> list[dict[str, Any]]:
        return self.figures + self.documents

    def public(self, ids: set[str] | None = None) -> list[dict[str, Any]]:
        """Citations as stored and shown: full passage text is not repeated in the message record."""
        out = []
        for c in self.all:
            if ids is None or c["id"] in ids:
                out.append({k: v for k, v in c.items() if k not in ("content", "similarity")})
        return out

    @property
    def chunk_ids(self) -> list[int]:
        return [d["chunk_id"] for d in self.documents]


def validate_answer(answer: str, valid_ids: set[str]) -> tuple[str, set[str], int]:
    """Removes citation markers that do not point at a retrieved source. A sentence whose only citations are invalid
    is dropped whole rather than left standing uncited. Returns (text, markers used, markers stripped)."""
    used: set[str] = set()
    stripped = 0
    out_lines = []
    for line in answer.split("\n"):
        kept = []
        for sentence in re.split(r"(?<=[.!?])\s+(?=[A-Z•\-*])", line):
            found = MARKER.findall(sentence)
            if found and not any(f in valid_ids for f in found):
                stripped += len(found)
                continue

            def keep(m: re.Match[str]) -> str:
                nonlocal stripped
                if m.group(1) in valid_ids:
                    used.add(m.group(1))
                    return m.group(0)
                stripped += 1
                return ""

            kept.append(MARKER.sub(keep, sentence))
        cleaned = re.sub(r"[ \t]+([.,;:])", r"\1", " ".join(kept))
        out_lines.append(re.sub(r"[ \t]{2,}", " ", cleaned).rstrip())
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(out_lines)).strip()
    return text, used, stripped


def extractive_answer(sources: Sources) -> str:
    """The answer without a language model: the retrieved figures and passages themselves, each with its marker."""
    parts = []
    if sources.figures:
        parts.append("Figures that match your question:\n" + "\n".join(f"• {f['text']} [{f['id']}]" for f in sources.figures[:10]))
    if sources.documents:
        lines = []
        for d in sources.documents[:4]:
            ex = re.sub(r"\s+", " ", d["excerpt"].replace("«", "").replace("»", "")).strip()
            lines.append(f"• {ex} [{d['id']}]")
        parts.append("Passages from the uploaded documents:\n" + "\n".join(lines))
    return "\n\n".join(parts)
