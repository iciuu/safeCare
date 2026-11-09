import { readFile } from "node:fs/promises";
import { getDb, uploadPathFor } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const documentId = Number(id);
  if (!Number.isInteger(documentId) || documentId <= 0) {
    return new Response("bad request", { status: 400 });
  }

  const db = getDb();
  const row = db.prepare("SELECT id, filename FROM document WHERE id = ?").get(documentId) as
    | { id: number; filename: string }
    | undefined;

  if (!row) return new Response("not found", { status: 404 });

  try {
    const bytes = await readFile(uploadPathFor(documentId));
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
        "cache-control": "private, max-age=0, must-revalidate",
      },
    });
  } catch {
    return new Response("file missing", { status: 410 });
  }
}
