import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Button, Card, ErrorNote, Field } from "@/components/ui";
import { ApiKeyForm } from "@/components/api-key-form";
import { when } from "@/lib/complaints";
import { addTeamMember, changePlan, revokeApiKey } from "./actions";
import { requireSession } from "@/lib/auth";
import { canAccess, ROLE_LABEL, type Role } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Settings" };


export default async function SettingsPage({ searchParams }: PageProps<"/settings">) {
  const sp = await searchParams;
  const session = await requireSession();
  if (!canAccess(session.role, "/settings")) redirect("/dashboard");

  const supabase = await createClient();
  const [{ data: org }, { data: members }, { data: departments }] = await Promise.all([
    supabase.from("organizations").select("name, slug, status, plan_code, created_at, plans(name, limits)").eq("id", session.orgId).maybeSingle(),
    supabase.from("users").select("id, full_name, email, role, is_active").order("created_at"),
    supabase.from("departments").select("id, name, code").order("name"),
  ]);

  const embeddedPlan = (Array.isArray(org?.plans) ? org?.plans[0] : org?.plans) as { name: string; limits: Record<string, unknown> } | null | undefined;

  type Usage = {
    plans: { code: string; name: string; limits: Record<string, unknown> }[];
    subscription: { status: string; provider: string | null; since: string } | null;
    plan?: { name: string; limits: Record<string, unknown> };
    usage: { staff_users: number; residents: number; documents: number; ai_queries: number; api_calls: number };
  };
  type Audit = { at: string; action: string; entity: string; actor: string; summary: string | null };
  const [usageRes, keysRes, auditRes] = await Promise.all([
    supabase.rpc("usage_summary"),
    supabase.from("api_keys").select("id, name, key_prefix, last_used_at, revoked_at, created_at").order("created_at", { ascending: false }),
    supabase.rpc("audit_recent", { p_limit: 40 }),
  ]);
  const usage = usageRes.data as Usage | null;
  const plan = usage?.plan ?? embeddedPlan;
  const keys = keysRes.data ?? [];
  const audit = (auditRes.data as Audit[] | null) ?? [];
  const auditEnabled = plan?.limits?.audit_logs === true;
  const meters: [string, number, unknown][] = usage
    ? [
        ["Staff users", usage.usage.staff_users, plan?.limits?.max_users],
        ["Documents", usage.usage.documents, plan?.limits?.max_documents],
        ["Assistant questions this month", usage.usage.ai_queries, plan?.limits?.ai_queries_per_month],
      ]
    : [];

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      <Card className="p-5">
        <h2 className="text-sm font-medium">Organization</h2>
        <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Name</dt>
            <dd className="mt-1">{org?.name}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Workspace ID</dt>
            <dd className="mt-1 font-mono text-xs">{org?.slug}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Status</dt>
            <dd className="mt-1 capitalize">{org?.status}</dd>
          </div>
        </dl>
      </Card>

      <Card className="p-5" id="plan">
        <h2 className="text-sm font-medium">Plan and usage: {plan?.name ?? org?.plan_code}</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          {meters.map(([label, used, limit]) => {
            const max = typeof limit === "number" ? limit : null;
            const pct = max ? Math.min(100, (100 * used) / max) : 0;
            return (
              <div key={label}>
                <p className="text-xs text-muted">{label}</p>
                <p className="mt-1 text-lg font-semibold tabular-nums">
                  {used}
                  <span className="ml-1 text-xs font-normal text-muted">{max == null ? "· unlimited" : `of ${max}`}</span>
                </p>
                {max != null ? (
                  <span className="mt-1.5 block h-1.5 rounded-full bg-raised">
                    <span className={`block h-1.5 rounded-full ${pct >= 100 ? "bg-status-critical" : "bg-series-1"}`} style={{ width: `${pct}%` }} />
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
        {usage ? (
          <p className="mt-3 text-xs text-faint">
            Also this month: {usage.usage.api_calls} API calls. {usage.usage.residents} resident account{usage.usage.residents === 1 ? "" : "s"} (not counted against the plan).
          </p>
        ) : null}

        <div className="stagger mt-5 grid gap-3 sm:grid-cols-3">
          {(usage?.plans ?? []).map((p) => {
            const current = p.code === org?.plan_code;
            const lim = (k: string) => (p.limits[k] == null ? "Unlimited" : String(p.limits[k]));
            return (
              <div key={p.code} className={`rounded-lg border p-4 text-xs ${current ? "border-accent/50" : "border-line"}`}>
                <p className="text-sm font-medium text-ink">{p.name}</p>
                <ul className="mt-2 space-y-1 text-muted">
                  <li>{lim("max_users")} staff users</li>
                  <li>{lim("max_documents")} documents</li>
                  <li>{lim("ai_queries_per_month")} assistant questions a month</li>
                  <li>{p.limits.audit_logs === true ? "Audit log" : "No audit log"}</li>
                </ul>
                {current ? (
                  <p className="mt-3 font-medium text-accent">Current plan</p>
                ) : (
                  <form action={changePlan} className="mt-3">
                    <input type="hidden" name="plan" value={p.code} />
                    <button type="submit" className="rounded-lg border border-line px-3 py-1.5 text-ink hover:bg-raised">Switch (test mode)</button>
                  </form>
                )}
              </div>
            );
          })}
        </div>
        <p className="mt-3 text-xs text-faint">
          Test mode: no payment provider is connected and no money is taken. Switching changes the limits above so they can be tried.
          {usage?.subscription?.provider === "test_mode" ? ` Current subscription started ${when(usage.subscription.since)} in test mode.` : ""}
        </p>
      </Card>

      <Card className="overflow-hidden">
        <h2 className="px-5 pt-5 text-sm font-medium">Members ({members?.length ?? 0})</h2>
        <table className="mt-3 w-full text-left text-sm">
          <thead className="border-y border-line text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-5 py-2 font-medium">Name</th>
              <th className="px-5 py-2 font-medium">Email</th>
              <th className="px-5 py-2 font-medium">Role</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {(members ?? []).map((m) => (
              <tr key={m.id}>
                <td className="px-5 py-3">{m.full_name}</td>
                <td className="px-5 py-3 text-muted">{m.email}</td>
                <td className="px-5 py-3">{ROLE_LABEL[m.role as Role] ?? m.role}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card className="p-5">
        <h2 className="text-sm font-medium">Add a team member</h2>
        <p className="mt-1 text-xs text-muted">
          Creates a staff account in this organization. Share the temporary password with them yourself. Staff accounts count towards the plan&apos;s user limit; residents who sign up to report problems do not.
        </p>
        <form action={addTeamMember} className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2 space-y-2">
            <ErrorNote message={typeof sp.error === "string" ? sp.error : undefined} />
            {typeof sp.added === "string" ? <p role="status" className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-ink">{sp.added}</p> : null}
          </div>
          <Field label="Name" name="full_name" required />
          <Field label="Email" name="email" type="email" required />
          <Field label="Temporary password" name="password" type="text" minLength={8} required autoComplete="off" />
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-ink">Role</span>
            <select name="role" defaultValue="field_worker" className="w-full rounded-lg border border-line bg-raised px-3 py-2.5 text-sm text-ink focus:border-accent focus:outline-none">
              <option value="dept_officer">Department Officer: reviews, assigns and verifies complaints</option>
              <option value="field_worker">Field Worker: works on complaints assigned to them</option>
            </select>
          </label>
          <div className="sm:col-span-2"><Button type="submit">Add team member</Button></div>
        </form>
      </Card>

      <Card className="p-5">
        <h2 className="text-sm font-medium">Departments ({departments?.length ?? 0})</h2>
        <ul className="mt-4 grid gap-2 sm:grid-cols-2">
          {(departments ?? []).map((d) => (
            <li key={d.id} className="flex items-center justify-between rounded-lg border border-line px-3 py-2 text-sm">
              {d.name}
              <span className="font-mono text-xs text-faint">{d.code}</span>
            </li>
          ))}
        </ul>
      </Card>
      <Card className="p-5" id="api">
        <h2 className="text-sm font-medium">API keys</h2>
        <p className="mt-1 text-xs text-muted">
          Keys give read access to this workspace&apos;s published figures through the data API, limited to 60 requests a minute.
        </p>
        <div className="mt-4"><ApiKeyForm /></div>
        {keys.length ? (
          <table className="mt-4 w-full text-left text-xs">
            <thead className="border-y border-line uppercase tracking-wide text-muted">
              <tr><th className="py-2 font-medium">Name</th><th className="py-2 font-medium">Key</th><th className="py-2 font-medium">Last used</th><th className="py-2" /></tr>
            </thead>
            <tbody className="divide-y divide-line">
              {keys.map((k) => (
                <tr key={k.id}>
                  <td className="py-2.5 text-ink">{k.name}</td>
                  <td className="py-2.5 font-mono text-muted">{k.key_prefix}…</td>
                  <td className="py-2.5 text-muted">{k.last_used_at ? when(k.last_used_at) : "Never"}</td>
                  <td className="py-2.5 text-right">
                    {k.revoked_at ? <span className="text-faint">Revoked</span> : (
                      <form action={revokeApiKey}><input type="hidden" name="id" value={k.id} /><button type="submit" className="text-muted hover:text-danger">Revoke</button></form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <pre className="mt-4 overflow-x-auto rounded-lg border border-line bg-base p-3 font-mono text-[11px] leading-relaxed text-muted">{`curl -H "Authorization: Bearer civ_..." \\
  "https://YOUR-SITE/api/v1/indicators?metric=complaints_registered&year=2025&ward=K/W"`}</pre>
        <p className="mt-2 text-xs text-faint">Leave out <code>metric</code> to list the available metrics.</p>
      </Card>

      <Card className="p-5" id="audit">
        <h2 className="text-sm font-medium">Audit log</h2>
        {auditEnabled ? (
          audit.length ? (
            <ul className="mt-3 max-h-80 space-y-1.5 overflow-auto text-xs">
              {audit.map((a, i) => (
                <li key={i} className="grid grid-cols-[150px_70px_1fr] gap-3 text-muted">
                  <span className="tabular-nums">{when(a.at)}</span>
                  <span className="text-ink">{a.action.toLowerCase()}</span>
                  <span>{a.entity.replace(/_/g, " ")}{a.summary ? `: ${a.summary}` : ""} <span className="text-faint">by {a.actor}</span></span>
                </li>
              ))}
            </ul>
          ) : <p className="mt-2 text-xs text-muted">No changes recorded yet.</p>
        ) : (
          <p className="mt-2 text-xs text-muted">
            Changes to the organization, users, subscriptions and API keys are always recorded. Viewing the log is an Enterprise plan feature; switch plan above (test mode) to see it.
          </p>
        )}
      </Card>
    </div>
  );
}
