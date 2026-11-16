"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

function fail(path: string, message: string): never {
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

export async function login(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) fail("/login", "Enter your email and password.");

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) fail("/login", error.message);

  redirect("/dashboard");
}

/** Creates the auth user, then the organization, admin user and chosen city dataset in one database transaction. */
export async function registerOrganization(formData: FormData) {
  const orgName = String(formData.get("org_name") ?? "").trim();
  const fullName = String(formData.get("full_name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const city = formData.get("city") === "mumbai" ? "mumbai" : null; // null = empty workspace

  if (!orgName || !fullName || !email) fail("/register", "All fields are required.");
  if (password.length < 8) fail("/register", "Password must be at least 8 characters.");

  const admin = createAdminClient();

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (createError || !created.user) fail("/register", createError?.message ?? "Could not create the account.");

  const { error: rpcError } = await admin.rpc("register_organization", {
    p_user_id: created.user.id,
    p_org_name: orgName,
    p_full_name: fullName,
    p_email: email,
    p_city: city,
  });
  if (rpcError) {
    await admin.auth.admin.deleteUser(created.user.id); // do not leave an orphan auth user
    fail("/register", rpcError.message);
  }

  // Sign in after the claims trigger has run, so the first token already carries org_id and role.
  const supabase = await createClient();
  const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
  if (signInError) fail("/login", "Organization created. Please sign in.");

  redirect("/dashboard");
}

/** Resident sign-up: creates a citizen account inside the chosen municipality's workspace. */
export async function joinAsCitizen(formData: FormData) {
  const slug = String(formData.get("org") ?? "").trim();
  const fullName = String(formData.get("full_name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!slug || !fullName || !email) fail("/join", "All fields are required.");
  if (password.length < 8) fail("/join", "Password must be at least 8 characters.");

  const admin = createAdminClient();
  const { data: org } = await admin.from("organizations").select("id").eq("slug", slug).eq("status", "active").maybeSingle();
  if (!org) fail("/join", "That municipality was not found.");

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (createError || !created.user) fail("/join", createError?.message ?? "Could not create the account.");

  const { error: rowError } = await admin
    .from("users")
    .insert({ id: created.user.id, organization_id: org.id, role: "citizen", full_name: fullName, email });
  if (rowError) {
    await admin.auth.admin.deleteUser(created.user.id);
    fail("/join", rowError.message);
  }

  const supabase = await createClient();
  const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
  if (signInError) fail("/login", "Account created. Please sign in.");
  redirect("/complaints");
}

export async function logout() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
