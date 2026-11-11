import Link from "next/link";
import { notFound } from "next/navigation";
import { DocumentViewer } from "@/components/document-viewer";
import { ExtractStatus } from "@/components/extract-status";
import { resolveElementAction } from "@/app/policy-actions";
import { readExtractProgress } from "@/lib/ai/extract";
import { getDb } from "@/lib/db";
import { extractionRunning } from "@/lib/extract-job";
import {
  AMOUNT_CATEGORIES,
  CONDITION_CATEGORIES,
  ELEMENT_KIND_LABELS,
  categoryLabel,
  exclusionGroupOf,
  groupExclusions,
  type ElementKind,
} from "@/lib/elements";
import type { PolicyMeta } from "@/lib/policy-meta";

export const dynamic = "force-dynamic";

type DocumentRow = {
  id: number;
  filename: string;
  page_count: number;
  char_count: number;
  byte_size: number;
  has_text_layer: number;
  clause_count: number;
  clause_coverage: number;
  toc_expected: number;
  toc_matched: number;
  created_at: string;
};

type BenefitView = {
  id: number;
  name: string;
  hospital_scope: string | null;
  tiers: { when: string; ratio: number }[];
};

type StoredPolicy = PolicyMeta & {
  benefit_table?: {
    annual_limit: number | null;
    renewal_limit: number | null;
    waiting_days: number | null;
    waiting_exceptions: string | null;
  };
};

type AiFactView = {
  type: string;
  label: string;
  value: string;
  unit: string;
  condition: string;
  quote: string;
};

type AiRow = {
  clause_id: number;
  clause_no: string | null;
  page_from: number;
  kind: string | null;
  summary: string | null;
  data: string;
  review_status: string;
};

type ClauseRow = {
  id: number;
  clause_no: string;
  heading_path: string;
  category: string;
  page_from: number;
  page_to: number;
};

const POLICY_LABEL: Record<string, string> = {
  medical: "医疗险",
  critical_illness: "重疾险",
  accident: "意外险",
  life: "寿险",
  unknown: "未识别",
};

const AI_KIND_LABEL: Record<string, string> = {
  coverage: "保险责任",
  exclusion: "责任免除",
  limit: "金额/限额",
  waiting_period: "等待期",
  renewal: "续保",
  definition: "定义",
  premium: "保险费",
  termination: "解除/退保",
  claims: "理赔",
  other: "其他",
};

const ELEMENT_FILTERS: { label: string; kind: ElementKind | null }[] = [
  { label: "全部", kind: null },
  { label: "责任", kind: "coverage" },
  { label: "免责", kind: "exclusion" },
  { label: "金额与期间", kind: "term" },
];

const CATEGORY_LABEL: Record<string, string> = {
  coverage: "保险责任",
  exclusion: "责任免除",
  waiting_period: "等待期",
  limit: "金额/限额",
  renewal: "续保",
  definition: "定义",
  premium: "保险费",
  termination: "解除/退保",
  claims: "理赔",
  other: "其他",
};

type QuickItem = {
  label: string;
  value: string;
  unit: string;
  condition: string;
  quote: string;
  page: number;
};

