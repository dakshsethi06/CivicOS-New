"use server";

import { headers } from "next/headers";
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

  const department = String(formData.get("department") ?? "") || null;
  const { error: rowError } = await admin
    .from("users")
    .insert({ id: created.user.id, organization_id: session.orgId, role, full_name: fullName, email, department_id: department });
  if (rowError) {
    await admin.auth.admin.deleteUser(created.user.id);
    back("error", rowError.message);
  }
  back("added", `${fullName} can now sign in with the password you set.`);
}

async function siteOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/**
 * Invites someone by email with a role and department. The database records the invitation (and checks the plan's
 * seat limit, counting pending invitations); Supabase sends the email. If the email cannot be sent (Supabase's built-in
 * mailer allows only a few an hour) the administrator gets a one-time link to share instead.
 */
export async function inviteMember(formData: FormData) {
  const session = await requireSession();
  const back: (key: "error" | "added", msg: string, link?: string) => never = (key, msg, link) =>
    redirect(`/settings?${key}=${encodeURIComponent(msg)}${link ? `&link=${encodeURIComponent(link)}` : ""}#team`);
  if (session.role !== "city_admin") back("error", "Only a City Administrator can invite people.");
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const role = String(formData.get("role") ?? "");
  const department = String(formData.get("department") ?? "") || null;

  const supabase = await createClient();
  const { error } = await supabase.rpc("invitation_create", { p_email: email, p_role: role, p_department: department });
  if (error) back("error", error.message);

  const admin = createAdminClient();
  const redirectTo = `${await siteOrigin()}/auth/accept`;
  const sent = await admin.auth.admin.inviteUserByEmail(email, { redirectTo });
  if (!sent.error) back("added", `Invitation emailed to ${email}. It is valid for 7 days.`);

  // the email could not be sent (rate limit, or the address already has an account): give the admin a link to share
  const link = await admin.auth.admin.generateLink({ type: sent.error.message.toLowerCase().includes("already") ? "magiclink" : "invite", email, options: { redirectTo } });
  if (link.error || !link.data.properties?.action_link) back("error", `The invitation was recorded but no email or link could be made: ${sent.error.message}`);
  back("added", `The email could not be sent (${sent.error.message}). Share this one-time link with ${email} instead:`, link.data.properties.action_link);
}

export async function revokeInvitation(formData: FormData) {
  await requireSession();
  const supabase = await createClient();
  const { error } = await supabase.rpc("invitation_revoke", { p_id: String(formData.get("id") ?? "") });
  redirect(`/settings?${error ? `error=${encodeURIComponent(error.message)}` : "added=Invitation%20revoked."}#team`);
}

/** Puts a member in a department; officers then see only that department's complaints and tasks. */
export async function setMemberDepartment(formData: FormData) {
  const session = await requireSession();
  if (session.role !== "city_admin") redirect("/settings?error=Only%20a%20City%20Administrator%20can%20change%20departments.#team");
  const supabase = await createClient();
  const { error } = await supabase.from("users")
    .update({ department_id: String(formData.get("department") ?? "") || null })
    .eq("id", String(formData.get("id") ?? ""));
  redirect(`/settings?${error ? `error=${encodeURIComponent(error.message)}` : "added=" + encodeURIComponent("Department updated. It applies from the member's next sign-in.")}#team`);
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
