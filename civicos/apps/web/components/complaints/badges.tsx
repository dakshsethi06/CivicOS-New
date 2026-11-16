import { STATUS_LABEL, type Status } from "@/lib/complaints";

const SEV: Record<string, string> = {
  low: "border-line text-muted",
  medium: "border-status-warning/50 text-status-warning",
  high: "border-status-serious/60 text-status-serious",
  critical: "border-status-critical/70 text-status-critical",
};

/** Priority as a labelled chip: the word carries the meaning, the colour only reinforces it. */
export function SeverityBadge({ severity, provisional = false }: { severity: string; provisional?: boolean }) {
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium capitalize ${SEV[severity] ?? SEV.low}`}>
      {severity}
      {provisional ? <span className="ml-1 font-normal normal-case opacity-80">suggested</span> : null}
    </span>
  );
}

export function StatusBadge({ status }: { status: Status }) {
  const done = status === "resolved" || status === "verified";
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium ${done ? "border-accent/40 text-accent" : "border-line text-ink"}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}
