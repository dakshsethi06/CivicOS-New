"use server";

import { redirect } from "next/navigation";
import { ApiError, apiConfigured, callApi } from "@/lib/api";
import { requireSession } from "@/lib/auth";
import { buildSources, extractiveAnswer, NOT_ESTABLISHED, SYSTEM_PROMPT, validateAnswer, type ChunkHit, type Citation, type Fact, type Mode } from "@/lib/assistant";
import { extractChunks } from "@/lib/extract";
import { chat, llmConfigured } from "@/lib/llm";
import { createClient } from "@/lib/supabase/server";

type Retrieved = { allowed: boolean; limit: number | null; used: number; facts?: Fact[]; chunks?: ChunkHit[] };

/**
 * With the CivicOS API: semantic + keyword retrieval over the documents, routed tool calls for figures, wards and live
 * complaints, an answer written by Gemini from those sources only, citations checked, saved.
 * Without it: the built-in keyword retrieval below.
 */
export async function ask(formData: FormData) {
  await requireSession();
  const question = String(formData.get("question") ?? "").trim().slice(0, 600);
  const conversation = String(formData.get("conversation") ?? "") || null;
  const back = (c: string | null, error?: string) =>
    redirect(`/assistant${c ? `?c=${c}` : ""}${error ? `${c ? "&" : "?"}error=${encodeURIComponent(error)}` : ""}`);
  if (question.length < 3) back(conversation, "Ask a question.");

  if (apiConfigured()) {
    let conv: string | null = null;
    try {
      const r = await callApi<{ conversation_id: string }>("/v1/assistant/ask", { question, conversation_id: conversation });
      conv = r.conversation_id;
    } catch (e) {
      back(conversation, e instanceof ApiError ? e.message : "The assistant failed. Try again.");
    }
    redirect(`/assistant?c=${conv}`);
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("assistant_retrieve", { p_question: question });
  if (error || !data) back(conversation, error?.message ?? "Retrieval failed.");
  const r = data as Retrieved;
  if (!r.allowed) back(conversation, `This workspace has used its ${r.limit} assistant questions for the month. A City Administrator can change the plan in Settings.`);

  const facts = r.facts ?? [];
  const chunks = r.chunks ?? [];
  const { citations, prompt } = buildSources(facts, chunks);

  let answer = NOT_ESTABLISHED;
  let mode: Mode = "none";
  let shown: Citation[] = [];
  let note = "";

  if (citations.length > 0) {
    answer = extractiveAnswer(facts, chunks);
    mode = "extractive";
    shown = citations.filter((c) => answer.includes(`[${c.id}]`));

    if (llmConfigured()) {
      try {
        const raw = await chat(SYSTEM_PROMPT, `Question: ${question}\n\nSources:\n\n${prompt}`);
        const v = validateAnswer(raw, citations);
        if (v.text.includes(NOT_ESTABLISHED)) {
          answer = NOT_ESTABLISHED;
          mode = "llm";
          shown = [];
        } else if (v.used.length > 0) {
          answer = v.text;
          mode = "llm";
          shown = citations.filter((c) => v.used.includes(c.id));
          if (v.stripped > 0) note = " (Part of the answer cited a source that does not exist and was removed.)";
        }
        // an answer with no valid citation is not trusted: the extractive answer stands
      } catch {
        note = " (The language model could not be reached, so the sources are shown directly.)";
      }
    }
  }

  const { data: conv, error: saveError } = await supabase.rpc("assistant_save", {
    p_conversation: conversation,
    p_question: question,
    p_answer: answer + note,
    p_citations: shown,
    p_chunk_ids: chunks.map((c) => c.chunk_id),
    p_fact_count: facts.length,
    p_mode: mode,
  });
  if (saveError) back(conversation, saveError.message);
  redirect(`/assistant?c=${conv as string}`);
}

type IngestInput = { path: string; name: string; mime: string; title: string; category: string; access: string; source: string };

/** Called after the browser has uploaded the file to storage: reads it back, extracts text, stores the chunks. */
export async function ingestDocument(input: IngestInput): Promise<{ ok: boolean; message: string }> {
  const session = await requireSession();
  if (session.role !== "city_admin" && session.role !== "dept_officer") return { ok: false, message: "Only officers can add documents." };
  if (!input.path.startsWith(`${session.orgId}/`)) return { ok: false, message: "Invalid file path." };
  const supabase = await createClient();

  const { data: id, error } = await supabase.rpc("document_create", {
    p_title: input.title || input.name,
    p_category: input.category,
    p_access: input.access === "public" ? "public" : "staff",
    p_storage_path: input.path,
    p_mime: input.mime,
    p_source: input.source,
  });
  if (error || !id) {
    await supabase.storage.from("documents").remove([input.path]);
    return { ok: false, message: error?.message ?? "Could not register the document." };
  }

  if (apiConfigured()) {
    // the API reads the file back, cleans and chunks it, embeds every chunk and stores the vectors
    try {
      const r = await callApi<{ pages: number; chunks: number; embedded: boolean; warning: string | null }>(`/v1/documents/${id}/ingest`, undefined, 280_000);
      return {
        ok: true,
        message: `Added ${r.pages} page${r.pages === 1 ? "" : "s"} as ${r.chunks} passages${r.embedded ? ", indexed for semantic search" : ""}.${r.warning ? ` ${r.warning}` : ""}`,
      };
    } catch (e) {
      return { ok: false, message: e instanceof ApiError ? e.message : "Processing failed." };
    }
  }

  try {
    const file = await supabase.storage.from("documents").download(input.path);
    if (file.error || !file.data) throw new Error(file.error?.message ?? "Could not read the uploaded file.");
    const { chunks, pages } = await extractChunks(new Uint8Array(await file.data.arrayBuffer()), input.mime, input.name);
    const { data: n, error: finishError } = await supabase.rpc("document_finish", { p_document: id, p_chunks: chunks, p_page_count: pages });
    if (finishError) throw new Error(finishError.message);
    if (!n) return { ok: false, message: "No text could be read from this file. Scanned PDFs without a text layer are not supported." };
    return { ok: true, message: `Added ${pages} page${pages === 1 ? "" : "s"} as ${n} searchable passages.` };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Processing failed.";
    await supabase.rpc("document_finish", { p_document: id, p_chunks: [], p_page_count: 0, p_error: message });
    return { ok: false, message };
  }
}

/** Embeds every passage that has no vector yet, e.g. documents added before semantic search was switched on. */
export async function reindexDocuments() {
  const session = await requireSession();
  if (session.role !== "city_admin" && session.role !== "dept_officer") redirect("/assistant");
  let message: string;
  try {
    const r = await callApi<{ embedded: number }>("/v1/documents/reindex", undefined, 280_000);
    message = r.embedded ? `Indexed ${r.embedded} passages for semantic search.` : "Every passage is already indexed.";
  } catch (e) {
    message = e instanceof ApiError ? e.message : "Re-indexing failed.";
  }
  redirect(`/assistant/documents?note=${encodeURIComponent(message)}`);
}

export async function deleteDocument(formData: FormData) {
  await requireSession();
  const supabase = await createClient();
  const id = String(formData.get("id") ?? "");
  const { data } = await supabase.from("documents").select("storage_path").eq("id", id).maybeSingle();
  await supabase.from("documents").delete().eq("id", id);
  if (data?.storage_path) await supabase.storage.from("documents").remove([data.storage_path]);
  redirect("/assistant/documents");
}
