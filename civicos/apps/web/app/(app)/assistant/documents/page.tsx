import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { UploadForm } from "@/components/assistant/upload-form";
import { requireSession } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { deleteDocument } from "../actions";

export const metadata: Metadata = { title: "Documents" };

export default async function DocumentsPage() {
  const session = await requireSession();
  if (session.role !== "city_admin" && session.role !== "dept_officer") redirect("/assistant");
  const supabase = await createClient();
  const { data: docs } = await supabase
    .from("documents")
    .select("id, title, category, source, access_level, status, error, page_count, chunk_count, created_at")
    .order("created_at", { ascending: false });

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
            {(docs ?? []).length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-muted">No documents yet.</td></tr>
            ) : null}
            {(docs ?? []).map((d) => (
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
