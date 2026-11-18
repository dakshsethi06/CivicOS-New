import { when } from "@/lib/complaints";
import type { createClient } from "@/lib/supabase/server";
import { CONDITION_COLOR, type Report } from "@/lib/tasks";

type Supa = Awaited<ReturnType<typeof createClient>>;

/** Short-lived signed URLs for report photos in the private bucket. */
export async function signedPhotos(supabase: Supa, reports: Report[]): Promise<Record<string, string>> {
  const paths = reports.map((r) => r.photo_path).filter((p): p is string => Boolean(p));
  if (!paths.length) return {};
  const { data } = await supabase.storage.from("complaint-photos").createSignedUrls(paths, 600);
  return Object.fromEntries((data ?? []).flatMap((x) => (x.signedUrl && x.path ? [[x.path, x.signedUrl] as const] : [])));
}

export function Reports({ reports, photos }: { reports: Report[]; photos: Record<string, string> }) {
  if (!reports.length) return <p className="mt-2 text-xs text-muted">No report yet.</p>;
  return (
    <ol className="mt-3 space-y-4">
      {reports.map((r) => (
        <li key={r.id} className="border-l-2 pl-3 text-sm" style={{ borderColor: CONDITION_COLOR[r.condition] }}>
          <p className="text-xs text-muted">
            <span className="font-medium capitalize" style={{ color: CONDITION_COLOR[r.condition] }}>{r.condition}</span>
            {" · "}{r.author ?? "Staff"} · {when(r.created_at)}{r.needs_followup ? " · needs follow-up" : ""}
          </p>
          <p className="mt-1 whitespace-pre-wrap text-ink">{r.findings}</p>
          {r.action_taken ? <p className="mt-1 text-xs text-muted">Action taken: {r.action_taken}</p> : null}
          {r.photo_path && photos[r.photo_path] ? (
            // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL from private storage
            <img src={photos[r.photo_path]} alt="Inspection photo" className="mt-2 max-h-64 rounded-lg border border-line" />
          ) : null}
        </li>
      ))}
    </ol>
  );
}
