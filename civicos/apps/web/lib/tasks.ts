export type TaskStatus = "open" | "in_progress" | "done" | "cancelled";
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = { open: "Open", in_progress: "In progress", done: "Done", cancelled: "Cancelled" };
export const TASK_KINDS = ["inspection", "repair", "collection", "recommendation", "other"] as const;
export const KIND_LABEL: Record<string, string> = {
  inspection: "Inspection", repair: "Repair", collection: "Collection", recommendation: "From a recommendation", other: "Other",
};
export const CONDITIONS = [
  { value: "good", label: "Good: no problem found" },
  { value: "minor", label: "Minor: fix in routine work" },
  { value: "major", label: "Major: needs repair soon" },
  { value: "critical", label: "Critical: hazard, act now" },
] as const;
export const CONDITION_COLOR: Record<string, string> = { good: "#1baf7a", minor: "#fab219", major: "#ec835a", critical: "#d03b3b" };

export type TaskRow = {
  id: string; reference: string; kind: string; title: string; priority: string; status: TaskStatus; ward: string | null;
  assignee: string | null; department: string | null; due_at: string | null; created_at: string; reports: number;
};
export type WorkList = {
  tasks: TaskRow[];
  complaints: { id: string; reference: string; category: string | null; status: string; severity: string; ward: string | null;
                description: string; created_at: string }[];
};
export type Report = {
  id: number; condition: string; findings: string; action_taken: string | null; needs_followup: boolean; photo_path: string | null;
  lat?: number | null; lon?: number | null; author: string | null; created_at: string;
};
export type TaskDetail = {
  task: {
    id: string; reference: string; kind: string; title: string; description: string | null; priority: string; status: TaskStatus;
    ward: string | null; assignee: string | null; assignee_id: string | null; department: string | null; created_by_name: string | null;
    lat: number | null; lon: number | null; due_at: string | null; started_at: string | null; completed_at: string | null; created_at: string;
    recommendation: { id: string; problem: string; action: string; basis: string } | null;
    anomaly: { id: number; pattern: string; level: string; status: string; sensor: string; evidence: Record<string, number | null> } | null;
    complaint: { id: string; reference: string; description: string } | null;
  } | null;
  reports: Report[];
  staff: { id: string; name: string; role: string }[];
};
