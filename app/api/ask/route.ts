import { NextResponse } from "next/server";
import { deepseekConfigured } from "@/lib/ai/deepseek";
import { getDb } from "@/lib/db";
import { answerQuestion } from "@/lib/qa";

export const dynamic = "force-dynamic";

const MAX_QUESTION = 300;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { question?: unknown; documentId?: unknown }
    | null;

  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (question.length < 2 || question.length > MAX_QUESTION) {
    return NextResponse.json({ error: "bad_question" }, { status: 400 });
  }

  const raw = body?.documentId;
  const documentId =
    typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : null;

  if (!deepseekConfigured()) {
    return NextResponse.json({ error: "missing_api_key" }, { status: 503 });
  }

  const answer = await answerQuestion(getDb(), question, { documentId });
  return NextResponse.json({ answer });
}
