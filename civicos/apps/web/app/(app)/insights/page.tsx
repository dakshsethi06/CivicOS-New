import type { Metadata } from "next";
import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { SeverityBadge } from "@/components/complaints/badges";
import { ErrorNote } from "@/components/ui";
import { requireSession } from "@/lib/auth";
import { when } from "@/lib/complaints";
import { createClient } from "@/lib/supabase/server";
import { decide, refreshRecommendations } from "./actions";

export const metadata: Metadata = { title: "Insights" };

type Rec = {
  id: string; rule: string; module: string; ward: string | null; problem: string;
  evidence: { label: string; value: string | number; source: string }[];
  prediction: string | null; action: string; priority: string; basis: string; status: string; assignee: string | null; generated_at: string;
  decisions: { decision: string; note: string | null; at: string; actor: string }[];
};
const STATUS = ["open", "accepted", "assigned", "completed", "rejected"];
const LABEL: Record<string, string> = { open: "Open", accepted: "Accepted", assigned: "Assigned", completed: "Completed", rejected: "Rejected" };
const MODULE: Record<string, string> = { complaints: "Complaints", water: "Water", waste: "Waste", environment: "Air quality", traffic: "Traffic" };
const btn = "rounded-lg border border-line px-3 py-1.5 text-xs text-ink hover:bg-raised";
const inputCls = "h-8 rounded-lg border border-line bg-raised px-2 text-xs text-ink focus:border-accent focus:outline-none";

export default async function InsightsPage({ searchParams }: PageProps<"/insights">) {
  await requireSession();
  const sp = await searchParams;
  const filter = typeof sp.status === "string" && STATUS.includes(sp.status) ? sp.status : "open";
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("recommendation_list");
  const d = (data as { rows: Rec[]; staff: { id: string; name: string }[] } | null) ?? { rows: [], staff: [] };
  const counts = Object.fromEntries(STATUS.map((s) => [s, d.rows.filter((r) => r.status === s).length]));
  const rows = d.rows.filter((r) => r.status === filter);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Insights and recommendations</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Each recommendation comes from a stated rule applied to published figures, model forecasts or live complaints. It is a prompt for an officer&apos;s judgement, not a decision.
          </p>
        </div>
        <form action={refreshRecommendations}>
          <button type="submit" className="inline-flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm text-ink hover:bg-raised">
            <RefreshCw className="size-4" aria-hidden="true" /> Re-run the rules
          </button>
        </form>
      </div>
      <ErrorNote message={typeof sp.error === "string" ? sp.error : error?.message} />
      {sp.refreshed ? <p role="status" className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm">Rules re-run against the current data.</p> : null}

      <nav aria-label="Filter by status" className="flex flex-wrap gap-2 text-sm">
        {STATUS.map((s) => (
          <Link key={s} href={`/insights?status=${s}`} aria-current={s === filter ? "page" : undefined}
            className={`rounded-lg border px-3 py-1.5 ${s === filter ? "border-accent/50 bg-raised text-ink" : "border-line text-muted hover:text-ink"}`}>
            {LABEL[s]} <span className="tabular-nums text-faint">{counts[s]}</span>
          </Link>
        ))}
      </nav>

      {rows.length === 0 ? (
        <p className="rounded-xl border border-line bg-panel p-10 text-center text-sm text-muted">No {LABEL[filter].toLowerCase()} recommendations.</p>
      ) : null}

      <ul className="stagger space-y-4">
        {rows.map((r) => (
          <li key={r.id} id={`rec-${r.id}`} className="rounded-xl border border-line bg-panel p-5">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <SeverityBadge severity={r.priority} />
              <span>{MODULE[r.module] ?? r.module}</span>
              {r.ward ? <span>· Ward {r.ward}</span> : null}
              <span>· generated {when(r.generated_at)}</span>
              {r.assignee ? <span>· assigned to {r.assignee}</span> : null}
            </div>
            <p className="mt-3 text-sm font-medium text-ink">{r.problem}</p>

            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <div>
                <p className="text-xs font-medium text-muted">Evidence</p>
                <ul className="mt-1.5 space-y-1.5 text-xs">
                  {r.evidence.map((e, i) => (
                    <li key={i}>
                      <span className="text-ink">{e.label}: <span className="font-medium tabular-nums">{typeof e.value === "number" ? e.value.toLocaleString("en-IN") : e.value}</span></span>
                      <span className="block text-faint">{e.source}</span>
                    </li>
                  ))}
                </ul>
                {r.prediction ? <p className="mt-2 text-xs text-ink"><span className="text-muted">Prediction: </span>{r.prediction}</p> : null}
              </div>
              <div>
                <p className="text-xs font-medium text-muted">Suggested action</p>
                <p className="mt-1.5 text-sm text-ink">{r.action}</p>
                <p className="mt-3 text-xs text-muted">{r.basis} No confidence figure is shown: this is a fixed rule, not a statistical estimate.</p>
              </div>
            </div>

            {r.decisions.length ? (
              <ul className="mt-4 space-y-1 border-t border-line pt-3 text-xs text-muted">
                {r.decisions.map((x, i) => (
                  <li key={i}>
                    <span className="capitalize text-ink">{x.decision}</span> by {x.actor} · {when(x.at)}{x.note ? ` · “${x.note}”` : ""}
                  </li>
                ))}
              </ul>
            ) : null}

            <form action={decide} className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
              <input type="hidden" name="id" value={r.id} />
              <input type="hidden" name="filter" value={filter} />
              <input name="note" placeholder="Note (optional)" aria-label="Note" className={`${inputCls} min-w-0 flex-1`} />
              {r.status === "open" ? (
                <>
                  <button name="decision" value="accept" className={btn}>Accept</button>
                  <button name="decision" value="reject" className={btn}>Reject</button>
                </>
              ) : null}
              {r.status === "open" || r.status === "accepted" ? (
                <>
                  <select name="assignee" aria-label="Assign to" defaultValue="" className={inputCls}>
                    <option value="">Assign to…</option>
                    {d.staff.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                  <button name="decision" value="assign" className={btn}>Assign</button>
                </>
              ) : null}
              {r.status === "accepted" || r.status === "assigned" ? <button name="decision" value="complete" className={btn}>Mark completed</button> : null}
              {r.status === "rejected" || r.status === "completed" ? <button name="decision" value="reopen" className={btn}>Reopen</button> : null}
            </form>
          </li>
        ))}
      </ul>
    </div>
  );
}
