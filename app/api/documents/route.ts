import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { extractPolicyElements } from "@/lib/ai/extract";
import { deepseekConfigured } from "@/lib/ai/deepseek";
import { extractBenefitTable } from "@/lib/benefit-table";
import { getDb, uploadPathFor } from "@/lib/db";
import { extractPdf } from "@/lib/pdf";
import { extractPolicyMeta } from "@/lib/policy-meta";
import { segmentPolicy } from "@/lib/segmentation";
import { extractSummaryCoverages } from "@/lib/summary-table";
import { checkToc, extractTocEntries } from "@/lib/toc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ExistingRow = { id: number; filename: string };

export async function GET() {
  const db = getDb();
  const documents = db
    .prepare(
      "SELECT id, filename, page_count, char_count, byte_size, has_text_layer, status, created_at FROM document ORDER BY id DESC",
    )
    .all();

  return NextResponse.json({ documents });
}

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "invalid_form" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing_file" }, { status: 400 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length < 5 || bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
    return NextResponse.json({ error: "not_pdf" }, { status: 415 });
  }

  const db = getDb();
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const existing = db
    .prepare("SELECT id, filename FROM document WHERE sha256 = ?")
    .get(sha256) as ExistingRow | undefined;

  if (existing) {
    return NextResponse.json({ id: existing.id, filename: existing.filename, duplicate: true });
  }

  const inserted = db
    .prepare("INSERT INTO document (sha256, filename, byte_size, status) VALUES (?, ?, ?, 'parsing')")
    .run(sha256, file.name, bytes.length);
  const documentId = Number(inserted.lastInsertRowid);

  try {
    const extracted = await extractPdf(new Uint8Array(bytes));
    // 标题以合同自带目录为准：正文里标题与正文混排，靠文字样式分不开
    const tocEntries = extractTocEntries(extracted.pages);
    const tocTitles = new Map<string, string>();
    for (const entry of tocEntries) {
      if (entry.title) tocTitles.set(entry.no, entry.title);
    }

    const segmented = segmentPolicy(extracted.pages, tocTitles);
    const meta = extractPolicyMeta(extracted.pages);
    const benefits = extractBenefitTable(extracted.pages);
    const toc = checkToc(
      extracted.pages,
      segmented.clauses.map((clause) => clause.clause_no),
    );
    await writeFile(uploadPathFor(documentId), bytes);

    db.exec("BEGIN");
    try {
      const insertPage = db.prepare(
        "INSERT INTO page (document_id, page_no, width, height, char_count, text) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const page of extracted.pages) {
        insertPage.run(documentId, page.page_no, page.width, page.height, page.char_count, page.text);
      }

      const insertClause = db.prepare(
        "INSERT INTO clause (document_id, seq, page_from, page_to, clause_no, heading_path, category, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const clause of segmented.clauses) {
        insertClause.run(
          documentId,
          clause.seq,
          clause.page_from,
          clause.page_to,
          clause.clause_no,
          clause.heading_path,
          clause.category,
          clause.text,
        );
      }

      db.prepare(
        "UPDATE document SET page_count = ?, char_count = ?, has_text_layer = ?, clause_count = ?, clause_coverage = ?, toc_expected = ?, toc_matched = ?, status = 'parsed' WHERE id = ?",
      ).run(
        extracted.pageCount,
        extracted.charCount,
        extracted.hasTextLayer ? 1 : 0,
        segmented.stats.clause_count,
        segmented.stats.coverage,
        toc.expected.length,
        toc.matched,
        documentId,
      );

      const policyInsert = db
        .prepare(
          "INSERT INTO policy (document_id, category, insurer, product_name, policy_no, data) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          documentId,
          meta.category,
          meta.insurer,
          meta.product_name,
          meta.policy_no,
          JSON.stringify({
            ...meta,
            benefit_table: {
              annual_limit: benefits.annual_limit,
              renewal_limit: benefits.renewal_limit,
              waiting_days: benefits.waiting_days,
              waiting_exceptions: benefits.waiting_exceptions,
            },
          }),
        );

      const policyId = Number(policyInsert.lastInsertRowid);
      const attachClause = db
        .prepare(
          "SELECT id FROM clause WHERE document_id = ? AND clause_no LIKE '附表%' ORDER BY seq LIMIT 1",
        )
        .get(documentId) as { id: number } | undefined;

      const insertCoverage = db.prepare(
        "INSERT INTO coverage (policy_id, name, benefit_type, data, citation_clause_id, confidence, review_status) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const item of benefits.items) {
        insertCoverage.run(
          policyId,
          item.name,
          "reimburse",
          JSON.stringify({ hospital_scope: item.hospital_scope, tiers: item.tiers }),
          attachClause?.id ?? null,
          item.tiers.length > 0 ? 0.7 : 0.3,
          item.tiers.length > 0 ? "ok" : "needs_review",
        );
      }

      // 两页式保单摘要：保障责任明细表里的「责任名 + 保额」用规则先抽一遍，AI 再补比例和说明
      for (const item of extractSummaryCoverages(extracted.pages)) {
        insertCoverage.run(
          policyId,
          item.name,
          "fixed",
          JSON.stringify({
            hospital_scope: "",
            tiers: item.ratio && item.ratio > 0 ? [{ when: "标准情形", ratio: item.ratio }] : [],
            annual_limit: item.amount,
            annual_limit_unit: "元",
            deductible: item.deductible,
            page: item.page,
            source: "rules",
          }),
          attachClause?.id ?? null,
          0.6,
          item.ratio ? "ok" : "needs_review",
        );
      }

      db.prepare(
        "INSERT INTO extraction_run (document_id, stage, engine, status, finished_at) VALUES (?, 'text_extract', 'pdfjs', 'succeeded', datetime('now'))",
      ).run(documentId);

      db.prepare(
        "INSERT INTO extraction_run (document_id, stage, engine, status, finished_at) VALUES (?, 'segment', 'rules', 'succeeded', datetime('now'))",
      ).run(documentId);

      db.exec("COMMIT");
    } catch (cause) {
      db.exec("ROLLBACK");
      throw cause;
    }

    // AI 要素抽取是主路径：失败不影响入库（规则结果还在），只记一条 extraction_run
    let ai = { status: "skipped", elements: 0, coverages: 0 };
    if (deepseekConfigured()) {
      try {
        const summary = await extractPolicyElements(documentId);
        ai = { status: summary.status, elements: summary.elements, coverages: summary.coverages };
      } catch (cause) {
        ai = { status: "failed", elements: 0, coverages: 0 };
        db.prepare(
          "INSERT INTO extraction_run (document_id, stage, engine, status, error, finished_at) VALUES (?, 'ai_extract', 'deepseek', 'failed', ?, datetime('now'))",
        ).run(documentId, cause instanceof Error ? cause.message : String(cause));
      }
    }

    return NextResponse.json({
      id: documentId,
      duplicate: false,
      pages: extracted.pageCount,
      hasTextLayer: extracted.hasTextLayer,
      clauses: segmented.stats.clause_count,
      coverage: segmented.stats.coverage,
      toc_missing: toc.missing,
      benefits: benefits.items.length,
      ai: ai.status,
      ai_elements: ai.elements,
      ai_coverages: ai.coverages,
    });
  } catch (cause) {
    // 解析失败要清掉占位行，否则 sha256 唯一约束会让用户无法重试
    db.prepare("DELETE FROM document WHERE id = ?").run(documentId);
    return NextResponse.json(
      { error: "parse_failed", detail: cause instanceof Error ? cause.message : String(cause) },
      { status: 422 },
    );
  }
}
