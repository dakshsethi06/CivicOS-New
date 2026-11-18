"""Splits pages into overlapping chunks that keep paragraphs and sentences whole where possible.

Each chunk remembers its page and the nearest section heading above it (carried across pages), which is stored as
metadata, shown with citations, and prepended to the text that is embedded so a passage is found by its topic too.
"""
import re
from dataclasses import dataclass

from .extract import Page


@dataclass
class Chunk:
    index: int
    page: int
    section: str | None
    content: str

    def embedding_text(self) -> str:
        return f"{self.section}\n\n{self.content}" if self.section else self.content


_NUMBERED = re.compile(r"^((chapter|part|section|schedule|annexure|appendix|rule|article)\b|\d+(\.\d+)*[.)]?\s+[A-Z])", re.I)


_SMALL_WORDS = {"a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "with"}


def heading_of(line: str, standalone: bool = False) -> str | None:
    """A line that reads like a heading: '## X' (from Word styles), numbered ('3.2 Collection'), upper-case, or, when
    it stands alone as a paragraph, short Title Case text. Never one ending in a full stop or comma."""
    s = line.strip()
    if s.startswith("## "):
        return s[3:].strip() or None
    if not (3 <= len(s) <= 90) or s.endswith((".", ",", ";", ":")) or s.count(" ") > 12:
        return None
    if _NUMBERED.match(s):
        return s
    letters = [c for c in s if c.isalpha()]
    if len(letters) >= 4 and sum(c.isupper() for c in letters) / len(letters) > 0.8:
        return s.title() if s.isupper() else s
    words = [w for w in re.findall(r"[A-Za-z][\w'-]*", s) if w.lower() not in _SMALL_WORDS]
    if standalone and 1 <= len(words) <= 8 and all(w[0].isupper() for w in words):
        return s
    return None


def _sentences(par: str) -> list[str]:
    return [p for p in re.split(r"(?<=[.!?;])\s+(?=[A-Z0-9(\"'])", par) if p.strip()]


def _pieces(text: str, size: int) -> list[tuple[str, str | None]]:
    """Paragraph-sized pieces, each paired with the heading it falls under; paragraphs longer than `size` are split
    at sentence ends (or hard-cut if a sentence alone is too long)."""
    out: list[tuple[str, str | None]] = []
    section = None
    for par in re.split(r"\n\s*\n|\n(?=## )", text):
        lines = [ln for ln in par.split("\n") if ln.strip()]
        if not lines:
            continue
        h = heading_of(lines[0], standalone=len(lines) == 1 or bool(_NUMBERED.match(lines[0].strip())))
        if h:
            section = h
            lines = lines[1:]
            if not lines:
                out.append(("", section))      # heading on its own: updates the section only
                continue
        body = " ".join(ln.strip() for ln in lines)
        if len(body) <= size:
            out.append((body, section))
            continue
        buf = ""
        for s in _sentences(body):
            while len(s) > size:                # a single sentence longer than a chunk
                out.append((s[:size], section))
                s = s[size:]
            if buf and len(buf) + 1 + len(s) > size:
                out.append((buf, section))
                buf = s
            else:
                buf = f"{buf} {s}".strip()
        if buf:
            out.append((buf, section))
    return out


def chunk_pages(pages: list[Page], size: int = 1100, overlap: int = 160) -> list[Chunk]:
    chunks: list[Chunk] = []
    section: str | None = None
    for page in pages:
        buf: list[str] = []
        buf_section = section

        def flush() -> None:
            content = "\n\n".join(buf).strip()
            if len(content) >= 40:                              # page numbers, stray captions
                chunks.append(Chunk(len(chunks), page.number, buf_section, content))

        for piece, sec in _pieces(page.text, size):
            if sec is not None and sec != section:
                # a new section starts a new chunk, so a chunk never mixes two sections
                if buf:
                    flush()
                    buf = []
                section = sec
                buf_section = sec
            if not piece:
                continue
            if buf and sum(len(b) + 2 for b in buf) + len(piece) > size:
                flush()
                tail = buf[-1][-overlap:] if overlap else ""
                # overlap: carry the end of the previous chunk, starting at a word boundary
                tail = tail[tail.find(" ") + 1:] if " " in tail else tail
                buf = [tail] if tail else []
                buf_section = section
            if not buf:
                buf_section = section
            buf.append(piece)
        if buf:
            flush()
    return chunks
