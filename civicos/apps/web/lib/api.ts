import "server-only";
import { createClient } from "./supabase/server";

/**
 * Client for the CivicOS API (apps/api). Calls are made from the web server with the signed-in user's own Supabase
 * access token, which the API verifies and applies to every database query, so Row Level Security still decides what
 * the user can see. Without CIVICOS_API_URL the web app falls back to its built-in keyword retrieval.
 */
export function apiConfigured(): boolean {
  return Boolean(process.env.CIVICOS_API_URL);
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function callApi<T>(path: string, body?: unknown, timeoutMs = 120_000): Promise<T> {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new ApiError("Sign in again.", 401);
  const base = process.env.CIVICOS_API_URL!.replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${session.access_token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ApiError("The CivicOS API could not be reached. If it is on a free plan it may be waking up; try again in a minute.", 503);
  }
  const json = (await res.json().catch(() => null)) as { detail?: unknown } | null;
  if (!res.ok) {
    const detail = typeof json?.detail === "string" ? json.detail : `The CivicOS API returned an error (${res.status}).`;
    throw new ApiError(detail, res.status);
  }
  return json as T;
}
