import "server-only";

export type Chunk = { page: number; content: string };

const TARGET = 1100; // characters per chunk
const OVERLAP = 150;

/** Splits one page of text into overlapping chunks, breaking at paragraph or sentence ends where it can. */
export function chunkPage(text: string, page: number): Chunk[] {
  const clean = text.replace(/\u0000/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (clean.length < 40) return []; // page numbers, blank pages
  const chunks: Chunk[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + TARGET, clean.length);
    if (end < clean.length) {
      const window = clean.slice(start + TARGET * 0.6, end);
      const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf(". "), window.lastIndexOf("\n"));
      if (cut > 0) end = Math.floor(start + TARGET * 0.6) + cut + 1;
    }
    chunks.push({ page, content: clean.slice(start, end).trim() });
    if (end >= clean.length) break;
    start = end - OVERLAP;
  }
  return chunks;
}

/** Reads a PDF, DOCX, TXT or CSV file into page-numbered chunks. Scanned PDFs with no text layer return no chunks. */
export async function extractChunks(bytes: Uint8Array, mime: string, name: string): Promise<{ chunks: Chunk[]; pages: number }> {
  const lower = name.toLowerCase();
  if (mime === "application/pdf" || lower.endsWith(".pdf")) {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(bytes);
    const { text, totalPages } = await extractText(pdf, { mergePages: false });
    return { chunks: (text as string[]).flatMap((t, i) => chunkPage(t, i + 1)), pages: totalPages };
  }
  if (lower.endsWith(".docx") || mime.includes("wordprocessingml")) {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return { chunks: chunkPage(value, 1), pages: 1 }; // Word files have no fixed pages
  }
  const text = new TextDecoder("utf-8").decode(bytes);
  if (lower.endsWith(".csv") || mime === "text/csv") {
    // keep the header with every block of rows so each chunk is readable on its own
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const header = lines[0] ?? "";
    const chunks: Chunk[] = [];
    for (let i = 1; i < lines.length; i += 25) chunks.push({ page: 1, content: [header, ...lines.slice(i, i + 25)].join("\n") });
    return { chunks, pages: 1 };
  }
  return { chunks: chunkPage(text, 1), pages: 1 };
}
