import type { Metadata } from "next";
import Link from "next/link";
import { FileText, Plus } from "lucide-react";
import { Answer, type AnswerChart } from "@/components/assistant/answer";
import { ErrorNote } from "@/components/ui";
import { requireSession } from "@/lib/auth";
import type { Citation, Mode } from "@/lib/assistant";
import { apiConfigured } from "@/lib/api";
import { llmConfigured } from "@/lib/llm";
import { createClient } from "@/lib/supabase/server";
import { ask } from "./actions";

export const metadata: Metadata = { title: "Assistant" };

type History = {
  conversations: { id: string; title: string; created_at: string }[];
  messages: { role: "user" | "assistant"; content: string; citations: Citation[]; mode: Mode | null; charts?: AnswerChart[]; at: string }[];
  documents: number;
  usage: { used: number; limit: number | null };
};

const EXAMPLES = [
  "Which wards get the least water supply?",
  "How long does ward K/W take to close complaints?",
  "What is the complaint forecast for the next three years?",
  "What share of bulk waste generators do not process waste on site?",
  "Why is water consumption unusually high in ward K/W?",
  "Which zones have bins likely to overflow in the next 12 hours?",
  "When are the traffic peak hours, and where are the accident hotspots?",
];

export default async function AssistantPage({ searchParams }: PageProps<"/assistant">) {
  const session = await requireSession();
  const sp = await searchParams;
  const c = typeof sp.c === "string" && /^[0-9a-f-]{36}$/i.test(sp.c) ? sp.c : null;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("assistant_history", { p_conversation: c });
  const h = (data as History | null) ?? { conversations: [], messages: [], documents: 0, usage: { used: 0, limit: null } };
  const staff = session.role !== "citizen";
  const api = apiConfigured();
  const model = llmConfigured();

  return (
    <div className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-[1fr_260px]">
      <div className="space-y-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Assistant</h1>
          <p className="mt-1 text-sm text-muted">
            Answers come only from this workspace&apos;s uploaded documents and the published figures, with the source shown for every statement.
          </p>
        </div>
        <ErrorNote message={typeof sp.error === "string" ? sp.error : error?.message} />

        {h.messages.length === 0 ? (
          <div className="rounded-xl border border-line bg-panel p-5">
            <p className="text-sm text-muted">Try a question:</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {(session.role === "citizen" ? EXAMPLES.slice(0, 4) : EXAMPLES).map((q) => (
                <form key={q} action={ask}>
                  <input type="hidden" name="question" value={q} />
                  <button type="submit" className="rounded-lg border border-line px-3 py-1.5 text-left text-sm text-ink hover:bg-raised">{q}</button>
                </form>
              ))}
            </div>
            {h.documents === 0 ? (
              <p className="mt-4 text-xs text-faint">
                No documents have been uploaded yet, so answers can draw only on the published figures.
                {staff ? " Add policies, reports or notices under Documents." : ""}
              </p>
            ) : null}
          </div>
        ) : (
          <ol className="space-y-4">
            {h.messages.map((m, i) =>
              m.role === "user" ? (
                <li key={i} className="ml-auto max-w-[85%] rounded-xl bg-raised px-4 py-3 text-sm text-ink">{m.content}</li>
              ) : (
                <li key={i} className="rounded-xl border border-line bg-panel p-5">
                  <Answer content={m.content} citations={m.citations ?? []} mode={m.mode} charts={m.charts ?? []} />
                </li>
              ),
            )}
          </ol>
        )}

        <form action={ask} className="flex gap-2">
          {c ? <input type="hidden" name="conversation" value={c} /> : null}
          <input
            name="question" required minLength={3} maxLength={600} autoComplete="off" aria-label="Your question"
            placeholder="Ask about wards, water, waste, complaints, or your documents"
            className="h-11 min-w-0 flex-1 rounded-lg border border-line bg-raised px-3.5 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none"
          />
          <button type="submit" className="rounded-lg bg-accent px-5 text-sm font-semibold text-accent-ink hover:brightness-110">Ask</button>
        </form>
      </div>

      <aside className="space-y-4 text-sm">
        <Link href="/assistant" className="flex items-center justify-center gap-2 rounded-lg border border-line px-3 py-2 text-ink hover:bg-raised">
          <Plus className="size-4" aria-hidden="true" /> New conversation
        </Link>
        <div className="rounded-xl border border-line bg-panel p-4 text-xs text-muted">
          <p>
            <span className="font-medium text-ink">{h.documents}</span> document{h.documents === 1 ? "" : "s"} searchable
          </p>
          <p className="mt-1">
            <span className="font-medium tabular-nums text-ink">{h.usage.used}</span>
            {h.usage.limit != null ? ` of ${h.usage.limit}` : ""} questions this month
          </p>
          <p className="mt-1">
            {api
              ? "CivicOS API: semantic search over documents, with figures, ward profiles and live complaints as tools."
              : model ? "Language model: connected (keyword search)." : "Language model: not configured. Sources are shown directly."}
          </p>
          {staff && session.role !== "field_worker" ? (
            <Link href="/assistant/documents" className="mt-3 inline-flex items-center gap-1.5 text-accent hover:underline">
              <FileText className="size-3.5" aria-hidden="true" /> Manage documents
            </Link>
          ) : null}
        </div>
        {h.conversations.length ? (
          <div>
            <p className="mb-2 text-xs font-medium text-muted">Recent</p>
            <ul className="space-y-1">
              {h.conversations.map((x) => (
                <li key={x.id}>
                  <Link href={`/assistant?c=${x.id}`} aria-current={x.id === c ? "page" : undefined} className={`block truncate rounded-lg px-2.5 py-1.5 text-xs ${x.id === c ? "bg-raised text-ink" : "text-muted hover:text-ink"}`}>
                    {x.title}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </aside>
    </div>
  );
}
