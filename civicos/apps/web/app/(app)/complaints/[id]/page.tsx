import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SeverityBadge, StatusBadge } from "@/components/complaints/badges";
import { InspectionForm } from "@/components/tasks/inspection-form";
import { Reports, signedPhotos } from "@/components/tasks/reports";
import { ErrorNote } from "@/components/ui";
import type { Report } from "@/lib/tasks";
import { requireSession } from "@/lib/auth";
import { CATEGORY_LABEL, SEVERITIES, STATUS_LABEL, STATUSES, when, type Detail } from "@/lib/complaints";
import { ROLE_LABEL, type Role } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { analyseComplaint, complaintAction } from "../actions";

export const metadata: Metadata = { title: "Complaint" };

const inputCls = "w-full rounded-lg border border-line bg-raised px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none";
const btn = "inline-flex items-center justify-center rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:brightness-110";
const btnQuiet = "inline-flex items-center justify-center rounded-lg border border-line px-4 py-2 text-sm text-ink hover:bg-raised";

export default async function ComplaintPage({ params, searchParams }: PageProps<"/complaints/[id]">) {
  const session = await requireSession();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const supabase = await createClient();
  const [{ data }, reportsRes] = await Promise.all([
    supabase.rpc("complaint_detail", { p_id: id }),
    supabase.rpc("complaint_reports", { p_complaint: id }),
  ]);
  const reports = (reportsRes.data as Report[] | null) ?? [];
  const d = data as Detail | null;
  const c = d?.complaint;
  if (!d || !c) notFound();

  let photoUrl: string | null = null;
  if (c.photo_path) {
    const signed = await supabase.storage.from("complaint-photos").createSignedUrl(c.photo_path, 600);
    photoUrl = signed.data?.signedUrl ?? null;
  }

  const staff = session.role === "city_admin" || session.role === "dept_officer";
  const mine = session.role === "field_worker" && c.assignee_id === session.userId;
  const step = STATUSES.indexOf(c.status);
  const mismatch = c.suggested_category && c.suggested_category_id !== c.category_id;
  const reportPhotos = await signedPhotos(supabase, reports);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <Link href="/complaints" className="text-xs text-muted hover:text-ink">← Complaints</Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-xl font-semibold tracking-tight">{c.reference}</h1>
          <StatusBadge status={c.status} />
          <SeverityBadge severity={c.severity} provisional={!c.severity_confirmed} />
        </div>
        <p className="mt-1 text-sm text-muted">
          {c.category ?? "Uncategorised"} · {c.ward ?? "Ward not given"} · reported {when(c.created_at)}
          {c.citizen ? ` by ${c.citizen}` : ""}
        </p>
      </div>

      {sp.created ? (
        <p role="status" className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-ink">
          Complaint submitted. Keep the reference {c.reference} to follow it.
          {sp.photo === "failed" ? " The photo could not be stored, so the report went in without it." : ""}
          {sp.ai === "failed" ? " The automatic analysis did not run; staff will review it as usual." : ""}
        </p>
      ) : null}
      <ErrorNote message={typeof sp.error === "string" ? sp.error : undefined} />

      {/* progress */}
      <ol className="grid grid-cols-6 gap-1 text-center text-[11px]">
        {STATUSES.map((s, i) => (
          <li key={s}>
            <span className={`block h-1.5 rounded-full ${i <= step ? "bg-accent" : "bg-raised"}`} />
            <span className={`mt-1.5 block ${i === step ? "font-medium text-ink" : i < step ? "text-muted" : "text-faint"}`}>{STATUS_LABEL[s]}</span>
          </li>
        ))}
      </ol>

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="space-y-6">
          <section className="rounded-xl border border-line bg-panel p-5">
            <h2 className="text-sm font-medium">Description</h2>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink">{c.description}</p>
            {photoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL from private storage
              <img src={photoUrl} alt="Photo attached to the complaint" className="mt-4 max-h-96 rounded-lg border border-line" />
            ) : c.photo_path ? (
              <p className="mt-3 text-xs text-muted">A photo is attached but could not be loaded.</p>
            ) : null}
            <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-3">
              <div><dt className="text-muted">Department</dt><dd className="mt-0.5 text-ink">{c.department ?? "—"}</dd></div>
              <div><dt className="text-muted">Assigned to</dt><dd className="mt-0.5 text-ink">{c.assignee ?? "Not assigned"}</dd></div>
              <div><dt className="text-muted">Location</dt><dd className="mt-0.5 tabular-nums text-ink">{c.lat != null && c.lon != null ? `${c.lat}, ${c.lon}` : "No pin"}</dd></div>
            </dl>
          </section>

          <section className="rounded-xl border border-line bg-panel p-5">
            <h2 className="text-sm font-medium">System suggestions</h2>
            <p className="mt-1 text-xs text-muted">Produced by fixed rules when the complaint was submitted. They are advice for the officer, who decides.</p>
            <dl className="mt-4 space-y-3 text-sm">
              <div>
                <dt className="text-xs text-muted">Priority</dt>
                <dd className="mt-1 flex flex-wrap items-center gap-2">
                  {c.suggested_severity ? <SeverityBadge severity={c.suggested_severity} /> : "—"}
                  {c.severity_confirmed && c.severity !== c.suggested_severity ? <span className="text-xs text-muted">Officer set it to {c.severity}.</span> : null}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Category</dt>
                <dd className="mt-1 text-ink">
                  {c.suggested_category ?? "No suggestion: the wording matched no category keywords"}
                  {mismatch ? <span className="ml-2 text-xs text-warn">Differs from the chosen category ({c.category}).</span> : null}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Why</dt>
                <dd className="mt-1 text-xs leading-relaxed text-muted">{c.suggestion_reason ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Possible duplicate</dt>
                <dd className="mt-1">
                  {c.duplicate ? (
                    <Link href={`/complaints/${c.duplicate.id}`} className="font-mono text-xs text-accent hover:underline">
                      {c.duplicate.reference} <span className="font-sans text-muted">({STATUS_LABEL[c.duplicate.status]})</span>
                    </Link>
                  ) : (
                    <span className="text-xs text-muted">None found within 150 m with similar wording.</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Typical time to close</dt>
                <dd className="mt-1 text-ink">
                  {c.expected_days != null ? `${c.expected_days} days` : "No published figure"}
                  {c.expected_days_basis ? <span className="mt-0.5 block text-xs text-muted">{c.expected_days_basis}. A published average, not a promise.</span> : null}
                </dd>
              </div>
            </dl>
          </section>

          {staff ? <AiPanel c={c} categories={d.categories} /> : null}

          {staff || mine || reports.length ? (
            <section className="rounded-xl border border-line bg-panel p-5">
              <h2 className="text-sm font-medium">Inspection reports ({reports.length})</h2>
              <Reports reports={reports} photos={reportPhotos} />
            </section>
          ) : null}

          <section className="rounded-xl border border-line bg-panel p-5">
            <h2 className="text-sm font-medium">History</h2>
            <ol className="mt-4 space-y-4">
              {d.history.map((h, i) => (
                <li key={i} className="grid grid-cols-[14px_1fr] gap-3 text-sm">
                  <span className="mt-1.5 size-2 rounded-full bg-accent" />
                  <div>
                    <p className="text-ink">
                      {STATUS_LABEL[h.to]}
                      <span className="ml-2 text-xs text-muted">{h.actor} · {when(h.at)}</span>
                    </p>
                    {h.note ? <p className="mt-0.5 text-xs leading-relaxed text-muted">{h.note}</p> : null}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </div>

        {/* actions */}
        <aside className="space-y-4">
          {staff && ["submitted", "classified", "assigned"].includes(c.status) ? (
            <form action={complaintAction} className="space-y-3 rounded-xl border border-line bg-panel p-5">
              <h2 className="text-sm font-medium">{c.status === "assigned" ? "Reassign" : "Review and assign"}</h2>
              <input type="hidden" name="id" value={c.id} />
              <input type="hidden" name="action" value="assign" />
              <label className="block text-xs text-muted">
                Category
                <select name="category" defaultValue={c.category_id ?? ""} className={`mt-1 ${inputCls}`}>
                  {d.categories.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
                </select>
              </label>
              <label className="block text-xs text-muted">
                Priority
                <select name="severity" defaultValue={c.severity} className={`mt-1 ${inputCls}`}>
                  {SEVERITIES.map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
                </select>
              </label>
              <label className="block text-xs text-muted">
                Assign to
                <select name="assignee" required defaultValue={c.assignee_id ?? ""} className={`mt-1 ${inputCls}`}>
                  <option value="" disabled>Choose a staff member</option>
                  {d.staff.map((u) => <option key={u.id} value={u.id}>{u.name} · {ROLE_LABEL[u.role as Role] ?? u.role}</option>)}
                </select>
              </label>
              <label className="block text-xs text-muted">
                Note (optional)
                <textarea name="note" rows={2} className={`mt-1 ${inputCls}`} />
              </label>
              <button type="submit" className={`w-full ${btn}`}>Confirm and assign</button>
            </form>
          ) : null}

          {(staff || mine) && (c.status === "assigned" || c.status === "in_progress") ? (
            <section className="space-y-3 rounded-xl border border-line bg-panel p-5">
              <h2 className="text-sm font-medium">Inspection report</h2>
              <InspectionForm complaint={c.id} />
            </section>
          ) : null}
          {(staff || mine) && c.status === "assigned" ? (
            <StepForm id={c.id} action="start" title="Start work" button="Mark in progress" />
          ) : null}
          {(staff || mine) && c.status === "in_progress" ? (
            <StepForm id={c.id} action="resolve" title="Resolve" button="Mark resolved" notePlaceholder="What was done" />
          ) : null}
          {staff && c.status === "resolved" ? (
            <>
              <StepForm id={c.id} action="verify" title="Verify the resolution" button="Verify and close" />
              <StepForm id={c.id} action="reopen" title="Not fixed?" button="Reopen" quiet noteRequired notePlaceholder="Why it is being reopened" />
            </>
          ) : null}

          {!staff && !mine ? (
            <div className="rounded-xl border border-line bg-panel p-5 text-xs leading-relaxed text-muted">
              {c.status === "verified"
                ? "This complaint has been resolved and verified."
                : "Municipal staff review each report, confirm its category and priority, and assign it. This page updates as it moves."}
            </div>
          ) : null}
          {c.status === "verified" && (staff || mine) ? (
            <div className="rounded-xl border border-line bg-panel p-5 text-xs text-muted">Closed{c.verified_at ? ` on ${when(c.verified_at)}` : ""}. No further action.</div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

type C = NonNullable<Detail["complaint"]>;

/** What the AI analysis suggested, with its numbers, for the officer to weigh. */
function AiPanel({ c, categories }: { c: C; categories: Detail["categories"] }) {
  const aiCat = categories.find((k) => k.id === c.ai_category_id)?.name ?? null;
  const top = Object.entries(c.ai_scores ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const img = c.image_analysis;
  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">AI analysis</h2>
        <form action={analyseComplaint}>
          <input type="hidden" name="id" value={c.id} />
          <button type="submit" className="rounded border border-line px-2 py-0.5 text-xs text-muted hover:text-ink">
            {c.ai_analysed_at ? "Run again" : "Run analysis"}
          </button>
        </form>
      </div>
      {!c.ai_analysed_at ? (
        <p className="mt-2 text-xs text-muted">Not analysed yet. The analysis compares the text with each category by meaning, looks for the same problem reported nearby, and checks the photo.</p>
      ) : (
        <dl className="mt-3 space-y-3 text-sm">
          <div>
            <dt className="text-xs text-muted">Category by meaning</dt>
            <dd className="mt-1 text-ink">
              {aiCat ?? "No clear match"}
              {c.ai_similarity != null ? <span className="ml-2 text-xs text-muted">similarity {c.ai_similarity.toFixed(2)}</span> : null}
              {top.length ? (
                <span className="mt-0.5 block text-xs text-muted">
                  Closest: {top.map(([k, v]) => `${CATEGORY_LABEL[k] ?? k} ${v.toFixed(2)}`).join(" · ")}. A category is suggested only when it is
                  clearly ahead; similarity is a measure of closeness in meaning, not a probability.
                </span>
              ) : null}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Same problem reported nearby (within 150 m)</dt>
            <dd className="mt-1">
              {c.ai_duplicates?.length ? (
                <ul className="space-y-1">
                  {c.ai_duplicates.map((x) => (
                    <li key={x.id} className="text-xs">
                      <Link href={`/complaints/${x.id}`} className="font-mono text-accent hover:underline">{x.reference}</Link>
                      <span className="ml-2 text-muted">{x.category ?? "—"} · {x.distance_m} m · similarity {x.similarity.toFixed(2)}
                        {x.same_category ? "" : " · different category"} · {STATUS_LABEL[x.status] ?? x.status}</span>
                    </li>
                  ))}
                </ul>
              ) : <span className="text-xs text-muted">None found.</span>}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Photo check</dt>
            <dd className="mt-1 text-xs">
              {!img ? <span className="text-muted">{c.photo_path ? "Not checked." : "No photo."}</span>
                : img.error ? <span className="text-warn">The photo could not be checked: {img.error}</span>
                : (
                  <>
                    <span className="text-ink">{img.summary}</span>
                    <span className="mt-0.5 block text-muted">
                      Road damage: {img.road_damage ? `yes (${(img.damage_type ?? "").replace("_", " ")}, ${img.severity})` : "none seen"}
                      {img.other_issue && img.other_issue !== "none" ? ` · also visible: ${img.other_issue.replace("_", " ")}` : ""}
                      {img.matches_description === false ? " · may not show the problem described" : ""}
                    </span>
                    <span className="mt-0.5 block text-faint">{img.model}: {img.note}</span>
                  </>
                )}
            </dd>
          </div>
          <p className="text-xs text-faint">Analysed {when(c.ai_analysed_at)} · {c.ai_model}. Suggestions only: confirm or change them when assigning.</p>
        </dl>
      )}
    </section>
  );
}

function StepForm({
  id, action, title, button, quiet = false, noteRequired = false, notePlaceholder = "Note (optional)",
}: { id: string; action: string; title: string; button: string; quiet?: boolean; noteRequired?: boolean; notePlaceholder?: string }) {
  return (
    <form action={complaintAction} className="space-y-3 rounded-xl border border-line bg-panel p-5">
      <h2 className="text-sm font-medium">{title}</h2>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="action" value={action} />
      <textarea name="note" rows={2} required={noteRequired} placeholder={notePlaceholder} aria-label={notePlaceholder} className={inputCls} />
      <button type="submit" className={`w-full ${quiet ? btnQuiet : btn}`}>{button}</button>
    </form>
  );
}
