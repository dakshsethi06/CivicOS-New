"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ingestDocument } from "@/app/(app)/assistant/actions";
import { createClient } from "@/lib/supabase/client";

const CATEGORIES = ["Policy", "Regulation", "Guideline", "Development plan", "Report", "Notice", "Manual", "Other"];
const inputCls = "w-full rounded-lg border border-line bg-raised px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none";

/** Uploads straight from the browser to private storage (large PDFs never pass through the web server), then asks the server to read it. */
export function UploadForm({ orgId }: { orgId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) return setResult({ ok: false, message: "Choose a file." });
    if (file.size > 20 * 1024 * 1024) return setResult({ ok: false, message: "The file is larger than 20 MB." });

    setResult(null);
    setBusy("Uploading…");
    const ext = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "bin";
    const path = `${orgId}/${crypto.randomUUID()}.${ext}`;
    const mime = file.type || (ext === "pdf" ? "application/pdf" : ext === "csv" ? "text/csv" : "text/plain");
    const { error } = await createClient().storage.from("documents").upload(path, file, { contentType: mime });
    if (error) {
      setBusy(null);
      return setResult({ ok: false, message: `Upload failed: ${error.message}` });
    }

    setBusy("Reading the document…");
    const res = await ingestDocument({
      path, name: file.name, mime,
      title: String(fd.get("title") ?? ""), category: String(fd.get("category") ?? "Other"),
      access: String(fd.get("access") ?? "staff"), source: String(fd.get("source") ?? ""),
    });
    setBusy(null);
    setResult(res);
    if (res.ok) form.reset();
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2">
      <label className="block text-xs text-muted sm:col-span-2">
        File (PDF, DOCX, TXT or CSV, up to 20 MB)
        <input type="file" name="file" required accept=".pdf,.docx,.txt,.csv" className="mt-1 block w-full text-sm text-muted file:mr-3 file:rounded-lg file:border file:border-line file:bg-raised file:px-3 file:py-2 file:text-sm file:text-ink" />
      </label>
      <label className="block text-xs text-muted">
        Title
        <input name="title" required className={`mt-1 ${inputCls}`} placeholder="Solid Waste Management Rules 2016" />
      </label>
      <label className="block text-xs text-muted">
        Publisher or source
        <input name="source" className={`mt-1 ${inputCls}`} placeholder="Ministry of Environment" />
      </label>
      <label className="block text-xs text-muted">
        Category
        <select name="category" defaultValue="Report" className={`mt-1 ${inputCls}`}>
          {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
        </select>
      </label>
      <label className="block text-xs text-muted">
        Who can ask about it
        <select name="access" defaultValue="staff" className={`mt-1 ${inputCls}`}>
          <option value="staff">Staff only</option>
          <option value="public">Staff and residents</option>
        </select>
      </label>
      <div className="flex items-center gap-3 sm:col-span-2">
        <button type="submit" disabled={busy != null} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:brightness-110 disabled:opacity-50">
          {busy ?? "Add document"}
        </button>
        {result ? <p role="status" className={`text-sm ${result.ok ? "text-accent" : "text-danger"}`}>{result.message}</p> : null}
      </div>
    </form>
  );
}
