/**
 * AI 要素抽取（整篇分页送模型）——替代原来「按本地切好的条款逐条补字段」的做法。
 *
 * 为什么要换：
 * 老链路的保单信息、保障表都靠正则认某家公司的排版，换个险种、换个模板就整段认不出；
 * 而条款本身（赔什么、不赔什么、赔多少）模型读得懂。
 *
 * 现在的分工：
 * - 模型：把原文里的要素成段抄出来，带 page 和逐字 quote；
 * - 本地（lib/elements.ts）：脱敏、引文反查、归类、去重、冲突标记、落库。
 *
 * 三条硬规则沿用 P2：
 * 1. 送出去之前整体脱敏，仍有标识符就整批阻断；
 * 2. 每条 quote 必须能在它声称的那批页面里反查到，反查不过直接丢；
 * 3. 模型不改原文，只抄要素；页码以本地页面文字为准，不以模型声称的为准。
 */

import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db";
import {
  dedupeElements,
  markConflicts,
  normalizeDate,
  normalizePolicyCategory,
  normalizeUnit,
  normalizeValue,
  type ElementDraft,
  type PolicyMetaPatch,
} from "../elements";
import { findEntityLeaks, findLeaks, redactDocument, type RedactionEntry } from "../redact";
import { DEEPSEEK_MODEL, deepseekConfigured, deepseekJson, type ChatMessage } from "./deepseek";
import { normalizeForQuote, quoteMatches } from "./enrich";

/**
 * 提示词版本：改了 systemPrompt 的结构或字段约束就要跟着改，
 * 记进 extraction_run，重跑后才能回答「这次少了几条是不是提示词改坏了」。
 */
export const PROMPT_VERSION = "extract-v1";

const MAX_BATCH_CHARS = 9000;
const MAX_BATCHES = 14;
const CONCURRENCY = 3;
const BUDGET_MS = 150_000;
const PAGE_MARK = /\[\[P:(\d+)\]\]/g;

export type ExtractedCoverage = {
  name: string;
  benefitType: string;
  /** ai = 模型抽的；rules = 本地附表解析的（分级比例通常比模型准，保留不丢） */
  source?: "ai" | "rules";
  hospitalScope: string;
  tiers: { when: string; ratio: number }[];
  annualLimit: number | null;
  annualLimitUnit: string;
  waitingDays: number | null;
  quote: string;
  page: number;
  confidence: number;
  reviewStatus: "ok" | "needs_review";
};

export type ExtractBundle = {
  policy: PolicyMetaPatch;
  coverages: ExtractedCoverage[];
  elements: ElementDraft[];
  rejected: number;
};

export type ExtractSummary = {
  status: "succeeded" | "partial" | "failed" | "skipped";
  batches: number;
  failedBatches: number;
  elements: number;
  coverages: number;
  rejected: number;
  tokens: number;
  error?: string;
};

export type PageInput = { page_no: number; text: string };

