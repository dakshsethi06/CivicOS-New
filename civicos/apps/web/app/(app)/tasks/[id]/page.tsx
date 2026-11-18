import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SeverityBadge } from "@/components/complaints/badges";
import { InspectionForm } from "@/components/tasks/inspection-form";
import { Reports, signedPhotos } from "@/components/tasks/reports";
import { ErrorNote } from "@/components/ui";
import { requireSession } from "@/lib/auth";
import { when } from "@/lib/complaints";
import { ROLE_LABEL, type Role } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { KIND_LABEL, TASK_STATUS_LABEL, type TaskDetail } from "@/lib/tasks";
import { taskAction } from "../actions";

export const metadata: Metadata = { title: "Task" };

const btn = "w-full rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:brightness-110";
const quiet = "w-full rounded-lg border border-line px-4 py-2 text-sm text-ink hover:bg-raised";

export default async function TaskPage({ params, searchParams }: PageProps<"/tasks/[id]">) {
  const session = await requireSession();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();
  const { data } = await supabase.rpc("task_detail", { p_id: id });
  const d = data as TaskDetail | null;
  const t = d?.task;
  if (!d || !t) notFound();

  const officer = session.role === "city_admin" || session.role === "dept_officer";
  const mine = t.assignee_id === session.userId;
  const active = t.status === "open" || t.status === "in_progress";
  const photos = await signedPhotos(supabase, d.reports);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <Link href="/tasks" className="text-xs text-muted hover:text-ink">← Tasks</Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t.title}</h1>
          <SeverityBadge severity={t.priority} />
          <span className="rounded border border-line px-2 py-0.5 text-xs text-muted">{TASK_STATUS_LABEL[t.status]}</span>
        </div>
        <p className="mt-1 text-sm text-muted">
          <span className="font-mono">{t.reference}</span> · {KIND_LABEL[t.kind] ?? t.kind} · {t.ward ?? "Ward not set"}
          {t.department ? ` · ${t.department}` : ""} · created {when(t.created_at)}{t.created_by_name ? ` by ${t.created_by_name}` : ""}
        </p>
      </div>
      {sp.created ? <p role="status" className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-ink">Task created.</p> : null}
      {sp.reported ? <p role="status" className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-ink">Report filed.</p> : null}
      <ErrorNote message={typeof sp.error === "string" ? sp.error : undefined} />

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="space-y-6">
          <section className="rounded-xl border border-line bg-panel p-5 text-sm">
            <h2 className="font-medium">What to do</h2>
            <p className="mt-2 whitespace-pre-wrap leading-relaxed text-ink">{t.description ?? "No further details."}</p>
            <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-3">
              <div><dt className="text-muted">Assigned to</dt><dd className="mt-0.5 text-ink">{t.assignee ?? "Unassigned"}</dd></div>
              <div><dt className="text-muted">Due</dt><dd className="mt-0.5 text-ink">{t.due_at ? when(t.due_at) : "—"}</dd></div>
              <div><dt className="text-muted">Location</dt><dd className="mt-0.5 text-ink">
                {t.lat != null && t.lon != null
                  ? <a className="text-accent hover:underline" target="_blank" rel="noopener" href={`https://www.openstreetmap.org/?mlat=${t.lat}&mlon=${t.lon}#map=18/${t.lat}/${t.lon}`}>{t.lat.toFixed(5)}, {t.lon.toFixed(5)} (map)</a>
                  : "—"}
              </dd></div>
            </dl>
          </section>

          {t.complaint || t.anomaly || t.recommendation ? (
            <section className="rounded-xl border border-line bg-panel p-5 text-sm">
              <h2 className="font-medium">About</h2>
              {t.complaint ? (
                <p className="mt-2">Complaint <Link href={`/complaints/${t.complaint.id}`} className="font-mono text-accent hover:underline">{t.complaint.reference}</Link>: <span className="text-muted">{t.complaint.description}</span></p>
              ) : null}
              {t.anomaly ? (
                <p className="mt-2">Water anomaly at meter <span className="font-mono">{t.anomaly.sensor}</span> ({t.anomaly.level}, {t.anomaly.status}): <span className="text-muted">{t.anomaly.pattern}</span></p>
              ) : null}
              {t.recommendation ? (
                <div className="mt-2">
                  <p className="text-ink">{t.recommendation.problem}</p>
                  <p className="mt-1 text-muted">Suggested action: {t.recommendation.action}</p>
                  <p className="mt-1 text-xs text-faint">{t.recommendation.basis}</p>
                </div>
              ) : null}
            </section>
          ) : null}

          <section className="rounded-xl border border-line bg-panel p-5">
            <h2 className="text-sm font-medium">Inspection reports ({d.reports.length})</h2>
            <Reports reports={d.reports} photos={photos} />
          </section>
        </div>

        <aside className="space-y-4">
          {active && (mine || officer) ? (
            <section className="space-y-3 rounded-xl border border-line bg-panel p-5">
              <h2 className="text-sm font-medium">{t.status === "open" ? "Start" : "Report and finish"}</h2>
              {t.status === "open" ? (
                <form action={taskAction}><input type="hidden" name="id" value={t.id} /><input type="hidden" name="action" value="start" />
                  <button type="submit" className={btn}>Start work</button></form>
              ) : null}
              <InspectionForm task={t.id} canComplete />
            </section>
          ) : null}
          {officer ? (
            <section className="space-y-3 rounded-xl border border-line bg-panel p-5">
              <h2 className="text-sm font-medium">Manage</h2>
              {active ? (
                <form action={taskAction} className="space-y-2">
                  <input type="hidden" name="id" value={t.id} /><input type="hidden" name="action" value="reassign" />
                  <select name="assignee" required defaultValue={t.assignee_id ?? ""} className="w-full rounded-lg border border-line bg-raised px-3 py-2 text-sm text-ink">
                    <option value="" disabled>Choose a staff member</option>
                    {d.staff.map((u) => <option key={u.id} value={u.id}>{u.name} · {ROLE_LABEL[u.role as Role] ?? u.role}</option>)}
                  </select>
                  <button type="submit" className={quiet}>{t.assignee_id ? "Reassign" : "Assign"}</button>
                </form>
              ) : null}
              {active ? (
                <form action={taskAction}><input type="hidden" name="id" value={t.id} /><input type="hidden" name="action" value="cancel" />
                  <button type="submit" className={quiet}>Cancel task</button></form>
              ) : (
                <form action={taskAction}><input type="hidden" name="id" value={t.id} /><input type="hidden" name="action" value="reopen" />
                  <button type="submit" className={quiet}>Reopen</button></form>
              )}
            </section>
          ) : null}
          {!active ? (
            <p className="rounded-xl border border-line bg-panel p-5 text-xs text-muted">
              {t.status === "done" ? `Done${t.completed_at ? ` on ${when(t.completed_at)}` : ""}.` : "Cancelled."}
            </p>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
