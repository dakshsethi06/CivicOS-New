import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { fmt } from "@/lib/dashboard";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Platform" };

type Overview = {
  totals: Record<string, number>;
  organizations: { name: string; slug: string; plan: string; status: string; created_at: string; staff_users: number; residents: number; complaints: number; documents: number; ai_queries: number; api_calls: number }[];
  plans: { code: string; name: string; limits: Record<string, unknown>; organizations: number }[];
};
const TOTAL_LABEL: Record<string, string> = {
  organizations: "Municipalities", staff_users: "Staff users", residents: "Residents", complaints: "Complaints submitted",
  ai_queries_this_month: "Assistant questions this month", api_calls_this_month: "API calls this month",
};

export default async function PlatformPage() {
  const session = await requireSession();
  if (session.role !== "super_admin") redirect("/dashboard");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("platform_overview");
  const d = data as Overview | null;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Platform</h1>
        <p className="mt-1 text-sm text-muted">Every municipality registered on this CivicOS installation. Counts only: tenant data stays inside each workspace.</p>
      </div>
      {error || !d ? <p className="rounded-xl border border-line bg-panel p-6 text-sm text-muted">{error?.message ?? "No data."}</p> : (
        <>
          <div className="stagger grid grid-cols-2 gap-3 lg:grid-cols-6">
            {Object.entries(TOTAL_LABEL).map(([k, label]) => (
              <div key={k} className="rounded-xl border border-line bg-panel p-4">
                <p className="text-xs text-muted">{label}</p>
                <p className="mt-2 text-2xl font-semibold tabular-nums">{fmt.int(d.totals[k])}</p>
              </div>
            ))}
          </div>
          <div className="overflow-x-auto rounded-xl border border-line bg-panel">
            <table className="w-full min-w-[820px] text-left text-sm tabular-nums">
              <thead className="border-b border-line text-xs uppercase tracking-wide text-muted">
                <tr>
                  {["Municipality", "Plan", "Status", "Staff", "Residents", "Complaints", "Documents", "AI questions", "API calls"].map((h, i) => (
                    <th key={h} className={`px-4 py-2.5 font-medium ${i > 2 ? "text-right" : ""}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {d.organizations.map((o) => (
                  <tr key={o.slug}>
                    <td className="px-4 py-3"><span className="text-ink">{o.name}</span><span className="block font-mono text-xs text-faint">{o.slug}</span></td>
                    <td className="px-4 py-3 capitalize text-muted">{o.plan}</td>
                    <td className="px-4 py-3 capitalize text-muted">{o.status}</td>
                    {[o.staff_users, o.residents, o.complaints, o.documents, o.ai_queries, o.api_calls].map((n, i) => (
                      <td key={i} className="px-4 py-3 text-right text-muted">{fmt.int(n)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {d.plans.map((p) => (
              <div key={p.code} className="rounded-xl border border-line bg-panel p-4 text-sm">
                <p className="font-medium text-ink">{p.name}</p>
                <p className="mt-1 text-xs text-muted">{p.organizations} municipalit{p.organizations === 1 ? "y" : "ies"}</p>
                <ul className="mt-3 space-y-1 text-xs text-muted">
                  <li>Staff users: {p.limits.max_users == null ? "unlimited" : String(p.limits.max_users)}</li>
                  <li>Documents: {p.limits.max_documents == null ? "unlimited" : String(p.limits.max_documents)}</li>
                  <li>Assistant questions a month: {p.limits.ai_queries_per_month == null ? "unlimited" : String(p.limits.ai_queries_per_month)}</li>
                </ul>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