/** 按字符预算把页切成批次，页不切开——引文反查要落在整页文字上。 */
export function buildBatches<T extends { page_no: number; text: string }>(
  pages: T[],
  maxChars = MAX_BATCH_CHARS,
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let size = 0;

  for (const page of pages) {
    const length = page.text.length + 12;
    if (current.length > 0 && (size + length > maxChars || current.length >= 8)) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(page);
    size += length;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

function systemPrompt(): string {
  return [
    "你是保险合同要素抽取器。只输出一个 JSON 对象，不要 markdown、不要解释。",
    "输入是保单某几页的原文，每页前面有 [[P:页码]] 标记。页码是真实页码，必须原样引用。",
    "任务：把这份保单「保什么、不保什么、赔多少、什么时候生效」的事实抄成结构化要素。",
    "",
    "硬规则：",
    "1. 每条要素都要 quote：逐字摘自同一页原文，可以跨行，但不能改写、不能拼接两处原文。",
    "2. page 必须填 quote 所在那页的页码。",
    "3. 原文没写的不要补；不确定的宁可不给。禁止用常识推断保险责任。",
    "4. 数值只填数字（不带单位、不带千分位），单位填 unit：元/万元/%/天/个月/年/次。",
    "5. 一条要素只讲一件事：免责情形逐条拆，限额、比例、免赔额分开列。",
    "5.1 terms 只抽影响「赔不赔、赔多少」的金额与期间；费率调整、理赔资料与核定时限、退保退款时限、公示期这类流程不抽。",
    "5.2 疾病定义章节里逐病的医学指标（如「症状持续 90 天」）不是保单要素，不要抽。",
    "6. clause_no 只在原文明确出现条款编号时填（如 2.5 或 第 2.5 条），否则给空字符串。",
    "",
    "输出结构：",
    '{"policy":{"insurer":"","product_name":"","policy_no":"","category":"medical|critical_illness|accident|life|unknown","holder_name":"","insured_name":"","effective_from":"YYYY-MM-DD","effective_to":"YYYY-MM-DD","premium":0,"waiting_days":0,"hesitation_days":0,"page":1},',
    '"coverages":[{"name":"住院医疗保险金","benefit_type":"reimburse|fixed|allowance","hospital_scope":"二级及以上公立医院普通部","annual_limit":400,"annual_limit_unit":"万元","waiting_days":90,"tiers":[{"when":"已从基本医疗保险报销","ratio":1},{"when":"未从基本医疗保险报销","ratio":0.6}],"quote":"","page":5,"clause_no":"2.5"}],',
    '"exclusions":[{"text":"等待期内发生疾病","quote":"","page":3,"clause_no":"2.2"}],',
    '"terms":[{"label":"年度给付限额","value":"400","unit":"万元","condition":"","quote":"","page":5,"clause_no":"2.5"}]}',
    "",
    "policy 只在这一页确实印着投保单信息时才填，没印就整个字段给 null 或空字符串。",
    "coverages 是「保险责任」段落里的给付项目，每项一条；没有分级比例的 tiers 给空数组。",
    "如果某页是「保障责任明细 / 保额」表格（短期意外险的保单摘要），表里每一行责任都要单独作为一条 coverage：annual_limit 填该行保额，表里有免赔额/赔付比例就把比例写进 tiers（无分档时 tiers=[{when:\"标准情形\",ratio:赔付比例}]）。",
    "tiers 的 when 用不超过 20 字的条件短语（如「未以社保身份就诊」），不要把整句原文抄进去。",
    "exclusions 是「责任免除」里的情形，一条一事。",
    "terms 是散落在条款里的金额与期间：限额、比例、免赔额、等待期、宽限期、保险期间、保费、年龄限制等。",
  ].join("\n");
}

type RawPolicy = Record<string, unknown>;
type RawCoverage = Record<string, unknown>;
type RawElement = Record<string, unknown>;
type RawBatch = {
  policy?: RawPolicy;
  coverages?: RawCoverage[];
  exclusions?: RawElement[];
  terms?: RawElement[];
};

function textOf(value: unknown, limit: number): string {
  if (typeof value === "string") return value.trim().slice(0, limit);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function numberOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[,，\s]/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** 引文反查：先看模型说的那页，再扫整批。命中就返回真实页码。 */
export function locateQuote(pages: PageInput[], quote: string, claimedPage: number): number | null {
  if (quote.trim().length < 6) return null;

  const claimed = pages.find((page) => page.page_no === claimedPage);
  const ordered = claimed ? [claimed, ...pages.filter((page) => page !== claimed)] : [...pages];

  for (const page of ordered) {
    if (quoteMatches(page.text, quote)) return page.page_no;
  }
  return null;
}

function restoreText(value: string, restore: (input: string) => string): string {
  return value.includes("‹") ? restore(value) : value;
}

/**
 * 把某一批的模型输出变成可落库的要素：
 * 引文反查不过的直接丢，页码以本地文字为准。
 */
export function normalizeBatchResult(
  data: unknown,
  pages: PageInput[],
  restore: (input: string) => string,
): ExtractBundle {
  const payload = (data ?? {}) as RawBatch;
  const rejected = { count: 0 };

  const elements: ElementDraft[] = [];
  const coverages: ExtractedCoverage[] = [];

  const pushDraft = (kind: ElementDraft["kind"], raw: RawElement, fallbackLabel: string) => {
    const quote = textOf(raw.quote, 500);
    const claimedPage = numberOf(raw.page) ?? 0;
    const page = locateQuote(pages, quote, claimedPage);
    if (page === null) {
      rejected.count += 1;
      return;
    }

    elements.push({
      kind,
      // 免责条目模型只给 text，没有短标签：先留空，归类时用类别名当标签
      label: restoreText(textOf(raw.label ?? raw.name, 60), restore) || fallbackLabel,
      value: restoreText(textOf(raw.value ?? raw.text, 200), restore),
      unit: normalizeUnit(restoreText(textOf(raw.unit, 12), restore)),
      condition: restoreText(textOf(raw.condition, 120), restore),
      quote: restoreText(quote, restore),
      page,
      clauseNo: textOf(raw.clause_no, 20) || null,
      confidence: 0.75,
    });
  };

  // 标签留空：模型没给短标签时由归类层用类别名（既往症/医院范围/限额…）填，
  // 否则所有免责都叫「免责情形」，既看不出内容又会被冲突检测误判。
  for (const raw of Array.isArray(payload.exclusions) ? payload.exclusions.slice(0, 60) : []) {
    pushDraft("exclusion", raw, "");
  }

  for (const raw of Array.isArray(payload.terms) ? payload.terms.slice(0, 80) : []) {
    pushDraft("term", raw, "");
  }

  for (const raw of Array.isArray(payload.coverages) ? payload.coverages.slice(0, 40) : []) {
    const quote = textOf(raw.quote, 500);
    const page = locateQuote(pages, quote, numberOf(raw.page) ?? 0);
    if (page === null) {
      rejected.count += 1;
      continue;
    }

    const name = restoreText(textOf(raw.name, 60), restore);
    if (!name) {
      rejected.count += 1;
      continue;
    }

    // 「责任」这一段才叫保障：原文没写给付/报销字样的（比如疾病释义）不当成一条责任
    if (!/(保险金|给付|报销|赔付|保险责任)/.test(quote)) {
      rejected.count += 1;
      continue;
    }

    const tiers = (Array.isArray(raw.tiers) ? raw.tiers : [])
      .slice(0, 6)
      .map((tier) => {
        const item = (tier ?? {}) as Record<string, unknown>;
        const when = shortenTierCondition(restoreText(textOf(item.when, 40), restore));
        const rawRatio = numberOf(item.ratio);
        if (!when || rawRatio === null) return null;
        const ratio = rawRatio > 1 ? rawRatio / 100 : rawRatio;
        if (ratio <= 0 || ratio > 1) return null;
        return { when, ratio };
      })
      .filter((tier): tier is { when: string; ratio: number } => tier !== null);

    const rawLimit = numberOf(raw.annual_limit);
    // 0 是模型占位，不是「限额 0 元」
    const limit = rawLimit === null || rawLimit <= 0 ? null : rawLimit;
    const limitUnit = normalizeUnit(textOf(raw.annual_limit_unit, 8)) || "元";

    coverages.push({
      name,
      benefitType: ["reimburse", "fixed", "allowance"].includes(textOf(raw.benefit_type, 20))
        ? textOf(raw.benefit_type, 20)
        : "reimburse",
      hospitalScope: restoreText(textOf(raw.hospital_scope, 80), restore),
      tiers,
      // 统一换成元存，单位不再跟着变，避免显示成「10000 万元」
      annualLimit: limit === null ? null : limitUnit === "万元" ? Math.round(limit * 10_000) : Math.round(limit),
      annualLimitUnit: limit === null ? "" : "元",
      // 0 不是「等待 0 天」，是模型占位
      waitingDays: numberOf(raw.waiting_days) || null,
      quote: restoreText(quote, restore),
      page,
      confidence: tiers.length > 0 ? 0.8 : 0.6,
      reviewStatus: tiers.length > 0 || limit !== null ? "ok" : "needs_review",
    });

    elements.push({
      kind: "coverage",
      label: name,
      value: limit === null ? "" : String(limit),
      unit: limit === null ? "" : limitUnit,
      condition: restoreText(textOf(raw.hospital_scope, 80), restore),
      quote: restoreText(quote, restore),
      page,
      clauseNo: textOf(raw.clause_no, 20) || null,
      confidence: 0.75,
    });
  }

  return { policy: readPolicy(payload.policy, pages, restore), coverages, elements, rejected: rejected.count };
}

export type StoredCoverageRow = { name: string | null; data: string; source?: string };

export function readCoverageRows(db: DatabaseSync, policyId: number): StoredCoverageRow[] {
  return (
    db.prepare("SELECT name, data, source FROM coverage WHERE policy_id = ?").all(policyId) as unknown as StoredCoverageRow[]
  ).map((row) => ({ ...row }));
}

export function sameCoverageName(a: string | null, b: string | null): boolean {
  const left = normalizeValue(a ?? "").toLowerCase();
  const right = normalizeValue(b ?? "").toLowerCase();
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
}

/** 把库里的一行责任转回提取结构，方便和 AI 结果一起合并。 */
export function toCoverageItem(row: StoredCoverageRow): ExtractedCoverage {
  let data: {
    hospital_scope?: string;
    tiers?: { when: string; ratio: number }[];
    annual_limit?: number | null;
    waiting_days?: number | null;
    quote?: string;
    page?: number;
  } = {};
  try {
    data = JSON.parse(row.data) as typeof data;
  } catch {
    data = {};
  }

  return {
    name: row.name ?? "",
    benefitType: "reimburse",
    source: row.source === "rules" ? "rules" : "ai",
    hospitalScope: data.hospital_scope ?? "",
    tiers: data.tiers ?? [],
    annualLimit: data.annual_limit ?? null,
    annualLimitUnit: "元",
    waitingDays: data.waiting_days ?? null,
    quote: data.quote ?? "",
    page: data.page ?? 0,
    confidence: 0.7,
    reviewStatus: (data.tiers ?? []).length > 0 ? "ok" : "needs_review",
  };
}

/**
 * AI 抽到责任但没给出分级比例时，去库里已有的行（通常是附表规则解析出来的）找同名责任，把比例接过来。
 * 不这样做的话，换到 AI 链路后估算就会退化成「内置通用比例」。
 */
export function mergeCoverageWithExisting(
  items: ExtractedCoverage[],
  existing: StoredCoverageRow[],
): ExtractedCoverage[] {
  const parsed = existing.map((row) => {
    let data: { tiers?: { when: string; ratio: number }[]; hospital_scope?: string | null; annual_limit?: number | null } = {};
    try {
      data = JSON.parse(row.data) as typeof data;
    } catch {
      data = {};
    }
    return { name: normalizeValue(row.name ?? "").toLowerCase(), data };
  });

  return items.map((item) => {
    const key = normalizeValue(item.name).toLowerCase();
    const match = parsed.find((row) => row.name && (row.name === key || row.name.includes(key) || key.includes(row.name)));
    if (!match) return item;

    const tiers = item.tiers.length > 0 ? item.tiers : (match.data.tiers ?? []);
    return {
      ...item,
      tiers,
      hospitalScope: item.hospitalScope || (match.data.hospital_scope ?? ""),
      annualLimit: item.annualLimit ?? (match.data.annual_limit ?? null),
      reviewStatus: tiers.length > 0 || item.annualLimit !== null ? "ok" : "needs_review",
    };
  });
}

/** 责任表整体替换：同一份保单只留一套责任，避免 AI 行和规则行重复出现。 */
export function replaceCoverages(db: DatabaseSync, policyId: number, items: ExtractedCoverage[]): void {
  db.prepare("DELETE FROM coverage WHERE policy_id = ?").run(policyId);
  const insert = db.prepare(
    "INSERT INTO coverage (policy_id, name, benefit_type, data, citation_clause_id, confidence, review_status, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const item of items) {
    const source = item.source ?? "ai";
    insert.run(
      policyId,
      item.name,
      item.benefitType,
      JSON.stringify({
        hospital_scope: item.hospitalScope,
        tiers: item.tiers,
        annual_limit: item.annualLimit,
        annual_limit_unit: item.annualLimitUnit,
        waiting_days: item.waitingDays,
        quote: item.quote,
        page: item.page,
        source,
      }),
      null,
      item.confidence,
      item.reviewStatus,
      source,
    );
  }
}

/** 同一项责任常在「保险责任」和附表各出现一次：按名字合并，优先保留带分级比例的。 */
export function dedupeCoverages(items: ExtractedCoverage[]): ExtractedCoverage[] {
  const byName = new Map<string, ExtractedCoverage>();
  for (const item of items) {
    const key = normalizeValue(item.name).toLowerCase();
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, item);
      continue;
    }
    const score = (coverage: ExtractedCoverage) =>
      coverage.tiers.length * 2 + (coverage.annualLimit === null ? 0 : 1) + (coverage.hospitalScope ? 1 : 0);
    if (score(item) > score(existing)) byName.set(key, item);
  }
  return [...byName.values()].sort((a, b) => a.page - b.page);
}

/** 分级条件压成短语：模型常把整句原文抄进 when，界面上放不下。 */
export function shortenTierCondition(when: string): string {
  const text = when.replace(/\s/g, "");
  if (/未以基本医疗|未从基本医疗|未以社保|未从社保/.test(text)) return "未以社保身份就诊";
  if (/已从基本医疗|已从社保|从基本医疗.*补偿/.test(text)) return "已从社保报销";
  return text.length > 22 ? `${text.slice(0, 22)}…` : text;
}

/** 保单信息同样要验：值在这批页面里找不到就不采信（不猜）。 */
function readPolicy(raw: RawPolicy | undefined, pages: PageInput[], restore: (input: string) => string): PolicyMetaPatch {
  if (!raw) return {};

  const joined = normalizeForQuote(pages.map((page) => page.text).join(""));
  const pickText = (key: string, limit: number): string | null => {
    const value = restoreText(textOf(raw[key], limit), restore);
    if (!value) return null;
    const normalized = normalizeForQuote(value).slice(0, 40);
    if (normalized.length >= 3 && !joined.includes(normalized)) return null;
    return value;
  };

  const productName = pickText("product_name", 80);
  const insurer = pickText("insurer", 60);

  return {
    insurer,
    product_name: productName,
    policy_no: pickText("policy_no", 40),
    category: normalizePolicyCategory(textOf(raw.category, 30) || null, [productName ?? "", insurer ?? ""]),
    holder_name: pickText("holder_name", 30),
    insured_name: pickText("insured_name", 30),
    effective_from: normalizeDate(pickText("effective_from", 20)),
    effective_to: normalizeDate(pickText("effective_to", 20)),
    premium: numberOf(raw.premium),
    waiting_days: numberOf(raw.waiting_days),
    hesitation_days: numberOf(raw.hesitation_days),
  };
}

function mergePolicy(patches: PolicyMetaPatch[]): { meta: PolicyMetaPatch; conflicts: string[] } {
  const meta: Record<string, unknown> = {};
  const conflicts = new Set<string>();

  // 「人保寿险关爱 e 生」与「人保寿险关爱e生」是同一个名字，比较前先去掉空白和标点
  const comparable = (value: unknown): string =>
    String(value).replace(/[\s\u3000（）()【】《》·—\-，,。]/g, "").toLowerCase();

  for (const patch of patches) {
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === undefined || value === "") continue;
      const current = meta[key];
      if (current === undefined) {
        meta[key] = value;
        continue;
      }
      if (comparable(current) !== comparable(value)) conflicts.add(key);
    }
  }

  return { meta: meta as PolicyMetaPatch, conflicts: [...conflicts] };
}

