"use server";

import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

const text = (fd: FormData, key: string) => String(fd.get(key) ?? "").trim();
const orNull = (v: string) => (v === "" ? null : v);

/** Stores the photo (if any) in the user's own folder, then submits. The database computes the suggestions. */
export async function submitComplaint(formData: FormData) {
  const session = await requireSession();
  const supabase = await createClient();
  const back: (msg: string) => never = (msg) => redirect(`/complaints/new?error=${encodeURIComponent(msg)}`);

  const description = text(formData, "description");
  if (description.length < 10) back("Please describe the problem in at least 10 characters.");
  const lon = Number(text(formData, "lon"));
  const lat = Number(text(formData, "lat"));
  const hasPoint = text(formData, "lon") !== "" && Number.isFinite(lon) && Number.isFinite(lat);

  let photoPath: string | null = null;
  let photoNote = "";
  const photo = formData.get("photo");
  if (photo instanceof File && photo.size > 0) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(photo.type) || photo.size > 5 * 1024 * 1024) {
      back("The photo must be a JPEG, PNG or WebP image under 5 MB.");
    }
    const ext = photo.type === "image/png" ? "png" : photo.type === "image/webp" ? "webp" : "jpg";
    const path = `${session.orgId}/${session.userId}/${crypto.randomUUID()}.${ext}`;
    const { error } = await supabase.storage.from("complaint-photos").upload(path, photo, { contentType: photo.type });
    if (error) photoNote = "&photo=failed"; // the report still goes through without the photo
    else photoPath = path;
  }

  const { data, error } = await supabase.rpc("submit_complaint", {
    p_category: orNull(text(formData, "category")),
    p_description: description,
    p_zone: orNull(text(formData, "zone")),
    p_lon: hasPoint ? lon : null,
    p_lat: hasPoint ? lat : null,
    p_photo_path: photoPath,
  });
  if (error || !data) back(error?.message ?? "The complaint could not be submitted.");
  redirect(`/complaints/${(data as { id: string }).id}?created=1${photoNote}`);
}

/** Runs one workflow step. The database checks the role and the complaint's state. */
export async function complaintAction(formData: FormData) {
  await requireSession();
  const supabase = await createClient();
  const id = text(formData, "id");
  const { error } = await supabase.rpc("complaint_action", {
    p_id: id,
    p_action: text(formData, "action"),
    p_note: orNull(text(formData, "note")),
    p_assignee: orNull(text(formData, "assignee")),
    p_severity: orNull(text(formData, "severity")),
    p_category: orNull(text(formData, "category")),
  });
  redirect(`/complaints/${id}${error ? `?error=${encodeURIComponent(error.message)}` : ""}`);
}
