/**
 * 抽取回归基线：把当前库里每份保单的「抽取结果形状」压成一份快照，
 * 改提示词 / 改归类表 / 改规则之后跑一遍，就能看出哪份保单丢了几条、多了几条。
 *
 *   npm run eval            # 跟 data/eval-baseline.json 对比，有变化就列出并以 1 退出
 *   npm run eval -- --update  # 用当前结果覆盖基线（确认改动是想要的之后再用）
 *
 * 只读本机库，不调模型，不打印姓名/证件号；快照里只放要素标签与值。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getDb } from "../lib/db";
import { exclusionGroupOf, groupExclusions } from "../lib/elements";

const BASELINE = path.join(process.cwd(), "data", "eval-baseline.json");

type ElementSnapshot = {
  kind: string;
  category: string;
  label: string;
  value: string;
  unit: string;
  needsReview: boolean;
};

type PolicySnapshot = {
  documentId: number;
  filename: string;
  category: string;
  policyNo: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  waitingDays: number | null;
  counts: { elements: number; coverage: number; exclusion: number; term: number; needsReview: number };
  exclusionGroups: { id: string; label: string; count: number }[];
  coverages: string[];
  elements: ElementSnapshot[];
};

function snapshot(): PolicySnapshot[] {
  const db = getDb();
  const documents = db
    .prepare("SELECT id, filename FROM document ORDER BY id")
    .all() as unknown as { id: number; filename: string }[];

  return documents.map((document) => {
    const policy = db
      .prepare("SELECT id, category, policy_no, data FROM policy WHERE document_id = ? ORDER BY id DESC LIMIT 1")
      .get(document.id) as { id: number; category: string; policy_no: string | null; data: string } | undefined;

    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(policy?.data ?? "{}") as Record<string, unknown>;
    } catch {
      data = {};
    }

    const rows = db
      .prepare(
        "SELECT kind, category, label, value, unit, quote, review_status FROM policy_element WHERE document_id = ? ORDER BY page_no, id",
      )
      .all(document.id) as unknown as {
      kind: string;
      category: string | null;
      label: string;
      value: string;
      unit: string;
      quote: string;
      review_status: string;
    }[];

    const visible = rows.filter((row) => row.review_status !== "ignored");
    const elements: ElementSnapshot[] = visible.map((row) => ({
      kind: row.kind,
      category: row.kind === "exclusion" ? exclusionGroupOf(row).id : (row.category ?? ""),
      label: row.label,
      value: row.value,
      unit: row.unit,
      needsReview: row.review_status === "needs_review",
    }));

    const coverages = policy
      ? (
          db
            .prepare("SELECT name, data FROM coverage WHERE policy_id = ? ORDER BY CASE WHEN source = 'ai' THEN 0 ELSE 1 END, id")
            .all(policy.id) as unknown as { name: string | null; data: string }[]
        ).map((row) => {
          let tiers: { when: string; ratio: number }[] = [];
          try {
            tiers = (JSON.parse(row.data) as { tiers?: { when: string; ratio: number }[] }).tiers ?? [];
          } catch {
            tiers = [];
          }
          return `${row.name ?? "未命名"} [${tiers.map((tier) => `${Math.round(tier.ratio * 100)}%`).join("/") || "无比例"}]`;
        })
      : [];

    const benefitTable = (data.benefit_table as { waiting_days?: number | null } | undefined) ?? {};
    const waiting = benefitTable.waiting_days ?? (data.waiting_days as number | null | undefined) ?? null;

    return {
      documentId: document.id,
      filename: document.filename,
      category: policy?.category ?? "unknown",
      policyNo: policy?.policy_no ?? null,
      effectiveFrom: (data.effective_from as string | null | undefined) ?? null,
      effectiveTo: (data.effective_to as string | null | undefined) ?? null,
      waitingDays: waiting || null,
      counts: {
        elements: visible.length,
        coverage: visible.filter((row) => row.kind === "coverage").length,
        exclusion: visible.filter((row) => row.kind === "exclusion").length,
        term: visible.filter((row) => row.kind === "term").length,
        needsReview: visible.filter((row) => row.review_status === "needs_review").length,
      },
      exclusionGroups: groupExclusions(visible.filter((row) => row.kind === "exclusion")).map((group) => ({
        id: group.id,
        label: group.label,
        count: group.items.length,
      })),
      coverages,
      elements,
    };
  });
}

function keyOf(policy: PolicySnapshot, element: ElementSnapshot): string {
  return `${policy.filename} | ${element.kind}/${element.category} | ${element.label} | ${element.value}${element.unit}`;
}

function diff(before: PolicySnapshot[], after: PolicySnapshot[]): string[] {
  const lines: string[] = [];
  const beforePolicies = new Map(before.map((item) => [item.documentId, item]));

  for (const policy of after) {
    const old = beforePolicies.get(policy.documentId);
    if (!old) {
      lines.push(`+ 新保单 #${policy.documentId} ${policy.filename}（${policy.counts.elements} 条要素）`);
      continue;
    }

    for (const key of ["elements", "coverage", "exclusion", "term", "needsReview"] as const) {
      const delta = policy.counts[key] - old.counts[key];
      if (delta !== 0) lines.push(`~ ${policy.filename} ${key} ${old.counts[key]} → ${policy.counts[key]} (${delta > 0 ? "+" : ""}${delta})`);
    }

    if (policy.policyNo !== old.policyNo) lines.push(`~ ${policy.filename} 保单号 ${old.policyNo} → ${policy.policyNo}`);
    if (policy.effectiveFrom !== old.effectiveFrom || policy.effectiveTo !== old.effectiveTo) {
      lines.push(`~ ${policy.filename} 保险期间 ${old.effectiveFrom}~${old.effectiveTo} → ${policy.effectiveFrom}~${policy.effectiveTo}`);
    }
    if (policy.waitingDays !== old.waitingDays) {
      lines.push(`~ ${policy.filename} 等待期 ${old.waitingDays} → ${policy.waitingDays}`);
    }

    const oldCoverages = new Set(old.coverages);
    const newCoverages = new Set(policy.coverages);
    for (const name of policy.coverages) if (!oldCoverages.has(name)) lines.push(`+ ${policy.filename} 责任 ${name}`);
    for (const name of old.coverages) if (!newCoverages.has(name)) lines.push(`- ${policy.filename} 责任 ${name}`);

    const oldKeys = new Set(old.elements.map((element) => keyOf(policy, element)));
    const newKeys = new Set(policy.elements.map((element) => keyOf(policy, element)));
    for (const key of newKeys) if (!oldKeys.has(key)) lines.push(`+ ${key}`);
    for (const key of oldKeys) if (!newKeys.has(key)) lines.push(`- ${key}`);
  }

  for (const policy of before) {
    if (!after.some((item) => item.documentId === policy.documentId)) {
      lines.push(`- 保单 #${policy.documentId} ${policy.filename} 不在库里了`);
    }
  }

  return lines;
}

const current = snapshot();
const update = process.argv.includes("--update");

if (!existsSync(BASELINE)) {
  mkdirSync(path.dirname(BASELINE), { recursive: true });
  writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  console.log(`基线已建立：${BASELINE}`);
  console.log(`共 ${current.length} 份保单、${current.reduce((sum, item) => sum + item.counts.elements, 0)} 条要素。`);
  process.exit(0);
}

const before = JSON.parse(readFileSync(BASELINE, "utf8")) as PolicySnapshot[];

if (update) {
  writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  const lines = diff(before, current);
  console.log(`基线已更新（${lines.length} 处变化）`);
  for (const line of lines.slice(0, 40)) console.log(line);
  process.exit(0);
}

const changes = diff(before, current);
if (changes.length === 0) {
  console.log(`抽取结果与基线一致：${current.length} 份保单、${current.reduce((sum, item) => sum + item.counts.elements, 0)} 条要素。`);
  process.exit(0);
}

console.log(`抽取结果与基线不同（${changes.length} 处）：`);
for (const line of changes.slice(0, 80)) console.log(line);
if (changes.length > 80) console.log(`…还有 ${changes.length - 80} 处`);
console.log("\n确认这些变化是想要的之后，跑 npm run eval -- --update 覆盖基线。");
process.exit(1);
