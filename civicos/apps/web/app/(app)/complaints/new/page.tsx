import type { Metadata } from "next";
import Link from "next/link";
import { ReportForm } from "@/components/complaints/report-form";
import { ErrorNote } from "@/components/ui";
import { requireSession } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { submitComplaint } from "../actions";

export const metadata: Metadata = { title: "Report a problem" };

export default async function NewComplaintPage({ searchParams }: PageProps<"/complaints/new">) {
  await requireSession();
  const { error } = await searchParams;
  const supabase = await createClient();
  const [categories, wards, map] = await Promise.all([
    supabase.from("complaint_categories").select("id, name").order("name"),
    supabase.from("city_zones").select("id, code, name").order("code"),
    supabase.rpc("map_data", { p_year: null, p_issue: null }),
  ]);
  const zones = (map.data as { zones?: GeoJSON.FeatureCollection<GeoJSON.Geometry, { code: string; name: string }> } | null)?.zones;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <Link href="/complaints" className="text-xs text-muted hover:text-ink">← Complaints</Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Report a problem</h1>
        <p className="mt-1 text-sm text-muted">Your report goes to the municipal staff of this workspace. You can follow its progress afterwards.</p>
      </div>
      <ErrorNote message={typeof error === "string" ? error : undefined} />
      <ReportForm action={submitComplaint} categories={categories.data ?? []} wards={wards.data ?? []} zones={zones && zones.features.length ? zones : null} />
    </div>
  );
}
