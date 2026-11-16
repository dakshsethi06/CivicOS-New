"use server";

import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export async function refreshRecommendations() {
  await requireSession();
  const supabase = await createClient();
  const { error } = await supabase.rpc("refresh_recommendations");
  redirect(`/insights${error ? `?error=${encodeURIComponent(error.message)}` : "?refreshed=1"}`);
}

export async function decide(formData: FormData) {
  await requireSession();
  const supabase = await createClient();
  const t = (k: string) => String(formData.get(k) ?? "").trim();
  const { error } = await supabase.rpc("recommendation_decide", {
    p_id: t("id"), p_decision: t("decision"), p_note: t("note") || null, p_assignee: t("assignee") || null,
  });
  const filter = t("filter");
  redirect(`/insights?${filter ? `status=${filter}&` : ""}${error ? `error=${encodeURIComponent(error.message)}` : ""}#rec-${t("id")}`);
}
