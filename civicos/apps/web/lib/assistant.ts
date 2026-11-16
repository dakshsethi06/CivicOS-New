export type Fact = { text: string; source: string };
export type ChunkHit = { chunk_id: number; document_id: string; title: string; category: string; source: string | null; page: number | null; content: string; excerpt: string; coverage: number };
export type Citation =
  | { id: string; kind: "figure"; text: string; source: string }
  | { id: string; kind: "document"; title: string; page: number | null; excerpt: string; document_id: string };
export type Mode = "llm" | "extractive" | "none";

export const NOT_ESTABLISHED = "The available documents and published figures do not establish this.";

export const SYSTEM_PROMPT = `You are the CivicOS assistant for a municipal corporation.
Answer ONLY from the numbered sources in the user's message. Sources marked [F#] are published figures; sources marked [D#] are excerpts from uploaded documents.
Rules:
- After every sentence that states a fact, cite the sources it came from, like [F2] or [D1][D3]. Use only markers that appear in the sources.
- Do not use outside knowledge. Do not guess, estimate or extrapolate beyond the sources.
- If the sources do not answer the question, reply exactly: "${NOT_ESTABLISHED}"
- If they answer only part of it, answer that part and say what is not covered.
- Be concise: at most six sentences or a short list. Plain language. No preamble.`;

export function buildSources(facts: Fact[], chunks: ChunkHit[]): { citations: Citation[]; prompt: string } {
  const citations: Citation[] = [
    ...facts.map((f, i): Citation => ({ id: `F${i + 1}`, kind: "figure", text: f.text, source: f.source })),
    ...chunks.map((c, i): Citation => ({ id: `D${i + 1}`, kind: "document", title: c.title, page: c.page, excerpt: c.excerpt, document_id: c.document_id })),
  ];
  const lines = [
    ...facts.map((f, i) => `[F${i + 1}] ${f.text} (${f.source})`),
    ...chunks.map((c, i) => `[D${i + 1}] From "${c.title}"${c.page ? `, page ${c.page}` : ""}:\n${c.content}`),
  ];
  return { citations, prompt: lines.join("\n\n") };
}

const MARKER = /\[([FD]\d+)\]/g;

/** Removes citation markers that do not point at a retrieved source. Returns the cleaned text and the markers that remain. */
export function validateAnswer(answer: string, citations: Citation[]): { text: string; used: string[]; stripped: number } {
  const valid = new Set(citations.map((c) => c.id));
  const used = new Set<string>();
  let stripped = 0;
  const ids = (t: string) => [...t.matchAll(new RegExp(MARKER.source, "g"))].map((m) => m[1]);
  const text = answer
    .split("\n")
    .map((line) =>
      line
        .split(/(?<=[.!?])\s+(?=[A-Z•\-])/)
        // a sentence whose only citations point at sources that do not exist is dropped whole, not left standing uncited
        .filter((sentence) => {
          const found = ids(sentence);
          if (found.length && !found.some((id) => valid.has(id))) {
            stripped += found.length;
            return false;
          }
          return true;
        })
        .join(" ")
        .replace(new RegExp(MARKER.source, "g"), (m, id: string) => {
          if (valid.has(id)) {
            used.add(id);
            return m;
          }
          stripped += 1;
          return "";
        })
        .replace(/[ \t]+([.,;])/g, "$1")
        .replace(/[ \t]{2,}/g, " ")
        .trimEnd(),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, used: [...used], stripped };
}

/** Answer without a language model: the retrieved figures and excerpts themselves, each with its marker. */
export function extractiveAnswer(facts: Fact[], chunks: ChunkHit[]): string {
  const parts: string[] = [];
  if (facts.length) parts.push("Published figures that match your question:\n" + facts.map((f, i) => `• ${f.text} [F${i + 1}]`).join("\n"));
  if (chunks.length) {
    parts.push(
      "Passages from the uploaded documents:\n" +
        chunks.slice(0, 4).map((c, i) => `• ${c.excerpt.replace(/[«»]/g, "").replace(/\s+/g, " ").trim()} [D${i + 1}]`).join("\n"),
    );
  }
  return parts.join("\n\n");
}
