import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { UploadForm } from "@/components/assistant/upload-form";
import { apiConfigured } from "@/lib/api";
import { requireSession } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { deleteDocument, reindexDocuments } from "../actions";

export const metadata: Metadata = { title: "Documents" };

type Doc = {
  id: string; title: string; category: string; source: string | null; access_level: string; status: string; error: string | null;
  page_count: number | null; chunk_count: number; created_at: string; embedding_model?: string | null;
};

export default async function DocumentsPage({ searchParams }: PageProps<"/assistant/documents">) {
  const session = await requireSession();
  if (session.role !== "city_admin" && session.role !== "dept_officer") redirect("/assistant");
  const sp = await searchParams;
  const api = apiConfigured();
  const supabase = await createClient();
  // embedding_model exists once migration 0017 has run, which the API requires
  const cols = `id, title, category, source, access_level, status, error, page_count, chunk_count, created_at${api ? ", embedding_model" : ""}`;
  const { data } = await supabase.from("documents").select(cols).order("created_at", { ascending: false });
  const docs = (data ?? []) as unknown as Doc[];
  const unindexed = api ? docs.filter((d) => d.status === "ready" && !d.embedding_model).length : 0;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <Link href="/assistant" className="text-xs text-muted hover:text-ink">← Assistant</Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Documents</h1>
        <p className="mt-1 text-sm text-muted">
          The assistant&apos;s knowledge base: policies, regulations, reports and notices. Upload only documents you are allowed to use.
        </p>
      </div>

      <section className="rounded-xl border border-line bg-panel p-5">
        <h2 className="mb-4 text-sm font-medium">Add a document</h2>
        <UploadForm orgId={session.orgId} />
      </section>

      {typeof sp.note === "string" ? <p role="status" className="rounded-lg border border-line bg-panel px-4 py-3 text-sm text-muted">{sp.note}</p> : null}
      {unindexed > 0 ? (
        <form action={reindexDocuments} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-panel px-5 py-4">
          <p className="text-sm text-muted">
            {unindexed} document{unindexed === 1 ? " is" : "s are"} searchable by keywords only. Index {unindexed === 1 ? "it" : "them"} for semantic search, so questions worded differently from the text still find the right passage.
          </p>
          <button type="submit" className="rounded-lg border border-line px-3 py-2 text-sm text-ink hover:bg-raised">Index for semantic search</button>
        </form>
      ) : null}

      <section className="overflow-x-auto rounded-xl border border-line bg-panel">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="border-b border-line text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5 font-medium">Document</th>
              <th className="px-4 py-2.5 font-medium">Category</th>
              <th className="px-4 py-2.5 font-medium">Access</th>
              <th className="px-4 py-2.5 text-right font-medium">Pages</th>
              <th className="px-4 py-2.5 text-right font-medium">Passages</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {docs.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-muted">No documents yet.</td></tr>
            ) : null}
            {docs.map((d) => (
              <tr key={d.id}>
                <td className="px-4 py-3">
                  <span className="text-ink">{d.title}</span>
                  {d.source ? <span className="block text-xs text-faint">{d.source}</span> : null}
                </td>
                <td className="px-4 py-3 text-muted">{d.category}</td>
                <td className="px-4 py-3 text-muted">{d.access_level === "public" ? "Staff and residents" : "Staff only"}</td>
                <td className="px-4 py-3 text-right tabular-nums text-muted">{d.page_count ?? "—"}</td>
                <td className="px-4 py-3 text-right tabular-nums text-muted">{d.chunk_count}</td>
                <td className="px-4 py-3">
                  <span className={d.status === "ready" ? "text-accent" : d.status === "failed" ? "text-danger" : "text-muted"}>
                    {d.status === "ready" ? "Ready" : d.status === "failed" ? "Failed" : "Processing"}
                  </span>
                  {api && d.status === "ready" ? (
                    <span className="block text-xs text-faint">{d.embedding_model ? "Semantic + keyword search" : "Keyword search only"}</span>
                  ) : null}
                  {d.error ? <span className="block max-w-xs text-xs text-faint">{d.error}</span> : null}
                </td>
                <td className="px-4 py-3 text-right">
                  <form action={deleteDocument}>
                    <input type="hidden" name="id" value={d.id} />
                    <button type="submit" className="text-xs text-muted hover:text-danger">Delete</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
