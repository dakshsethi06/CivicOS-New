"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

const text = (fd: FormData, key: string) => String(fd.get(key) ?? "").trim();
const orNull = (v: string) => (v === "" ? null : v);
const BACK = ["/tasks", "/water/network", "/insights"];

/** Officers create a task, optionally about a complaint, a water anomaly or a recommendation. */
export async function createTask(formData: FormData) {
  await requireSession();
  const supabase = await createClient();
  const back = BACK.includes(text(formData, "back")) ? text(formData, "back") : "/tasks";
  const due = text(formData, "due");
  const { data, error } = await supabase.rpc("task_create", {
    p_title: text(formData, "title"),
    p_description: orNull(text(formData, "description")),
    p_kind: text(formData, "kind") || "inspection",
    p_priority: text(formData, "priority") || "medium",
    p_assignee: orNull(text(formData, "assignee")),
    p_due: due ? new Date(due).toISOString() : null,
    p_recommendation: orNull(text(formData, "recommendation")),
    p_anomaly: text(formData, "anomaly") ? Number(text(formData, "anomaly")) : null,
    p_complaint: orNull(text(formData, "complaint")),
  });
  if (error || !data) redirect(`${back}?note=${encodeURIComponent(error?.message ?? "The task could not be created.")}`);
  redirect(`/tasks/${(data as { id: string }).id}?created=1`);
}

export async function taskAction(formData: FormData) {
  await requireSession();
  const supabase = await createClient();
  const id = text(formData, "id");
  const { error } = await supabase.rpc("task_action", {
    p_id: id, p_action: text(formData, "action"), p_assignee: orNull(text(formData, "assignee")),
  });
  redirect(`/tasks/${id}${error ? `?error=${encodeURIComponent(error.message)}` : ""}`);
}

/** A field report on a task or a complaint, with an optional photo (stored in the reporter's own folder). */
export async function submitInspection(formData: FormData) {
  const session = await requireSession();
  const supabase = await createClient();
  const task = orNull(text(formData, "task"));
  const complaint = orNull(text(formData, "complaint"));
  const back = task ? `/tasks/${task}` : `/complaints/${complaint}`;
  const fail = (msg: string): never => redirect(`${back}?error=${encodeURIComponent(msg)}`);

  let photoPath: string | null = null;
  const photo = formData.get("photo");
  if (photo instanceof File && photo.size > 0) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(photo.type) || photo.size > 5 * 1024 * 1024) {
      fail("The photo must be a JPEG, PNG or WebP image under 5 MB.");
    }
    const ext = photo.type === "image/png" ? "png" : photo.type === "image/webp" ? "webp" : "jpg";
    const path = `${session.orgId}/${session.userId}/inspection-${crypto.randomUUID()}.${ext}`;
    const { error } = await supabase.storage.from("complaint-photos").upload(path, photo, { contentType: photo.type });
    if (error) fail(`The photo could not be stored: ${error.message}`);
    photoPath = path;
  }
  const lat = Number(text(formData, "lat"));
  const lon = Number(text(formData, "lon"));
  const hasPoint = text(formData, "lat") !== "" && Number.isFinite(lat) && Number.isFinite(lon);
  const { error } = await supabase.rpc("submit_inspection", {
    p_task: task, p_complaint: complaint, p_condition: text(formData, "condition"), p_findings: text(formData, "findings"),
    p_action: orNull(text(formData, "action_taken")), p_followup: formData.get("followup") === "on", p_photo: photoPath,
    p_lat: hasPoint ? lat : null, p_lon: hasPoint ? lon : null, p_complete: formData.get("complete") === "on",
  });
  if (error) fail(error.message);
  revalidatePath(back);
  redirect(`${back}?reported=1`);
}