/** 整篇脱敏一次，保证同一实体在各批次里占位符一致。 */
export function redactPages(pages: PageInput[]): {
  pages: PageInput[];
  entries: RedactionEntry[];
  restore: (value: string) => string;
  leaks: number;
} {
  const joined = pages.map((page) => `[[P:${page.page_no}]]\n${page.text}`).join("\n");
  const redaction = redactDocument(joined);
  const parts = redaction.text.split(PAGE_MARK);
  const redacted: PageInput[] = [];

  // split 结果是 [前言, 页码, 正文, 页码, 正文, ...]
  for (let i = 1; i + 1 < parts.length; i += 2) {
    redacted.push({ page_no: Number(parts[i]), text: parts[i + 1] ?? "" });
  }

  const leaks = [...findLeaks(redaction.text), ...findEntityLeaks(redaction.text, redaction.entries)];
  return { pages: redacted, entries: redaction.entries, restore: redaction.restore, leaks: leaks.length };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<(R | null)[]> {
  const results: (R | null)[] = items.map(() => null);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch {
        results[index] = null;
      }
    }
  });

  await Promise.all(runners);
  return results;
}

function persist(
  db: DatabaseSync,
  documentId: number,
  policyId: number | null,
  meta: PolicyMetaPatch,
  coverages: ExtractedCoverage[],
  rows: ReturnType<typeof markConflicts>,
): void {
  db.prepare("DELETE FROM policy_element WHERE document_id = ? AND source = 'ai'").run(documentId);

  const clauseByNo = new Map<string, number>();
  for (const row of db
    .prepare("SELECT id, clause_no FROM clause WHERE document_id = ? AND clause_no IS NOT NULL")
    .all(documentId) as unknown as { id: number; clause_no: string }[]) {
    clauseByNo.set(row.clause_no, row.id);
  }

  const insertElement = db.prepare(
    "INSERT OR REPLACE INTO policy_element (document_id, policy_id, kind, category, label, value, unit, condition, quote, page_no, clause_no, clause_id, confidence, review_status, source, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai', ?)",
  );

  for (const row of rows) {
    const key = [row.kind, row.category, row.label, row.value, row.unit]
      .map((part) => normalizeValue(part).toLowerCase())
      .join("|");
    insertElement.run(
      documentId,
      policyId,
      row.kind,
      row.category,
      row.label,
      row.value,
      row.unit,
      row.condition,
      row.quote,
      row.page,
      row.clauseNo,
      row.clauseNo ? (clauseByNo.get(row.clauseNo) ?? null) : null,
      row.confidence,
      row.reviewStatus,
      key,
    );
  }

  // 责任表：附表解析出来的行（分级比例最准）保留，AI 抽到的同名责任合并进去、不同名的追加。
  // 只靠 AI 会丢掉附表里那些比例数字，只靠规则又认不出新版式。
  let finalCoverages = coverages;
  if (policyId !== null) {
    const ruleRows = readCoverageRows(db, policyId).filter((row) => row.source === "rules");
    const ruleItems = ruleRows.map(toCoverageItem);
    const mergedAi = mergeCoverageWithExisting(coverages, ruleRows);
    const extraRules = ruleItems.filter(
      (rule) => !mergedAi.some((item) => sameCoverageName(item.name, rule.name)),
    );
    finalCoverages = [...mergedAi, ...extraRules];
    if (finalCoverages.length > 0) replaceCoverages(db, policyId, finalCoverages);
  }

  if (policyId === null) return;

  const existing = db
    .prepare("SELECT data, category FROM policy WHERE id = ?")
    .get(policyId) as { data: string; category: string } | undefined;
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(existing?.data ?? "{}") as Record<string, unknown>;
  } catch {
    data = {};
  }

  for (const [key, value] of Object.entries(meta)) {
    if (value === null || value === undefined || value === "") continue;
    data[key] = value;
  }

  const limits = finalCoverages
    .map((item) => item.annualLimit)
    .filter((value): value is number => typeof value === "number" && value > 0);
  if (limits.length > 0) {
    const table = (data.benefit_table as Record<string, unknown> | undefined) ?? {};
    // 规则层已经从附表抽到年度限额时以它为准：AI 给的是各责任的小限额，不能代表整单年度上限
    const existingLimit = typeof table.annual_limit === "number" && table.annual_limit > 0 ? table.annual_limit : null;
    data.benefit_table = {
      ...table,
      // 年度限额只信附表（规则）解析出来的：各责任的保额加起来不等于整单年度上限
      annual_limit: existingLimit,
      waiting_days:
        typeof meta.waiting_days === "number"
          ? meta.waiting_days
          : ((table.waiting_days as number | null | undefined) ?? null),
      waiting_exceptions: (table.waiting_exceptions as string[] | undefined) ?? [],
    };
  }

  // 规则层抽不到的险种通常是 unknown，AI 认出来了就覆盖，其余情况保留已有值（可能是用户手工改的）
  const categoryFinal =
    meta.category && meta.category !== "unknown" && (existing?.category ?? "unknown") === "unknown"
      ? meta.category
      : null;

  db.prepare(
    "UPDATE policy SET data = ?, insurer = COALESCE(?, insurer), product_name = COALESCE(?, product_name), policy_no = COALESCE(?, policy_no), category = COALESCE(?, category) WHERE id = ?",
  ).run(
    JSON.stringify(data),
    meta.insurer ?? null,
    meta.product_name ?? null,
    meta.policy_no ?? null,
    categoryFinal,
    policyId,
  );
}

