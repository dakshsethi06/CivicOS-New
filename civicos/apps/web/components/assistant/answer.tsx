import { AnswerCharts, type AnswerChart } from "@/components/assistant/answer-charts";
import type { Citation, Mode } from "@/lib/assistant";

export type { AnswerChart };

const MODE_NOTE: Record<Mode, string> = {
  llm: "Written by the language model using only the sources below. Citations were checked against them.",
  extractive: "No language model is configured, so these are the retrieved sources themselves.",
  none: "Nothing relevant was found in the uploaded documents or the published figures.",
};

/** An assistant answer: text with citation chips, any charts of the cited figures, then the cited sources. */
export function Answer({ content, citations, mode, charts = [] }: { content: string; citations: Citation[]; mode: Mode | null; charts?: AnswerChart[] }) {
  const parts = content.split(/(\[[FD]\d+\])/g);
  return (
    <div>
      <div className="whitespace-pre-wrap text-sm leading-relaxed text-ink">
        {parts.map((p, i) => {
          const m = p.match(/^\[([FD]\d+)\]$/);
          return m ? (
            <a key={i} href={`#src-${m[1]}`} className="mx-0.5 inline-block rounded border border-accent/40 px-1 align-baseline font-mono text-[10px] text-accent hover:bg-accent/10">
              {m[1]}
            </a>
          ) : (
            <span key={i}>{p}</span>
          );
        })}
      </div>
      {charts.length ? <AnswerCharts charts={charts} /> : null}
      {mode ? <p className="mt-3 text-xs text-faint">{MODE_NOTE[mode]}</p> : null}
      {citations.length ? (
        <ol className="mt-3 space-y-2 border-t border-line pt-3">
          {citations.map((c) => (
            <li key={c.id} id={`src-${c.id}`} className="grid grid-cols-[34px_1fr] gap-2 text-xs">
              <span className="font-mono text-[10px] text-accent">{c.id}</span>
              {c.kind === "figure" ? (
                <span>
                  <span className="text-ink">{c.text}</span>
                  <span className="block text-faint">{c.source}</span>
                </span>
              ) : (
                <span>
                  <a
                    href={`/assistant/documents/${c.document_id}/open${c.page ? `?page=${c.page}` : ""}`}
                    target="_blank"
                    rel="noopener"
                    className="text-ink underline decoration-line underline-offset-2 hover:decoration-accent"
                    title="Open the source document"
                  >
                    {c.title}
                    {c.page ? `, page ${c.page}` : ""}
                  </a>
                  {c.section ? <span className="text-faint"> · {c.section}</span> : null}
                  <span className="mt-0.5 block leading-relaxed text-muted">
                    …{c.excerpt.split(/[«»]/).map((s, i) => (i % 2 ? <mark key={i} className="bg-transparent font-medium text-ink">{s}</mark> : <span key={i}>{s}</span>))}…
                  </span>
                </span>
              )}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
