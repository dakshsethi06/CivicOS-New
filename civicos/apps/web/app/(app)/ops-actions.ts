"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ApiError, apiConfigured, callApi } from "@/lib/api";
import { requireSession } from "@/lib/auth";
import type { SimResult } from "@/lib/ops";
import { createClient } from "@/lib/supabase/server";

const OPS_PAGES = ["/water/network", "/waste/operations", "/traffic", "/dashboard", "/map"];

function backTo(formData: FormData): string {
  const b = String(formData.get("back") ?? "/water/network");
  return OPS_PAGES.includes(b) ? b : "/water/network";
}

async function start(path: string, formData: FormData, started: string) {
  const session = await requireSession();
  const back = backTo(formData);
  let note: string;
  if (session.role !== "city_admin") note = "Only a City Administrator can do this.";
  else if (!apiConfigured()) note = "The CivicOS API is not configured (CIVICOS_API_URL), so models cannot be trained from here.";
  else {
    try {
      await callApi<{ job_id: string }>(path, undefined, 30_000);
      note = started;
    } catch (e) {
      note = e instanceof ApiError ? e.message : "The job could not be started.";
    }
  }
  redirect(`${back}?note=${encodeURIComponent(note)}`);
}

/** Replaces the workspace's operations data with the labelled demonstration dataset and trains every model. */
export async function buildDemo(formData: FormData) {
  await start("/v1/ops/demo", formData, "Building the demonstration dataset and training the models. This takes about a minute.");
}

/** Retrains water, waste and traffic models on the latest readings and re-plans routes. */
export async function retrain(formData: FormData) {
  await start("/v1/ops/train", formData, "Retraining the models on the latest readings.");
}

export async function reviewAnomaly(formData: FormData) {
  await requireSession();
  const supabase = await createClient();
  const { error } = await supabase.rpc("water_anomaly_review", {
    p_id: Number(formData.get("id")),
    p_status: String(formData.get("status")),
  });
  revalidatePath("/water/network");
  if (error) redirect(`/water/network?note=${encodeURIComponent(error.message)}`);
}

export async function simulate(input: { road_id: string; action: string; capacity_factor: number; extra_trips: number }):
  Promise<{ ok: true; result: SimResult } | { ok: false; message: string }> {
  const session = await requireSession();
  if (session.role !== "city_admin" && session.role !== "dept_officer") return { ok: false, message: "Only officers can run simulations." };
  if (!apiConfigured()) return { ok: false, message: "The CivicOS API is not configured (CIVICOS_API_URL)." };
  try {
    const result = await callApi<SimResult>("/v1/traffic/simulate", input, 60_000);
    revalidatePath("/traffic");
    return { ok: true, result };
  } catch (e) {
    return { ok: false, message: e instanceof ApiError ? e.message : "The simulation failed." };
  }
}
