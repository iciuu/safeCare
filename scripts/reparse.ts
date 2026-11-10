/**
 * 重新解析一份已入库的保单原文：只重跑「PDF 文本层 + 规则」这一段，
 * 不动 AI 抽出来的要素、也不动手工改过的字段。
 *
 *   npm run reparse -- 28
 *
 * 用场景：PDF 抽取器升级后（例如补上了表单域文字），老文件要重新解一遍。
 * 之后在详情页点「重跑」让 AI 按新原文重新抽要素。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { extractBenefitTable } from "../lib/benefit-table";
import { getDb } from "../lib/db";
import { extractPdf } from "../lib/pdf";
import { extractPolicyMeta } from "../lib/policy-meta";
import { segmentPolicy } from "../lib/segmentation";
import { extractSummaryCoverages } from "../lib/summary-table";
import { checkToc, extractTocEntries } from "../lib/toc";

async function main(): Promise<void> {
  const documentId = Number(process.argv[2]);
  if (!Number.isInteger(documentId) || documentId <= 0) {
    console.error("用法：npm run reparse -- <documentId>");
    process.exit(1);
  }

  const db = getDb();
  const document = db.prepare("SELECT id, filename FROM document WHERE id = ?").get(documentId) as
    | { id: number; filename: string }
    | undefined;

  if (!document) {
    console.error(`没有 id=${documentId} 的保单`);
    process.exit(1);
  }

  const file = path.join(process.cwd(), "data", "uploads", `${documentId}.pdf`);
  const extracted = await extractPdf(new Uint8Array(readFileSync(file)));

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

  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM page WHERE document_id = ?").run(documentId);
    db.prepare("DELETE FROM clause WHERE document_id = ?").run(documentId);

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

    // 规则层只填它读到的字段：AI 的值和手工改的值都保留
    const policy = db
      .prepare("SELECT id, data FROM policy WHERE document_id = ? ORDER BY id DESC LIMIT 1")
      .get(documentId) as { id: number; data: string } | undefined;

    if (policy) {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(policy.data || "{}") as Record<string, unknown>;
      } catch {
        data = {};
      }
      for (const [key, value] of Object.entries(meta)) {
        if (value === null || value === undefined || value === "") continue;
        data[key] = value;
      }
      const table = (data.benefit_table as Record<string, unknown> | undefined) ?? {};
      data.benefit_table = {
        ...table,
        annual_limit: benefits.annual_limit ?? (table.annual_limit as number | null | undefined) ?? null,
        renewal_limit: benefits.renewal_limit ?? (table.renewal_limit as number | null | undefined) ?? null,
        waiting_days: benefits.waiting_days ?? (table.waiting_days as number | null | undefined) ?? null,
        waiting_exceptions: benefits.waiting_exceptions,
      };

      db.prepare(
        "UPDATE policy SET data = ?, insurer = COALESCE(?, insurer), product_name = COALESCE(?, product_name), policy_no = COALESCE(?, policy_no) WHERE id = ?",
      ).run(JSON.stringify(data), meta.insurer, meta.product_name, meta.policy_no, policy.id);

      const summary = extractSummaryCoverages(extracted.pages);
      if (summary.length > 0) {
        const attachClause = db
          .prepare("SELECT id FROM clause WHERE document_id = ? AND clause_no LIKE '附表%' ORDER BY seq LIMIT 1")
          .get(documentId) as { id: number } | undefined;
        const insertCoverage = db.prepare(
          "INSERT INTO coverage (policy_id, name, benefit_type, data, citation_clause_id, confidence, review_status) VALUES (?, ?, ?, ?, ?, ?, ?)",
        );
        for (const item of summary) {
          insertCoverage.run(
            policy.id,
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
      }
    }

    db.exec("COMMIT");
  } catch (cause) {
    db.exec("ROLLBACK");
    throw cause;
  }

  console.log(
    `${document.filename}：${extracted.pageCount} 页 / ${extracted.charCount} 字，` +
      `条款 ${segmented.stats.clause_count} 条；生效 ${meta.effective_from ?? "未识别"} ~ ${meta.effective_to ?? "未识别"}`,
  );
}

void main();
