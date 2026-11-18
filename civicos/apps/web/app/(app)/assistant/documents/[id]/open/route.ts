import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Opens a cited source document: a short-lived signed link to the private file, at the cited page for PDFs.
 * RLS decides whether the user may see the document at all (residents only reach public ones).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", req.url));

  const { data: doc } = await supabase.from("documents").select("storage_path, mime_type").eq("id", id).maybeSingle();
  if (!doc?.storage_path) return new NextResponse("Document not found.", { status: 404 });

  const { data, error } = await supabase.storage.from("documents").createSignedUrl(doc.storage_path, 300);
  if (error || !data) return new NextResponse("The document could not be opened.", { status: 403 });

  const page = Number(req.nextUrl.searchParams.get("page"));
  const isPdf = doc.mime_type === "application/pdf" || doc.storage_path.toLowerCase().endsWith(".pdf");
  return NextResponse.redirect(isPdf && page > 0 ? `${data.signedUrl}#page=${page}` : data.signedUrl);
}
