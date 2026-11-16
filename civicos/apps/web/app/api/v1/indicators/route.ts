import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Public data API. Authenticate with an API key from Settings:
 *   curl -H "Authorization: Bearer civ_..." "https://<host>/api/v1/indicators?metric=complaints_registered&year=2025&ward=K/W"
 * Without `metric` it lists the available metrics. Limited to 60 requests a minute per organization.
 */
export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization") ?? "";
  const key = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!key) return NextResponse.json({ error: "Send your API key as: Authorization: Bearer <key>" }, { status: 401 });

  const q = request.nextUrl.searchParams;
  const year = Number(q.get("year"));
  const { data, error } = await createAdminClient().rpc("api_indicators", {
    p_key: key,
    p_metric: q.get("metric"),
    p_year: Number.isInteger(year) && year > 0 ? year : null,
    p_ward: q.get("ward"),
  });
  if (error || !data) return NextResponse.json({ error: "The request could not be processed" }, { status: 500 });

  const { status, ...body } = data as { status: number } & Record<string, unknown>;
  return NextResponse.json(body, { status, headers: status === 429 ? { "retry-after": "60" } : undefined });
}
