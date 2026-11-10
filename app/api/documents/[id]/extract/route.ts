import { NextResponse } from "next/server";
import { readExtractProgress } from "@/lib/ai/extract";
import { deepseekConfigured } from "@/lib/ai/deepseek";
import { getDb } from "@/lib/db";
import { extractionRunning, startExtraction } from "@/lib/extract-job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseId(value: string): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** 进度：状态和批次都从库里读，刷新、重启进程都不会丢。 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const documentId = parseId((await params).id);
  if (documentId === null) return NextResponse.json({ error: "bad_id" }, { status: 400 });

  const db = getDb();
  const exists = db.prepare("SELECT id FROM document WHERE id = ?").get(documentId) as { id: number } | undefined;
  if (!exists) return NextResponse.json({ error: "not_found" }, { status: 404 });

  return NextResponse.json({
    ...readExtractProgress(db, documentId),
    running: extractionRunning(documentId),
    configured: deepseekConfigured(),
  });
}

/** 起一次（或继续一次）抽取：立刻返回 202，进度看 GET。 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const documentId = parseId((await params).id);
  if (documentId === null) return NextResponse.json({ error: "bad_id" }, { status: 400 });
  if (!deepseekConfigured()) return NextResponse.json({ error: "no_api_key" }, { status: 409 });

  const db = getDb();
  const exists = db.prepare("SELECT id FROM document WHERE id = ?").get(documentId) as { id: number } | undefined;
  if (!exists) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let force = false;
  try {
    const body = (await request.json()) as { force?: boolean };
    force = body?.force === true;
  } catch {
    // 没带 body 当作「继续上次」
  }

  if (!startExtraction(documentId, { force })) {
    return NextResponse.json({ started: false, running: true }, { status: 202 });
  }

  return NextResponse.json({ started: true, force }, { status: 202 });
}