function recordRun(
  db: DatabaseSync,
  documentId: number,
  status: string,
  tokens: number,
  error?: string,
): void {
  db.prepare(
    "INSERT INTO extraction_run (document_id, stage, engine, model, prompt_version, tokens, status, error, finished_at) VALUES (?, 'ai_extract', 'deepseek', ?, ?, ?, ?, ?, datetime('now'))",
  ).run(documentId, DEEPSEEK_MODEL, PROMPT_VERSION, tokens, status, error ?? null);
}

export async function extractPolicyElements(documentId: number): Promise<ExtractSummary> {
  if (!deepseekConfigured()) {
    return { status: "skipped", batches: 0, failedBatches: 0, elements: 0, coverages: 0, rejected: 0, tokens: 0 };
  }

  const db = getDb();
  const pages = db
    .prepare("SELECT page_no, text FROM page WHERE document_id = ? ORDER BY page_no")
    .all(documentId) as unknown as PageInput[];

  if (pages.length === 0) {
    return { status: "skipped", batches: 0, failedBatches: 0, elements: 0, coverages: 0, rejected: 0, tokens: 0 };
  }

  const redacted = redactPages(pages.map((page) => ({ page_no: Number(page.page_no), text: page.text })));
  if (redacted.leaks > 0) {
    recordRun(db, documentId, "failed", 0, "redaction_blocked");
    return {
      status: "failed",
      batches: 0,
      failedBatches: 0,
      elements: 0,
      coverages: 0,
      rejected: 0,
      tokens: 0,
      error: "redaction_blocked",
    };
  }

  const policies = db
    .prepare("SELECT id FROM policy WHERE document_id = ? ORDER BY id DESC LIMIT 1")
    .get(documentId) as { id: number } | undefined;
  const policyId = policies?.id ?? null;

  const batches = buildBatches(redacted.pages).slice(0, MAX_BATCHES);
  const startedAt = Date.now();
  let tokens = 0;
  let rejected = 0;

  const results = await mapWithConcurrency(batches, CONCURRENCY, async (batch) => {
    if (Date.now() - startedAt > BUDGET_MS) return null;
    const body = batch.map((page) => `[[P:${page.page_no}]]\n${page.text}`).join("\n");
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt() },
      { role: "user", content: body },
    ];
    const result = await deepseekJson(messages, { timeoutMs: 70_000 });
    tokens += result.tokens;
    return normalizeBatchResult(result.data, batch, redacted.restore);
  });

  const successful = results.filter((item): item is ExtractBundle => item !== null);
  const failedBatches = batches.length - successful.length;

  if (successful.length === 0) {
    recordRun(db, documentId, "failed", tokens, failedBatches > 0 ? "all_batches_failed" : "budget_exhausted");
    return {
      status: "failed",
      batches: batches.length,
      failedBatches,
      elements: 0,
      coverages: 0,
      rejected: 0,
      tokens,
      error: "all_batches_failed",
    };
  }

  const merged = mergePolicy(successful.map((item) => item.policy));

  // 疾病定义章节（如「9.1 重大疾病定义」）里逐病写的医学指标不是保单层面的要素，
  // 留着只会把速查卡淹掉；但医院/药品/社保范围这类定义要留。
  const definitionPages = new Set<number>();
  for (const row of db
    .prepare("SELECT heading_path, page_from, page_to FROM clause WHERE document_id = ?")
    .all(documentId) as unknown as { heading_path: string | null; page_from: number; page_to: number }[]) {
    if (!/定义/.test(row.heading_path ?? "")) continue;
    for (let page = row.page_from; page <= row.page_to; page += 1) definitionPages.add(page);
  }

  const isDefinitionNoise = (page: number, text: string) =>
    definitionPages.has(page) &&
    !/(认可的医院|指定医院|医疗机构|二级以上|普通部|药品|基本医疗保险|社保)/.test(text);

  // 费率调整、核定时限、退保退款这些是公司内部流程，不是「赔不赔、赔多少」
  const PROCESS_NOISE = /(费率调整|核定时限|拒赔通知|先予支付|退保退款|公示期|购药凭证|补充资料|给付时限|通知时限)/;

  const elements = successful
    .flatMap((item) => item.elements)
    .filter((item) => !isDefinitionNoise(item.page, `${item.label}${item.condition}${item.quote}`))
    .filter((item) => !(item.kind === "term" && PROCESS_NOISE.test(`${item.label}${item.condition}`)));
  const coverages = dedupeCoverages(
    successful
      .flatMap((item) => item.coverages)
      .filter((item) => !isDefinitionNoise(item.page, `${item.name}${item.quote}`)),
  );
  rejected =
    successful.reduce((sum, item) => sum + item.rejected, 0) +
    (successful.flatMap((item) => item.elements).length - elements.length) +
    (successful.flatMap((item) => item.coverages).length - coverages.length);

  const rows = markConflicts(dedupeElements(elements));

  // 冲突字段不算错，但要让用户看得见：记一条，不阻断入库
  persist(db, documentId, policyId, merged.meta, coverages, rows);
  recordRun(
    db,
    documentId,
    failedBatches > 0 ? "partial" : "succeeded",
    tokens,
    merged.conflicts.length > 0 ? `conflict_fields:${merged.conflicts.join(",")}` : undefined,
  );

  return {
    status: failedBatches > 0 ? "partial" : "succeeded",
    batches: batches.length,
    failedBatches,
    elements: rows.length,
    coverages: coverages.length,
    rejected,
    tokens,
  };
}

export type StoredElement = {
  id: number;
  kind: "coverage" | "exclusion" | "term";
  category: string | null;
  label: string;
  value: string;
  unit: string;
  condition: string;
  quote: string;
  page_no: number;
  clause_no: string | null;
  review_status: string;
  source: string;
};

/** 详情页三栏速查卡的数据来源：按页码排序，同类聚在一起。 */
export function loadElements(db: DatabaseSync, documentId: number): StoredElement[] {
  return (
    db
      .prepare(
        "SELECT id, kind, category, label, value, unit, condition, quote, page_no, clause_no, review_status, source FROM policy_element WHERE document_id = ? ORDER BY page_no, id",
      )
      .all(documentId) as unknown as StoredElement[]
  ).map((row) => ({ ...row }));
}

