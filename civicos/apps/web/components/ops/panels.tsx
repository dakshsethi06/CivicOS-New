import Link from "next/link";
import type { ReactNode } from "react";
import { buildDemo, retrain } from "@/app/(app)/ops-actions";
import { JobWatcher } from "@/components/ops/job-watcher";
import { at, type OpsStatus } from "@/lib/ops";
import type { Role } from "@/lib/permissions";

/** Tabs between a module's published figures and its sensor-level operations view. */
export function SubNav({ items, active }: { items: { href: string; label: string }[]; active: string }) {
  return (
    <nav aria-label="Views" className="flex gap-1 border-b border-line text-sm">
      {items.map((i) => (
        <Link key={i.href} href={i.href} aria-current={i.href === active ? "page" : undefined}
              className={`-mb-px border-b-2 px-3 py-2 ${i.href === active ? "border-accent font-medium text-ink" : "border-transparent text-muted hover:text-ink"}`}>
          {i.label}
        </Link>
      ))}
    </nav>
  );
}

const btn = "rounded-lg border border-line bg-raised px-3 py-1.5 text-sm text-ink hover:bg-panel disabled:cursor-not-allowed disabled:opacity-50";

/** Says plainly what the data is, shows any running job, and gives administrators the build and retrain buttons. */
export function OpsBanner({
  status, role, back, apiReady, note, hasData,
}: { status: OpsStatus | null; role: Role; back: string; apiReady: boolean; note?: string; hasData: boolean }) {
  const job = status?.job;
  const running = job?.status === "queued" || job?.status === "running";
  const admin = role === "city_admin";
  const demo = status?.dataset?.kind === "demo";

  return (
    <div className="space-y-3">
      <JobWatcher running={running} />
      {hasData && demo ? (
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-sm">
          <p className="max-w-3xl text-ink">
            <span className="mr-2 rounded bg-warn/20 px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-warn">Demo data</span>
            Mumbai publishes no pipe, meter, bin or traffic-detector readings. These readings are generated on a synthetic network placed
            inside the real ward boundaries, to show how the models work. They are not measurements. Built {at(status?.dataset?.generated_at)}.
          </p>
        </div>
      ) : null}
      {!hasData ? (
        <div className="rounded-xl border border-line bg-panel p-5 text-sm text-muted">
          <p className="text-ink">No sensor-level data in this workspace.</p>
          <p className="mt-1">
            The city does not publish these readings. A City Administrator can build a clearly labelled demonstration dataset to see the
            models working, or connect the city&apos;s own feeds later.
          </p>
        </div>
      ) : null}
      {running ? (
        <p role="status" className="rounded-lg border border-line bg-panel px-4 py-2.5 text-sm text-muted">
          <span className="mr-2 inline-block size-2 animate-pulse rounded-full bg-accent" />
          {job?.step ?? "Queued"}… started {at(job?.created_at)}. This page updates by itself.
        </p>
      ) : job?.status === "failed" ? (
        <p role="alert" className="rounded-lg border border-danger/40 bg-panel px-4 py-2.5 text-sm text-danger">
          The last job failed: {job.error ?? "unknown error"}.
        </p>
      ) : null}
      {note ? <p role="status" className="rounded-lg border border-line bg-panel px-4 py-2.5 text-sm text-muted">{note}</p> : null}
      {admin ? (
        <div className="flex flex-wrap items-center gap-2">
          <form action={buildDemo}>
            <input type="hidden" name="back" value={back} />
            <button type="submit" className={btn} disabled={running || !apiReady}>{hasData ? "Rebuild demo dataset" : "Build demo dataset"}</button>
          </form>
          {hasData ? (
            <form action={retrain}>
              <input type="hidden" name="back" value={back} />
              <button type="submit" className={btn} disabled={running || !apiReady || !status?.predictions_enabled}>Retrain models</button>
            </form>
          ) : null}
          {!apiReady ? <span className="text-xs text-faint">Needs the CivicOS API (set CIVICOS_API_URL).</span> : null}
          {apiReady && hasData && !status?.predictions_enabled ? (
            <span className="text-xs text-faint">Retraining and simulation are in the Professional plan (Settings, test mode).</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** How a model was tested: one row per method, the model first, then its baselines. */
export function ModelCard({
  title, method, trainedAt, demo, columns, rows, note, children,
}: { title: string; method?: string; trainedAt?: string; demo?: boolean; columns?: string[]; rows?: (string | number | null)[][];
     note?: string; children?: ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-ink">{title}</h3>
        {trainedAt ? <span className="text-xs text-faint">Trained {at(trainedAt)}{demo ? " on demo data" : ""}</span> : null}
      </div>
      {method ? <p className="mt-0.5 text-xs text-muted">{method}</p> : null}
      {columns && rows?.length ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-xs tabular-nums">
            <thead className="text-muted">
              <tr>{columns.map((c) => <th key={c} className="py-1 pr-4 font-medium">{c}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r, i) => (
                <tr key={i} className={i === 0 ? "font-medium text-ink" : "text-muted"}>
                  {r.map((c, j) => <td key={j} className="py-1.5 pr-4">{c ?? "—"}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {children}
      {note ? <p className="mt-3 text-xs text-faint">{note}</p> : null}
    </section>
  );
}
