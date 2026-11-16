"""Text extraction and cleaning for PDF, DOCX, TXT and CSV.

Each format comes back as a list of Page(number, text). Word files have no fixed pages, so they are one page;
headings found in their styles are kept as lines that the chunker recognises as section titles.
"""
import csv
import io
import re
from collections import Counter
from dataclasses import dataclass


@dataclass
class Page:
    number: int
    text: str


class ExtractionError(ValueError):
    pass


def kind_of(name: str, mime: str | None) -> str:
    lower, mime = name.lower(), (mime or "").lower()
    if lower.endswith(".pdf") or mime == "application/pdf":
        return "pdf"
    if lower.endswith(".docx") or "wordprocessingml" in mime:
        return "docx"
    if lower.endswith(".csv") or mime == "text/csv":
        return "csv"
    return "txt"


def extract(data: bytes, name: str, mime: str | None = None) -> list[Page]:
    kind = kind_of(name, mime)
    if kind == "pdf":
        pages = _pdf(data)
    elif kind == "docx":
        pages = [Page(1, _docx(data))]
    elif kind == "csv":
        pages = [Page(1, _csv(data))]
    else:
        pages = [Page(1, _decode(data))]
    pages = [Page(p.number, clean(p.text)) for p in pages]
    if kind == "pdf":
        pages = drop_running_lines(pages)
    return pages


def _decode(data: bytes) -> str:
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def _pdf(data: bytes) -> list[Page]:
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError

    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            reader.decrypt("")
        return [Page(i + 1, page.extract_text() or "") for i, page in enumerate(reader.pages)]
    except (PdfReadError, ValueError, KeyError) as e:
        raise ExtractionError(f"Could not read this PDF: {e}") from e


def _docx(data: bytes) -> str:
    import docx

    try:
        d = docx.Document(io.BytesIO(data))
    except Exception as e:  # python-docx raises several unrelated types for a bad file
        raise ExtractionError(f"Could not read this Word file: {e}") from e
    lines: list[str] = []
    for p in d.paragraphs:
        t = p.text.strip()
        if not t:
            continue
        style = (p.style.name if p.style is not None else "") or ""
        # mark headings so the chunker can carry them as section titles
        lines.append(f"\n## {t}\n" if style.lower().startswith(("heading", "title")) else t)
    for table in d.tables:
        for row in table.rows:
            lines.append(" | ".join(c.text.strip() for c in row.cells))
    return "\n".join(lines)


def _csv(data: bytes) -> str:
    """Rows as 'column: value' lines, so each chunk is readable on its own and keeps the column names."""
    rows = list(csv.reader(io.StringIO(_decode(data))))
    if not rows:
        return ""
    header, body = rows[0], rows[1:]
    out = []
    for r in body:
        if not any(c.strip() for c in r):
            continue
        out.append("; ".join(f"{h.strip()}: {v.strip()}" for h, v in zip(header, r) if v.strip()))
    return "\n\n".join(out)


def clean(t: str) -> str:
    t = t.replace("\x00", "").replace("­", "")              # NULs, soft hyphens
    t = re.sub(r"(\w)-\n(\w)", r"\1\2", t)                       # words hyphenated across a line break
    t = re.sub(r"[ \t ]+", " ", t)
    t = re.sub(r" *\n *", "\n", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()


def drop_running_lines(pages: list[Page]) -> list[Page]:
    """Removes running headers and footers: a short first or last line repeated on at least 60% of pages (3 or more)."""
    if len(pages) < 3:
        return pages
    edge: Counter[str] = Counter()
    for p in pages:
        lines = [ln for ln in p.text.split("\n") if ln.strip()]
        if len(lines) < 2:
            continue
        for ln in {lines[0], lines[-1]}:
            edge[_norm(ln)] += 1
    running = {k for k, n in edge.items() if n >= 0.6 * len(pages) and len(k) < 120}
    if not running:
        return pages
    return [Page(p.number, "\n".join(ln for ln in p.text.split("\n") if _norm(ln) not in running).strip()) for p in pages]


def _norm(line: str) -> str:
    return re.sub(r"\d+", "#", line.strip().lower())   # "Page 3 of 40" and "Page 4 of 40" are the same footer
