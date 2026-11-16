import type { Metadata } from "next";
import Link from "next/link";
import { joinAsCitizen } from "@/app/auth/actions";
import { Button, Card, ErrorNote, Field } from "@/components/ui";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata: Metadata = { title: "Resident sign-up" };
export const dynamic = "force-dynamic"; // the list of municipalities changes as they register

export default async function JoinPage({ searchParams }: PageProps<"/join">) {
  const { error } = await searchParams;

  // Names of registered municipalities are public; nothing else about them is read here.
  let orgs: { name: string; slug: string }[] = [];
  let loadError: string | null = null;
  try {
    const { data, error: e } = await createAdminClient().from("organizations").select("name, slug").eq("status", "active").order("name");
    if (e) loadError = e.message;
    orgs = data ?? [];
  } catch (e) {
    loadError = e instanceof Error ? e.message : "Could not load municipalities.";
  }

  return (
    <Card className="p-6">
      <h1 className="text-xl font-semibold tracking-tight">Resident sign-up</h1>
      <p className="mt-1 text-sm text-muted">Create an account to report civic problems to your municipality and follow their progress.</p>

      <form action={joinAsCitizen} className="mt-6 space-y-4">
        <ErrorNote message={typeof error === "string" ? error : (loadError ?? undefined)} />
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-ink">Municipality</span>
          <select name="org" required defaultValue="" className="w-full rounded-lg border border-line bg-raised px-3 py-2.5 text-sm text-ink focus:border-accent focus:outline-none">
            <option value="" disabled>{orgs.length ? "Choose your municipality" : "No municipality has registered yet"}</option>
            {orgs.map((o) => <option key={o.slug} value={o.slug}>{o.name}</option>)}
          </select>
        </label>
        <Field label="Your name" name="full_name" autoComplete="name" required />
        <Field label="Email" name="email" type="email" autoComplete="email" required />
        <Field label="Password" name="password" type="password" autoComplete="new-password" minLength={8} hint="At least 8 characters." required />
        <Button type="submit" className="w-full" disabled={orgs.length === 0}>Create account</Button>
      </form>

      <p className="mt-6 text-center text-sm text-muted">
        Already have an account?{" "}
        <Link href="/login" className="text-accent hover:underline">Sign in</Link>
      </p>
    </Card>
  );
}
