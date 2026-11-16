import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { SeverityBadge, StatusBadge } from "@/components/complaints/badges";
import { requireSession } from "@/lib/auth";
import { STATUS_LABEL, STATUSES, when, type ComplaintList, type Status } from "@/lib/complaints";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Complaints" };

export default async function ComplaintsPage({ searchParams }: PageProps<"/complaints">) {
  const session = await requireSession();
  const sp = await searchParams;
  const status = typeof sp.status === "string" && (STATUSES as string[]).includes(sp.status) ? (sp.status as Status) : null;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("complaint_list", { p_status: status });
  const d = (data as ComplaintList | null) ?? { counts: {}, rows: [] };
  const total = Object.values(d.counts).reduce((a, n) => a + (n ?? 0), 0);
  const staff = session.role === "city_admin" || session.role === "dept_officer";
  const heading = session.role === "citizen" ? "My complaints" : session.role === "field_worker" ? "Assigned to me" : "Complaints";

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{heading}</h1>
          <p className="mt-1 text-sm text-muted">
            {staff
              ? "Reports submitted through CivicOS. Suggested category and priority are advisory until you assign the complaint."
              : session.role === "citizen"
                ? "Problems you have reported and where each one stands."
                : "Complaints assigned to you. Start work, then mark them resolved."}
          </p>
        </div>
        <Link href="/complaints/new" className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-ink hover:brightness-110">
          <Plus className="size-4" aria-hidden="true" />
          Report a problem
        </Link>
      </div>

      {error ? <p className="rounded-xl border border-line bg-panel p-6 text-sm text-muted">The complaints query failed: {error.message}</p> : null}

      <nav aria-label="Filter by status" className="flex flex-wrap gap-2 text-sm">
        <Tab href="/complaints" active={!status} label="All" count={total} />
        {STATUSES.filter((s) => s !== "submitted").map((s) => (
          <Tab key={s} href={`/complaints?status=${s}`} active={status === s} label={STATUS_LABEL[s]} count={d.counts[s] ?? 0} />
        ))}
      </nav>

      {d.rows.length === 0 ? (
        <div className="rounded-xl border border-line bg-panel p-10 text-center text-sm text-muted">
          {total === 0
            ? "No complaints yet. This list holds only complaints submitted through CivicOS; the published BMC complaint statistics are on the dashboard."
            : "No complaints with this status."}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-panel">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-line text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">Reference</th>
                <th className="px-4 py-2.5 font-medium">Problem</th>
                <th className="px-4 py-2.5 font-medium">Ward</th>
                <th className="px-4 py-2.5 font-medium">Priority</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Reported</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {d.rows.map((r) => (
                <tr key={r.id} className="hover:bg-raised/40">
                  <td className="px-4 py-3 align-top">
                    <Link href={`/complaints/${r.id}`} className="font-mono text-xs text-accent hover:underline">{r.reference}</Link>
                    {r.is_duplicate ? <span className="mt-1 block text-[11px] text-warn">Possible duplicate</span> : null}
                  </td>
                  <td className="max-w-md px-4 py-3 align-top">
                    <span className="block text-ink">{r.category ?? "Uncategorised"}</span>
                    <span className="block truncate text-xs text-muted">{r.description}</span>
                  </td>
                  <td className="px-4 py-3 align-top text-muted">{r.ward ?? "—"}</td>
                  <td className="px-4 py-3 align-top"><SeverityBadge severity={r.severity} provisional={!r.severity_confirmed} /></td>
                  <td className="px-4 py-3 align-top">
                    <StatusBadge status={r.status} />
                    {r.assignee ? <span className="mt-1 block text-[11px] text-muted">{r.assignee}</span> : null}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 align-top text-xs text-muted">{when(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Tab({ href, active, label, count }: { href: string; active: boolean; label: string; count: number }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`rounded-lg border px-3 py-1.5 ${active ? "border-accent/50 bg-raised text-ink" : "border-line text-muted hover:text-ink"}`}
    >
      {label} <span className="tabular-nums text-faint">{count}</span>
    </Link>
  );
}
