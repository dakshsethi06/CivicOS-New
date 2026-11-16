"use server";

import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const ROLES = ["dept_officer", "field_worker"];

/** A City Administrator adds a staff account to their own organization. The plan's seat limit is enforced by the database. */
export async function addTeamMember(formData: FormData) {
  const session = await requireSession();
  const back: (key: "error" | "added", msg: string) => never = (key, msg) => redirect(`/settings?${key}=${encodeURIComponent(msg)}`);
  if (session.role !== "city_admin") back("error", "Only a City Administrator can add team members.");

  const fullName = String(formData.get("full_name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const role = String(formData.get("role") ?? "");
  if (!fullName || !email) back("error", "Name and email are required.");
  if (password.length < 8) back("error", "The temporary password must be at least 8 characters.");
  if (!ROLES.includes(role)) back("error", "Choose a role.");

  const admin = createAdminClient();
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { full_name: fullName },
  });
  if (createError || !created.user) back("error", createError?.message ?? "Could not create the account.");

  const { error: rowError } = await admin
    .from("users")
    .insert({ id: created.user.id, organization_id: session.orgId, role, full_name: fullName, email });
  if (rowError) {
    await admin.auth.admin.deleteUser(created.user.id);
    back("error", rowError.message);
  }
  back("added", `${fullName} can now sign in with the password you set.`);
}

/** Test-mode plan switch: no payment provider is connected, and the database records the change as test mode. */
export async function changePlan(formData: FormData) {
  await requireSession();
  const supabase = await createClient();
  const { error } = await supabase.rpc("change_plan", { p_plan: String(formData.get("plan") ?? "") });
  redirect(`/settings?${error ? `error=${encodeURIComponent(error.message)}` : "added=" + encodeURIComponent("Plan changed (test mode: no payment was taken).")}#plan`);
}

export type KeyState = { key?: string; error?: string };

/** Creates an API key and returns it once. Only its hash is stored, so it cannot be shown again. */
export async function createApiKey(_prev: KeyState, formData: FormData): Promise<KeyState> {
  await requireSession();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_api_key", { p_name: String(formData.get("name") ?? "") });
  if (error || !data) return { error: error?.message ?? "Could not create the key." };
  return { key: (data as { key: string }).key };
}

export async function revokeApiKey(formData: FormData) {
  await requireSession();
  const supabase = await createClient();
  await supabase.rpc("revoke_api_key", { p_id: String(formData.get("id") ?? "") });
  redirect("/settings#api");
}
