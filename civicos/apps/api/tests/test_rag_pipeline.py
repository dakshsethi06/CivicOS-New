import io

from app.rag.chunking import chunk_pages, heading_of
from app.rag.extract import Page, clean, drop_running_lines, extract


def test_heading_detection():
    assert heading_of("3.2 Collection of waste") == "3.2 Collection of waste"
    assert heading_of("CHAPTER IV") == "CHAPTER IV" or heading_of("CHAPTER IV") == "Chapter Iv"
    assert heading_of("SOLID WASTE RULES") == "Solid Waste Rules"
    assert heading_of("## Duties of generators") == "Duties of generators"
    assert heading_of("Every generator shall segregate waste.") is None
    assert heading_of("x") is None


def test_chunks_respect_size_overlap_pages_and_sections():
    para = " ".join(f"Sentence {i} about collection of segregated waste from households." for i in range(60))
    pages = [Page(1, f"1. Introduction\n\n{para}"), Page(2, f"2. Duties of generators\n\n{para}")]
    chunks = chunk_pages(pages, size=600, overlap=100)
    assert len(chunks) > 6
    assert all(len(c.content) <= 700 for c in chunks)           # size plus a carried overlap
    assert [c.index for c in chunks] == list(range(len(chunks)))
    assert {c.page for c in chunks} == {1, 2}
    assert all(c.section == "1. Introduction" for c in chunks if c.page == 1)
    assert all(c.section == "2. Duties of generators" for c in chunks if c.page == 2)
    # consecutive chunks of one section overlap
    first, second = chunks[0], chunks[1]
    assert second.content.split()[0] in first.content
    assert chunks[0].embedding_text().startswith("1. Introduction\n\n")


def test_section_carries_across_pages_and_short_pages_are_skipped():
    chunks = chunk_pages([Page(1, "Water Supply Rules\n\nSupply shall be given twice daily in every ward of the city."),
                          Page(2, "The timings shall be published on the ward notice board each month."),
                          Page(3, "12")])
    assert [c.page for c in chunks] == [1, 2]
    assert chunks[1].section == "Water Supply Rules"


def test_clean_and_running_headers():
    assert clean("compost-\ning  is\t\tgood\n\n\n\nnext") == "composting is good\n\nnext"
    pages = [Page(i, f"Municipal Gazette\nBody text of page {i} with rules.\nPage {i} of 5") for i in range(1, 6)]
    out = drop_running_lines(pages)
    assert all("Gazette" not in p.text and "of 5" not in p.text for p in out)
    assert all("Body text" in p.text for p in out)


def test_extract_txt_and_csv():
    assert extract("Plain text rule.".encode(), "a.txt")[0].text == "Plain text rule."
    csv = "ward,complaints\nA,1988\nB,3045\n"
    text = extract(csv.encode(), "data.csv", "text/csv")[0].text
    assert "ward: A; complaints: 1988" in text and "ward: B" in text


def test_extract_docx_marks_headings():
    import docx

    d = docx.Document()
    d.add_heading("Duties of the corporation", level=1)
    d.add_paragraph("The corporation shall collect segregated waste daily from every household.")
    buf = io.BytesIO()
    d.save(buf)
    pages = extract(buf.getvalue(), "rules.docx")
    chunks = chunk_pages(pages)
    assert chunks and chunks[0].section == "Duties of the corporation"
    assert "collect segregated waste" in chunks[0].content


def _tiny_pdf(texts: list[str]) -> bytes:
    """A minimal valid PDF with one text line per page (no external tools needed)."""
    objs, kids = [], []
    font_id = 3 + 2 * len(texts)
    for i, t in enumerate(texts):
        page_id, content_id = 3 + 2 * i, 4 + 2 * i
        kids.append(f"{page_id} 0 R")
        stream = f"BT /F1 12 Tf 72 720 Td ({t}) Tj ET".encode()
        objs.append((page_id, f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {content_id} 0 R "
                              f"/Resources << /Font << /F1 {font_id} 0 R >> >> >>".encode()))
        objs.append((content_id, b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream"))
    objs = [(1, b"<< /Type /Catalog /Pages 2 0 R >>"),
            (2, f"<< /Type /Pages /Kids [{' '.join(kids)}] /Count {len(texts)} >>".encode())] + objs
    objs.append((font_id, b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"))
    out, offsets = bytearray(b"%PDF-1.4\n"), {}
    for n, body in sorted(objs):
        offsets[n] = len(out)
        out += f"{n} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    out += b"".join(f"{offsets[n]:010d} 00000 n \n".encode() for n in sorted(offsets))
    out += f"trailer << /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF".encode()
    return bytes(out)


def test_extract_pdf_keeps_page_numbers():
    pages = extract(_tiny_pdf(["Bulk generators shall compost on site.", "Sweeping shall be daily in markets."]), "r.pdf")
    assert [p.number for p in pages] == [1, 2]
    assert "compost on site" in pages[0].text and "Sweeping" in pages[1].text
