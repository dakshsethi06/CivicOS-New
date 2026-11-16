export type Status = "submitted" | "classified" | "assigned" | "in_progress" | "resolved" | "verified";
export const STATUSES: Status[] = ["submitted", "classified", "assigned", "in_progress", "resolved", "verified"];
export const STATUS_LABEL: Record<Status, string> = {
  submitted: "Submitted",
  classified: "Classified",
  assigned: "Assigned",
  in_progress: "In progress",
  resolved: "Resolved",
  verified: "Verified",
};
export const SEVERITIES = ["low", "medium", "high", "critical"] as const;

export type ListRow = {
  id: string; reference: string; category: string | null; ward: string | null; status: Status; severity: string;
  severity_confirmed: boolean; created_at: string; description: string; expected_days: number | null; assignee: string | null; is_duplicate: boolean;
};
export type ComplaintList = { counts: Partial<Record<Status, number>>; rows: ListRow[] };

export type Detail = {
  complaint: {
    id: string; reference: string; description: string; status: Status; severity: string; severity_confirmed: boolean;
    suggested_severity: string | null; suggestion_reason: string | null; category: string | null; category_id: string | null;
    suggested_category: string | null; suggested_category_id: string | null; ward: string | null; department: string | null;
    citizen: string | null; assignee: string | null; assignee_id: string | null; lon: number | null; lat: number | null;
    expected_days: number | null; expected_days_basis: string | null; photo_path: string | null;
    created_at: string; assigned_at: string | null; resolved_at: string | null; verified_at: string | null;
    duplicate: { id: string; reference: string; status: Status } | null;
  } | null;
  history: { from: Status | null; to: Status; note: string | null; at: string; actor: string }[];
  staff: { id: string; name: string; role: string }[];
  categories: { id: string; name: string }[];
};

export const when = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
