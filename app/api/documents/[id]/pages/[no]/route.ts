import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; no: string }> },
) {
  const { id, no } = await params;
  const documentId = Number(id);
  const pageNo = Number(no);

  if (!Number.isInteger(documentId) || !Number.isInteger(pageNo)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const db = getDb();
  const row = db
    .prepare("SELECT text, char_count FROM page WHERE document_id = ? AND page_no = ?")
    .get(documentId, pageNo) as { text: string; char_count: number } | undefined;

  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  return NextResponse.json({ page_no: pageNo, text: row.text, char_count: row.char_count });
}