function QuickColumn({
  id,
  title,
  hint,
  items,
  empty,
}: {
  id: number;
  title: string;
  hint: string;
  items: QuickItem[];
  empty: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <p className="text-xs font-medium text-slate-800">{title}</p>
      <p className="mt-0.5 text-xs text-slate-400">{hint}</p>
      {items.length === 0 ? (
        <p className="mt-2 text-xs text-slate-400">{empty}</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {items.map((item, index) => (
            <li key={`${item.label}-${index}`} className="text-xs leading-5 text-slate-700">
              <span>{item.label}</span>{" "}
              <span className="font-medium text-slate-900">
                {item.value}
                {item.unit ? ` ${item.unit}` : ""}
              </span>
              {item.condition ? <span className="ml-1 text-slate-500">{item.condition}</span> : null}
              <a
                href={`/documents/${id}?p=${item.page}&q=${encodeURIComponent(item.quote.slice(0, 60))}#doc`}
                className="ml-1 text-sky-700 underline decoration-dotted underline-offset-2"
              >
                P{item.page}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default async function DocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ p?: string; q?: string; kind?: string; eq?: string; reviewed?: string }>;
}) {
  const { id } = await params;
  const { p: pageParam, q: quoteParam, kind: kindParam, eq: eqParam, reviewed } = await searchParams;
  const focusPage = Number(pageParam);
  const documentId = Number(id);
  if (!Number.isInteger(documentId) || documentId <= 0) notFound();

  const db = getDb();
  const document = db
    .prepare(
      "SELECT id, filename, page_count, char_count, byte_size, has_text_layer, clause_count, clause_coverage, toc_expected, toc_matched, created_at FROM document WHERE id = ?",
    )
    .get(documentId) as unknown as DocumentRow | undefined;

  if (!document) notFound();

  // node:sqlite 返回的是 null 原型对象，传给客户端组件会被拒，这里映射成普通对象
  const pages = (
    db
      .prepare("SELECT page_no, char_count FROM page WHERE document_id = ? ORDER BY page_no")
      .all(documentId) as unknown as { page_no: number; char_count: number }[]
  ).map((row) => ({ page_no: Number(row.page_no), char_count: Number(row.char_count) }));

  const clauses = (
    db
      .prepare(
        "SELECT id, clause_no, heading_path, category, page_from, page_to FROM clause WHERE document_id = ? ORDER BY seq",
      )
      .all(documentId) as unknown as ClauseRow[]
  ).map((row) => ({ ...row }));

  const policyRow = db
    .prepare("SELECT id, data FROM policy WHERE document_id = ? ORDER BY id DESC LIMIT 1")
    .get(documentId) as { id: number; data: string } | undefined;

  let policy: StoredPolicy | null = null;
  if (policyRow) {
    try {
      policy = JSON.parse(policyRow.data) as StoredPolicy;
    } catch {
      policy = null;
    }
  }

  // 最近一次 AI 抽取的版本与花费：改了提示词后跑一遍就能看出差别
  const lastRun = db
    .prepare(
      "SELECT engine, model, prompt_version, tokens, status, started_at, finished_at FROM extraction_run WHERE document_id = ? AND stage IN ('ai_extract', 'ai_enrich') ORDER BY id DESC LIMIT 1",
    )
    .get(documentId) as
    | {
        engine: string | null;
        model: string | null;
        prompt_version: string | null;
        tokens: number | null;
        status: string;
        started_at: string;
        finished_at: string | null;
      }
    | undefined;

  const benefits: BenefitView[] = policyRow
    ? (
        db
          .prepare(
            "SELECT id, name, data FROM coverage WHERE policy_id = ? ORDER BY CASE WHEN source = 'ai' THEN 0 ELSE 1 END, id",
          )
          .all(policyRow.id) as unknown as { id: number; name: string | null; data: string }[]
      ).map((row) => {
        let parsed: { hospital_scope?: string | null; tiers?: { when: string; ratio: number }[] } = {};
        try {
          parsed = JSON.parse(row.data) as typeof parsed;
        } catch {
          parsed = {};
        }
        return {
          id: row.id,
          name: row.name ?? "未命名责任",
          hospital_scope: parsed.hospital_scope ?? null,
          tiers: parsed.tiers ?? [],
        };
      })
    : [];

  const aiRows = (
    db
      .prepare(
        "SELECT c.id AS clause_id, c.clause_no, c.page_from, a.kind, a.summary, a.data, a.review_status FROM clause_ai a JOIN clause c ON c.id = a.clause_id WHERE c.document_id = ? ORDER BY c.seq",
      )
      .all(documentId) as unknown as AiRow[]
  ).map((row) => {
    let facts: AiFactView[] = [];
    try {
      const parsed = JSON.parse(row.data) as { facts?: AiFactView[] };
      facts = Array.isArray(parsed.facts) ? parsed.facts : [];
    } catch {
      facts = [];
    }
    return { ...row, facts };
  });

  // AI 判定优先，本地分类只在模型没给结果时兜底
  const aiKindById = new Map(aiRows.map((row) => [row.clause_id, row.kind]));

  const flatFacts = aiRows.flatMap((row) =>
    row.facts.map((fact) => ({
      ...fact,
      page: row.page_from,
      kind: row.kind ?? "other",
    })),
  );

  // 新链路：AI 抽要素、本地归类后落在 policy_element，三种险种共用同一套读法
  const elementRows = (
    db
      .prepare(
        "SELECT id, kind, category, label, value, unit, condition, quote, page_no, clause_no, review_status FROM policy_element WHERE document_id = ? ORDER BY page_no, id",
      )
      .all(documentId) as unknown as {
      id: number;
      kind: ElementKind;
      category: string | null;
      label: string;
      value: string;
      unit: string;
      condition: string;
      quote: string;
      page_no: number;
      clause_no: string | null;
      review_status: string;
    }[]
  ).map((row) => ({ ...row }));

  // 被人工忽略的要素不再参与速查卡、列表和计数（终态是 ignored，不是删除，重跑 AI 也不会丢）
  const visibleElements = elementRows.filter((row) => row.review_status !== "ignored");
  const useElements = visibleElements.length > 0;

  // 免责条目在保单里是并列列表，带上网关类别只是为了归组展示，不改变任何判断
  const exclusionItems: (QuickItem & { category: string | null; clauseNo: string | null })[] = useElements
    ? visibleElements
        .filter((row) => row.kind === "exclusion")
        .map((row) => ({
          label: row.label || "免责情形",
          value: row.value,
          unit: row.unit,
          condition: row.condition,
          quote: row.quote,
          page: row.page_no,
          category: row.category ?? null,
          clauseNo: row.clause_no ?? null,
        }))
    : flatFacts
        .filter((fact) => fact.kind === "exclusion")
        .map((fact) => ({
          label: fact.label || "免责情形",
          value: fact.value,
          unit: fact.unit,
          condition: fact.condition,
          quote: fact.quote,
          page: fact.page,
          category: fact.type ?? null,
          clauseNo: null,
        }));

  const exclusionFacts: QuickItem[] = exclusionItems;
  const exclusionGroups = groupExclusions(exclusionItems);
  // 老数据的 category 可能是旧词表，展示时统一按新归类走
  const exclusionGroupLabel = new Map<number, string>(
    visibleElements
      .filter((row) => row.kind === "exclusion")
      .map((row) => [row.id, exclusionGroupOf(row).label] as const),
  );

  const amountFacts: QuickItem[] = (
    useElements
      ? visibleElements
          .filter((row) => row.kind === "term" && AMOUNT_CATEGORIES.has(row.category ?? ""))
          .map((row) => ({
            label: row.label || "金额",
            value: row.value,
            unit: row.unit,
            condition: row.condition,
            quote: row.quote,
            page: row.page_no,
          }))
      : flatFacts
          .filter((fact) => fact.kind !== "exclusion" && ["limit", "ratio", "deductible"].includes(fact.type))
          .map((fact) => ({
            label: fact.label || "金额",
            value: fact.value,
            unit: fact.unit,
            condition: fact.condition,
            quote: fact.quote,
            page: fact.page,
          }))
  );

  const conditionFacts: QuickItem[] = useElements
    ? visibleElements
        .filter((row) => row.kind === "term" && CONDITION_CATEGORIES.has(row.category ?? ""))
        .map((row) => ({
          label: row.label || "条件",
          value: row.value,
          unit: row.unit,
          condition: row.condition,
          quote: row.quote,
          page: row.page_no,
        }))
    : flatFacts
        .filter(
          (fact) =>
            fact.kind !== "exclusion" && ["waiting_period", "period", "scope"].includes(fact.type),
        )
        .map((fact) => ({
          label: fact.label || "条件",
          value: fact.value,
          unit: fact.unit,
          condition: fact.condition,
          quote: fact.quote,
          page: fact.page,
        }));

  const pendingElements = visibleElements.filter((row) => row.review_status === "needs_review");

  // 要素检索：险种大类 + 关键词，只影响列表，不影响速查卡
  const activeKind = ELEMENT_FILTERS.some((filter) => filter.kind && filter.kind === kindParam)
    ? (kindParam as ElementKind)
    : null;
  const eqQuery = (eqParam ?? "").trim();
  const filteredElements = visibleElements.filter((row) => {
    if (activeKind && row.kind !== activeKind) return false;
    if (!eqQuery) return true;
    const haystack = `${row.label}${row.value}${row.condition}${row.quote}`.toLowerCase();
    return haystack.includes(eqQuery.toLowerCase());
  });
  const pending = aiRows.filter((row) => row.review_status !== "ok" || row.facts.length === 0);
  const aiConfigured = Boolean(process.env.DEEPSEEK_API_KEY);

  const policyFacts: { label: string; value: string | null }[] = policy
    ? [
        { label: "保险公司", value: policy.insurer },
        { label: "产品", value: policy.product_name },
        { label: "保单号", value: policy.policy_no },
        { label: "被保险人", value: policy.insured_name },
        {
          label: "保险期间",
          value:
            policy.effective_from && policy.effective_to
              ? `${policy.effective_from} → ${policy.effective_to}`
              : (policy.effective_from ?? policy.effective_to),
        },
        {
          label: "保险费",
          value: policy.premium === null ? null : `${policy.premium.toLocaleString("zh-CN")} 元`,
        },
        {
          label: "等待期",
          // 0 天就是没有等待期，写成「0 日」容易让人以为还要等
          value: policy.waiting_days === null ? null : policy.waiting_days === 0 ? "无" : `${policy.waiting_days} 日`,
        },
        {
          label: "犹豫期",
          value: policy.hesitation_days === null ? null : `${policy.hesitation_days} 日`,
        },
        { label: "险种", value: POLICY_LABEL[policy.category] ?? policy.category },
      ]
    : [];

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <Link href="/" className="text-xs text-slate-500 hover:text-slate-900">
        ← 返回保单管理
      </Link>

      <header className="mt-4 mb-6">
        {/* 上传的文件名常是「17.pdf」这种，正式名称以保单上的产品名为准 */}
        <h1 className="truncate text-lg font-semibold tracking-tight">
          {policy?.product_name ?? document.filename}
        </h1>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
          {policy?.insurer ? <span>{policy.insurer}</span> : null}
          {policy?.policy_no ? <span>保单号 {policy.policy_no}</span> : null}
          <span className="max-w-full truncate">文件 {document.filename}</span>
          <span>{document.page_count} 页</span>
          <span>{document.char_count.toLocaleString("zh-CN")} 字</span>
          <span>上传于 {document.created_at}</span>
          {document.has_text_layer ? null : (
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-700">未检测到文本层</span>
          )}
        </p>
      </header>

      {reviewed === "1" ? (
        <p className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          已处理一条待复核要素；速查卡和计数已经跟着更新。
        </p>
      ) : null}

      {policy ? (
        <section className="mb-8 rounded-xl border border-slate-200 bg-white p-4">
          <dl className="grid gap-x-8 gap-y-3 text-xs sm:grid-cols-2 lg:grid-cols-3">
            {policyFacts.map((fact) => (
              <div key={fact.label}>
                <dt className="text-slate-400">{fact.label}</dt>
                <dd className={`mt-0.5 truncate ${fact.value ? "text-slate-800" : "text-amber-600"}`}>
                  {fact.value ?? "未识别"}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      <section className="mb-8 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium text-sky-900">按你的实际情况算一笔</p>
            <p className="mt-0.5 text-xs text-sky-700">
              填费用、社保已报金额、就诊范围，按条款逐段算出预估可赔金额，每步都能点回原文。
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Link
              href={`/documents/${documentId}/estimate`}
              className="rounded-md bg-sky-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-800"
            >
              估算能赔多少 →
            </Link>
            <Link
              href={`/documents/${documentId}/claim`}
              className="rounded-md border border-sky-700 px-3 py-1.5 text-xs font-medium text-sky-800 hover:bg-sky-100"
            >
              出事了怎么报 →
            </Link>
          </div>
        </div>
      </section>

      <ExtractStatus
        documentId={documentId}
        initial={{ ...readExtractProgress(db, documentId), running: extractionRunning(documentId) }}
      />

      {flatFacts.length > 0 || elementRows.length > 0 ? (
        <section id="quick" className="mb-8">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-semibold text-slate-900">速查卡</h2>
            <p className="text-xs text-slate-500">点 P 页码跳到原文那一页并高亮引文</p>
          </div>
          <div className="grid gap-2 md:grid-cols-3">
            <QuickColumn
              id={documentId}
              title={`报不报 · 免责 ${exclusionFacts.length} 项`}
              hint={
                exclusionGroups.length > 0
                  ? `以下情形不承担给付责任 · 分 ${
                      exclusionGroups.length
                    } 类，下拉看全部`
                  : "以下情形不承担给付责任"
              }
              items={exclusionFacts.slice(0, 6)}
              empty="还没抽到免责情形"
            />
            <QuickColumn
              id={documentId}
              title={`报多少 · ${amountFacts.length} 项`}
              hint="限额、比例、免赔额"
              items={amountFacts.slice(0, 6)}
              empty="还没抽到金额类字段"
            />
            <QuickColumn
              id={documentId}
              title={`还得满足什么 · ${conditionFacts.length} 项`}
              hint="等待期、就诊范围、期间要求"
              items={conditionFacts.slice(0, 6)}
              empty="还没抽到条件类字段"
            />
          </div>
        </section>
      ) : null}

      {exclusionGroups.length > 0 ? (
        <section id="exclusions" className="mb-8">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-sm font-semibold text-slate-900">免责条款 · 按类看</h2>
            <p className="text-xs text-slate-500">
              {exclusionItems.length} 条 · {exclusionGroups.length} 类 · 归类只为本机好找，不改条款原文
            </p>
          </div>
          <div className="space-y-2">
            {exclusionGroups.map((group, index) => (
              <details
                key={group.id}
                open={index === 0}
                className="overflow-hidden rounded-xl border border-slate-200 bg-white"
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-2.5 text-xs hover:bg-slate-50">
                  <span className="font-medium text-slate-900">{group.label}</span>
                  <span className="shrink-0 tabular-nums text-slate-400">
                    {group.items.length} 条 ▾
                  </span>
                </summary>
                <ul className="divide-y divide-slate-100 border-t border-slate-100">
                  {group.items.map((item, itemIndex) => (
                    <li key={`${item.label}-${item.page}-${itemIndex}`} className="px-4 py-2 text-xs">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                        <p className="min-w-0 flex-1 text-slate-800">
                          {item.value || item.label}
                          {item.condition ? (
                            <span className="ml-1 text-slate-500">{item.condition}</span>
                          ) : null}
                        </p>
                        <a
                          href={`/documents/${documentId}?p=${item.page}&q=${encodeURIComponent(item.quote.slice(0, 60))}#doc`}
                          className="shrink-0 text-sky-700 underline decoration-dotted underline-offset-2"
                        >
                          P{item.page}
                          {item.clauseNo ? ` · ${item.clauseNo}` : ""}
                        </a>
                      </div>
                      {item.quote && item.quote !== item.value ? (
                        <p className="mt-0.5 line-clamp-2 text-slate-500">「{item.quote}」</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-400">
            免责是并列的多条，这里按发生情形归堆，方便一眼看完；具体认定以条款原文和保险公司核定为准。
          </p>
        </section>
      ) : null}

      {useElements ? (
        <section id="elements" className="mb-8">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-sm font-semibold text-slate-900">全部要素（AI 抄录 · 本地归类）</h2>
            <p className="text-xs text-slate-500">
              {filteredElements.length === visibleElements.length
                ? `${visibleElements.length} 条`
                : `${filteredElements.length} / ${visibleElements.length} 条`} · 每条都带页码和原文引文
            </p>
          </div>

          <form action={`/documents/${documentId}`} className="mb-3 flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-1">
              {ELEMENT_FILTERS.map((filter) => {
                const active = activeKind === filter.kind;
                const params = new URLSearchParams();
                if (filter.kind) params.set("kind", filter.kind);
                if (eqQuery) params.set("eq", eqQuery);
                const query = params.toString();
                return (
                  <Link
                    key={filter.label}
                    href={`/documents/${documentId}${query ? `?${query}` : ""}#elements`}
                    className={`rounded-full border px-2.5 py-1 text-xs ${
                      active
                        ? "border-slate-900 bg-slate-900 text-white"
                        : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                    }`}
                  >
                    {filter.label}
                  </Link>
                );
              })}
            </div>
            {activeKind ? <input type="hidden" name="kind" value={activeKind} /> : null}
            <input
              name="eq"
              defaultValue={eqQuery}
              placeholder="搜关键词：质子重离子、免赔额、药品…"
              className="min-w-0 flex-1 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs sm:max-w-xs"
            />
            <button type="submit" className="rounded-md bg-slate-900 px-3 py-1.5 text-xs text-white">
              搜要素
            </button>
            {activeKind || eqQuery ? (
              <Link href={`/documents/${documentId}#elements`} className="text-xs text-slate-500 hover:text-slate-900">
                清除
              </Link>
            ) : null}
          </form>

          {filteredElements.length === 0 ? (
            <p className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500">
              没有匹配的要素，换个词或去掉筛选。
            </p>
          ) : null}

          <div className="space-y-2">
            {filteredElements.map((row) => (
              <div key={row.id} className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <p className="text-xs text-slate-800">
                    <span className="mr-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-slate-500">
                      {ELEMENT_KIND_LABELS[row.kind]}
                    </span>
                    <span className="mr-1.5 text-slate-400">
                      {row.kind === "exclusion"
                        ? (exclusionGroupLabel.get(row.id) ?? categoryLabel(row.kind, row.category ?? ""))
                        : categoryLabel(row.kind, row.category ?? "")}
                    </span>
                    <span className="font-medium">{row.label || "未命名要素"}</span>
                    {row.value ? (
                      <span className="ml-1 font-medium text-slate-900">
                        {row.value}
                        {row.unit ? ` ${row.unit}` : ""}
                      </span>
                    ) : null}
                    {row.condition ? <span className="ml-1 text-slate-500">{row.condition}</span> : null}
                  </p>
                  <a
                    href={`/documents/${documentId}?p=${row.page_no}&q=${encodeURIComponent(row.quote.slice(0, 60))}#doc`}
                    className="shrink-0 text-xs text-sky-700 underline decoration-dotted underline-offset-2"
                  >
                    P{row.page_no}
                    {row.clause_no ? ` · ${row.clause_no}` : ""}
                  </a>
                </div>
                {row.quote ? (
                  <p className="mt-1 line-clamp-2 text-xs text-slate-500">「{row.quote}」</p>
                ) : null}
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-400">
            模型只负责从原文抄要素，归类、去重、冲突标记都在本机做；引文反查不过的一条都没留。
          </p>
          {lastRun ? (
            <p className="mt-1 text-xs text-slate-400">
              上次抽取 {lastRun.engine ?? "deepseek"} / {lastRun.model ?? "—"} · 提示词{" "}
              {lastRun.prompt_version ?? "未记录"} · {lastRun.tokens ? `${lastRun.tokens.toLocaleString("zh-CN")} token` : "token 未记录"}{" "}
              · {lastRun.status === "succeeded" || lastRun.status === "ok" ? "成功" : lastRun.status} ·{" "}
              {lastRun.finished_at ?? lastRun.started_at}
            </p>
          ) : null}
        </section>
      ) : null}

      {!useElements && aiRows.length > 0 ? (
        <section className="mb-8">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-semibold text-slate-900">保障要点（AI 抽取）</h2>
            <p className="text-xs text-slate-500">以此为准 · 每条要点都能反查回原文</p>
          </div>
          <div className="space-y-2">
            {aiRows.map((row) => (
              <div
                key={`${row.clause_no}-${row.page_from}`}
                className="rounded-xl border border-slate-200 bg-white px-4 py-3"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-xs font-medium text-slate-800">
                    <span className="tabular-nums text-slate-500">{row.clause_no}</span>{" "}
                    {row.summary || AI_KIND_LABEL[row.kind ?? "other"] || "条款"}
                  </p>
                  <span className="shrink-0 text-xs text-slate-400">
                    P{row.page_from}
                    {row.review_status === "needs_review" ? " · 待复核" : ""}
                  </span>
                </div>
                {row.facts.length > 0 ? (
                  <ul className="mt-2 space-y-1.5">
                    {row.facts.map((fact, index) => (
                      <li key={`${fact.label}-${index}`} className="text-xs">
                        <span className="text-slate-400">{fact.label}</span>{" "}
                        <span className="font-medium text-slate-800">
                          {fact.value}
                          {fact.unit ? ` ${fact.unit}` : ""}
                        </span>
                        {fact.condition ? (
                          <span className="ml-1 rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">
                            {fact.condition}
                          </span>
                        ) : null}
                        {fact.quote ? (
                          <p className="mt-0.5 line-clamp-2 text-slate-500">「{fact.quote}」</p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1.5 text-xs text-amber-600">这条没抽出可校验的要点</p>
                )}
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-400">
            本次只上传了条款编号、标题与已脱敏的条款正文；姓名、证件号、电话、保单号、地址留在本机。
          </p>
        </section>
      ) : aiConfigured ? (
        <p className="mb-8 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-700">
          AI 要素抽取没有跑成功，本地规则结果不受影响。
        </p>
      ) : (
        <p className="mb-8 rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500">
          未配置 DEEPSEEK_API_KEY，当前只用本地规则抽取。
        </p>
      )}

      {benefits.length > 0 || policy?.benefit_table?.annual_limit ? (
        <section className="mb-8">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-semibold text-slate-900">保障表 · 责任与给付比例</h2>
            <p className="text-right text-xs text-slate-500">
              {policy?.benefit_table?.annual_limit
                ? `年度限额 ${(policy.benefit_table.annual_limit / 10000).toLocaleString("zh-CN")} 万元`
                : ""}
              {policy?.benefit_table?.renewal_limit
                ? ` · 保证续保期内 ${(policy.benefit_table.renewal_limit / 10000).toLocaleString("zh-CN")} 万元`
                : ""}
            </p>
          </div>
          <p className="mb-2 text-xs text-slate-400">AI 认出的责任排在前面；本地规则切到的附表条目随后，数字与条件以条款原文为准。</p>
          <div className="space-y-2">
            {benefits.length === 0 ? (
              <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-700">
                附表里没切出责任条目，先看上面的给付限额。
              </p>
            ) : null}
            {benefits.map((item) => (
              <div key={item.id} className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-xs font-medium text-slate-800">{item.name}</p>
                  <p className="shrink-0 text-xs text-slate-500">
                    {item.hospital_scope ?? "范围未识别"}
                  </p>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {item.tiers.length === 0 ? (
                    <span className="rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-700">
                      未识别给付比例
                    </span>
                  ) : (
                    item.tiers.map((tier, index) => (
                      <span
                        key={`${tier.when}-${index}`}
                        className="rounded bg-emerald-50 px-2 py-0.5 text-xs text-emerald-800"
                      >
                        {tier.when} {Math.round(tier.ratio * 100)}%
                      </span>
                    ))
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {useElements && pendingElements.length > 0 ? (
        <section id="review" className="mb-8 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <h2 className="text-sm font-semibold text-amber-800">待复核 · {pendingElements.length} 条</h2>
          <p className="mt-0.5 text-xs text-amber-700">
            同一条事实在保单里前后给了不同值（或模型没给全），没有替它选。对照下面的原文引文确认、改对，或者直接忽略这条。
          </p>
          <ul className="mt-3 space-y-2">
            {pendingElements.map((row) => (
              <li key={row.id} className="rounded-lg border border-amber-200 bg-white px-3 py-2">
                <form action={resolveElementAction} className="space-y-2">
                  <input type="hidden" name="documentId" value={documentId} />
                  <input type="hidden" name="elementId" value={row.id} />
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs">
                    <span className="text-amber-900">
                      {ELEMENT_KIND_LABELS[row.kind]} · P{row.page_no}
                      {row.clause_no ? ` · ${row.clause_no}` : ""}
                    </span>
                    <a
                      href={`/documents/${documentId}?p=${row.page_no}&q=${encodeURIComponent(row.quote.slice(0, 60))}#doc`}
                      className="text-sky-700 underline decoration-dotted underline-offset-2"
                    >
                      看原文
                    </a>
                  </div>
                  {row.quote ? (
                    <p className="line-clamp-2 text-xs text-slate-500">「{row.quote}」</p>
                  ) : null}
                  <div className="flex flex-wrap gap-1.5">
                    <label className="flex items-center gap-1 text-xs text-slate-500">
                      标签
                      <input
                        name="label"
                        defaultValue={row.label}
                        className="w-28 rounded border border-slate-200 px-2 py-1 text-xs text-slate-900"
                      />
                    </label>
                    <label className="flex items-center gap-1 text-xs text-slate-500">
                      值
                      <input
                        name="value"
                        defaultValue={row.value}
                        className="w-32 rounded border border-slate-200 px-2 py-1 text-xs text-slate-900"
                      />
                    </label>
                    <label className="flex items-center gap-1 text-xs text-slate-500">
                      单位
                      <input
                        name="unit"
                        defaultValue={row.unit}
                        className="w-16 rounded border border-slate-200 px-2 py-1 text-xs text-slate-900"
                      />
                    </label>
                    <label className="flex items-center gap-1 text-xs text-slate-500">
                      条件
                      <input
                        name="condition"
                        defaultValue={row.condition}
                        className="w-32 rounded border border-slate-200 px-2 py-1 text-xs text-slate-900"
                      />
                    </label>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="submit"
                      name="action"
                      value="save"
                      className="rounded bg-slate-900 px-2.5 py-1 text-xs text-white"
                    >
                      保存修正
                    </button>
                    <button
                      type="submit"
                      name="action"
                      value="confirm"
                      className="rounded border border-slate-300 px-2.5 py-1 text-xs text-slate-700"
                    >
                      原样确认
                    </button>
                    <button
                      type="submit"
                      name="action"
                      value="ignore"
                      className="rounded px-2.5 py-1 text-xs text-slate-500 hover:text-slate-900"
                    >
                      忽略这条
                    </button>
                  </div>
                </form>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {!useElements && pending.length > 0 ? (
        <section className="mb-8 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <h2 className="text-sm font-semibold text-amber-800">待复核 · {pending.length} 条</h2>
          <p className="mt-0.5 text-xs text-amber-700">
            这些条款没抽出可校验的要点（多为章节引言或纯表格），不会被拿来下结论。
          </p>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {pending.map((row) => (
              <li key={row.clause_id} className="rounded bg-white/70 px-2 py-0.5 text-xs text-amber-900">
                {row.clause_no} · P{row.page_from}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {clauses.length > 0 ? (
        <section className="mb-8">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-slate-900">条款结构</h2>
            <p className="text-xs text-slate-500">
              {document.clause_count} 条 · 覆盖 {Math.round(document.clause_coverage * 100)}%
              {document.toc_expected > 0
                ? ` · 目录 ${document.toc_matched}/${document.toc_expected}`
                : ""}
            </p>
          </div>
          <ul className="max-h-72 divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-200 bg-white">
            {clauses.map((clause) => {
              const aiKind = aiKindById.get(clause.id);
              const category = aiKind ?? clause.category;
              return (
                <li key={clause.id} className="flex items-center gap-3 px-4 py-2 text-xs">
                  <span className="w-14 shrink-0 tabular-nums text-slate-500">{clause.clause_no}</span>
                  <span className="min-w-0 flex-1 truncate text-slate-800">
                    {clause.heading_path.split(" > ").pop()}
                  </span>
                  <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">
                    {CATEGORY_LABEL[category] ?? category}
                  </span>
                  {aiKind ? (
                    <span className="shrink-0 rounded bg-sky-50 px-1 py-0.5 text-sky-700">AI</span>
                  ) : null}
                  <a
                    href={`/documents/${documentId}?p=${clause.page_from}#doc`}
                    className="w-14 shrink-0 text-right text-sky-700 underline decoration-dotted underline-offset-2"
                  >
                    P{clause.page_from}
                    {clause.page_to !== clause.page_from ? `-${clause.page_to}` : ""}
                  </a>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <div id="doc">
        <DocumentViewer
          id={document.id}
          filename={document.filename}
          pageCount={document.page_count}
          pages={pages}
          focusPage={Number.isInteger(focusPage) && focusPage > 0 ? focusPage : undefined}
          highlight={quoteParam}
        />
      </div>
    </main>
  );
}
