import type { Metadata } from "next";
import Link from "next/link";
import { SeverityBadge, StatusBadge } from "@/components/complaints/badges";
import { requireSession } from "@/lib/auth";
import { when, type Status } from "@/lib/complaints";
import { ROLE_LABEL, type Role } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { KIND_LABEL, TASK_KINDS, TASK_STATUS_LABEL, type WorkList } from "@/lib/tasks";
import { createTask } from "./actions";

export const metadata: Metadata = { title: "Tasks" };

const input = "w-full rounded-lg border border-line bg-raised px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none";

export default async function TasksPage({ searchParams }: PageProps<"/tasks">) {
  const session = await requireSession();
  const sp = await searchParams;
  const officer = session.role === "city_admin" || session.role === "dept_officer";
  const scope = officer && sp.view !== "mine" ? "all" : "mine";
  const supabase = await createClient();
  const [{ data, error }, staff] = await Promise.all([
    supabase.rpc("work_list", { p_scope: scope }),
    officer ? supabase.from("users").select("id, full_name, role").in("role", ["city_admin", "dept_officer", "field_worker"]).eq("is_active", true).order("full_name")
            : Promise.resolve({ data: [] as { id: string; full_name: string; role: string }[] }),
  ]);
  const w = (data as WorkList | null) ?? { tasks: [], complaints: [] };
  const open = w.tasks.filter((t) => t.status === "open" || t.status === "in_progress");

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{officer ? "Tasks" : "My work"}</h1>
        <p className="mt-1 text-sm text-muted">
          {officer ? "Inspections and repairs assigned to staff, including those created from recommendations and water anomalies."
                   : "Tasks and complaints assigned to you. Open one to start it and file your inspection report."}
        </p>
      </div>
      {typeof sp.note === "string" ? <p role="alert" className="rounded-lg border border-line bg-panel px-4 py-2.5 text-sm text-danger">{sp.note}</p> : null}
      {error ? <p className="text-sm text-danger">{error.message}</p> : null}

      {officer ? (
        <nav className="flex gap-1 border-b border-line text-sm">
          {[["all", "All tasks"], ["mine", "Assigned to me"]].map(([v, label]) => (
            <Link key={v} href={`/tasks${v === "all" ? "" : "?view=mine"}`}
                  className={`-mb-px border-b-2 px-3 py-2 ${scope === v ? "border-accent font-medium text-ink" : "border-transparent text-muted hover:text-ink"}`}>{label}</Link>
          ))}
        </nav>
      ) : null}

      <section className="overflow-x-auto rounded-xl border border-line bg-panel">
        <table className="w-full min-w-[680px] text-left text-sm">
          <thead className="border-b border-line text-xs uppercase tracking-wide text-muted">
            <tr>{["Task", "Kind", "Priority", "Ward", "Assigned to", "Status", "Reports"].map((h) => <th key={h} className="px-4 py-2.5 font-medium">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-line">
            {(scope === "all" ? w.tasks : open).length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-muted">No tasks.</td></tr>
            ) : null}
            {(scope === "all" ? w.tasks : open).map((t) => (
              <tr key={t.id} className="hover:bg-raised/50">
                <td className="px-4 py-3">
                  <Link href={`/tasks/${t.id}`} className="text-ink hover:text-accent">{t.title}</Link>
                  <span className="block font-mono text-xs text-faint">{t.reference}{t.due_at ? ` · due ${when(t.due_at)}` : ""}</span>
                </td>
                <td className="px-4 py-3 text-xs text-muted">{KIND_LABEL[t.kind] ?? t.kind}</td>
                <td className="px-4 py-3"><SeverityBadge severity={t.priority} /></td>
                <td className="px-4 py-3 text-muted">{t.ward ?? "—"}</td>
                <td className="px-4 py-3 text-muted">{t.assignee ?? "Unassigned"}</td>
                <td className="px-4 py-3 text-xs">{TASK_STATUS_LABEL[t.status]}</td>
                <td className="px-4 py-3 tabular-nums text-muted">{t.reports}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {w.complaints.length ? (
        <section className="rounded-xl border border-line bg-panel">
          <h2 className="border-b border-line px-5 py-3 text-sm font-medium">Complaints assigned to you</h2>
          <ul className="divide-y divide-line">
            {w.complaints.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                <span>
                  <Link href={`/complaints/${c.id}`} className="font-mono text-accent hover:underline">{c.reference}</Link>
                  <span className="ml-2 text-ink">{c.category ?? "Uncategorised"}</span>
                  <span className="block text-xs text-muted">{c.ward ?? "—"} · {c.description}</span>
                </span>
                <span className="flex items-center gap-2"><SeverityBadge severity={c.severity} /><StatusBadge status={c.status as Status} /></span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {officer ? (
        <section className="rounded-xl border border-line bg-panel p-5">
          <h2 className="text-sm font-medium">New task</h2>
          <form action={createTask} className="mt-4 grid gap-3 sm:grid-cols-2">
            <input type="hidden" name="back" value="/tasks" />
            <label className="block text-xs text-muted sm:col-span-2">Title<input name="title" required className={`mt-1 ${input}`} placeholder="For example: inspect the drain outside the market" /></label>
            <label className="block text-xs text-muted sm:col-span-2">Details<textarea name="description" rows={2} className={`mt-1 ${input}`} /></label>
            <label className="block text-xs text-muted">Kind
              <select name="kind" defaultValue="inspection" className={`mt-1 ${input}`}>
                {TASK_KINDS.filter((k) => k !== "recommendation").map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </select>
            </label>
            <label className="block text-xs text-muted">Priority
              <select name="priority" defaultValue="medium" className={`mt-1 ${input}`}>
                {["low", "medium", "high", "critical"].map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}
              </select>
            </label>
            <label className="block text-xs text-muted">Assign to
              <select name="assignee" defaultValue="" className={`mt-1 ${input}`}>
                <option value="">Unassigned</option>
                {(staff.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.full_name} · {ROLE_LABEL[u.role as Role] ?? u.role}</option>)}
              </select>
            </label>
            <label className="block text-xs text-muted">Due (optional)<input name="due" type="datetime-local" className={`mt-1 ${input}`} /></label>
            <div className="sm:col-span-2"><button type="submit" className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:brightness-110">Create task</button></div>
          </form>
        </section>
      ) : null}
    </div>
  );
}
