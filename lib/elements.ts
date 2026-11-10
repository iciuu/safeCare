/**
 * 保单要素的归类与校验（纯函数，不碰网络也不碰数据库）。
 *
 * 分工：AI 只负责「把原文里的要素成段抄出来」，归到哪一类、要不要复核、
 * 同一条在两页重复出现怎么合并，全在这里用确定性代码做——
 * 这样换成任何险种、任何排版，规则都只管「同义词表」，不管版式。
 */

export type ElementKind = "coverage" | "exclusion" | "term";

export type ElementDraft = {
  kind: ElementKind;
  label: string;
  value: string;
  unit: string;
  condition: string;
  quote: string;
  page: number;
  clauseNo: string | null;
  confidence: number;
};

export type ElementRow = ElementDraft & {
  category: string;
  reviewStatus: "ok" | "needs_review";
};

type CategoryDef = { id: string; label: string; keywords: RegExp[] };

/** 归类表：命中哪个关键词就归哪一类，兜底给「其他」。顺序即优先级。 */
const COVERAGE: CategoryDef[] = [
  { id: "inpatient", label: "住院", keywords: [/住院/, /床位/, /膳食/] },
  { id: "outpatient", label: "门诊", keywords: [/门诊/, /急诊/, /门急诊/] },
  { id: "surgery", label: "手术", keywords: [/手术/, /麻醉/, /日间手术/] },
  { id: "critical_illness", label: "重疾给付", keywords: [/重大疾病/, /重疾/, /轻症/, /中症/, /特定疾病/] },
  { id: "death", label: "身故", keywords: [/身故/, /全残/] },
  { id: "disability", label: "伤残", keywords: [/伤残/, /残疾/, /意外伤害.*等级/] },
  { id: "allowance", label: "津贴", keywords: [/津贴/, /补贴/, /每日/] },
  { id: "reimbursement", label: "医疗费用报销", keywords: [/医疗费用/, /报销/, /赔付/, /保险金/] },
];

/**
 * 免责归类：顺序即优先级，越具体的越靠前（「酒后驾驶」要先算驾驶，不能落到「故意」。
 * 免责条目在保单里是并列列表，归到这里只是为了让一屏看全，不改变任何结论。
 */
const EXCLUSION: CategoryDef[] = [
  { id: "waiting", label: "等待期内出险", keywords: [/等待期/, /观察期/, /免责期/] },
  { id: "pre_existing", label: "投保前已患疾病", keywords: [/既往症/, /已有疾病/, /已患/, /投保前.*疾病/, /生效日前.*疾病/] },
  { id: "noncompliant", label: "未如实告知", keywords: [/如实告知/, /隐瞒/, /未告知/] },
  { id: "illegal", label: "故意与违法犯罪", keywords: [/故意/, /犯罪/, /违法/, /强制性措施/, /醉酒/, /酗酒/, /吸毒/, /毒品/, /自杀/, /自伤/, /斗殴/] },
  { id: "driving", label: "驾驶与交通工具", keywords: [/驾驶/, /驾驶证/, /行驶证/, /机动车/, /酒驾/, /无证/, /肇事/] },
  { id: "high_risk_sport", label: "高风险运动", keywords: [/潜水/, /攀岩/, /探险/, /跳伞/, /滑翔/, /武术/, /摔跤/, /赛马/, /特技/, /赛车/, /车辆表演/, /滑雪/, /蹦极/, /运动/, /竞技/] },
  { id: "maternity", label: "妊娠与生育", keywords: [/妊娠/, /流产/, /分娩/, /剖腹产/, /避孕/, /节育/, /绝育/, /不孕/, /人工授精/, /产前/, /产后/, /生育/] },
  { id: "cosmetic", label: "体检、美容与整形", keywords: [/体检/, /健康检查/, /疗养/, /康复/, /美容/, /整形/, /矫形/, /牙齿/, /视力/, /义齿/, /眼镜/, /变性/] },
  { id: "sexual_function", label: "性与性功能", keywords: [/性病/, /性功能/, /包皮/, /生殖功能/] },
  { id: "infection", label: "传染病与精神疾病", keywords: [/艾滋病/, /HIV/, /传染病/, /精神疾病/, /精神病/, /精神障碍/] },
  { id: "war", label: "战争、暴乱与核污染", keywords: [/战争/, /军事/, /暴乱/, /叛乱/, /恐怖/, /核爆炸/, /核辐射/, /核污染/, /化学污染/, /放射/] },
  { id: "hospital_behavior", label: "住院行为规范", keywords: [/挂床/, /拒不出院/, /入院标准/, /应当出院/] },
  { id: "hospital_scope", label: "医院与就诊范围", keywords: [/医院/, /医疗机构/, /特需/, /VIP/, /国际部/, /境外/] },
  { id: "drug_scope", label: "药品与医疗材料", keywords: [/药/, /人工/, /器械/, /材料/, /处方/, /治疗方式/] },
  { id: "experimental", label: "实验性与未获批治疗", keywords: [/试验性/, /研究性/, /未经科学/, /未获批准/, /未获得.*批准/, /基因疗法/, /细胞免疫/, /中子疗法/] },
  { id: "appraisal", label: "鉴定与手续费用", keywords: [/鉴定/, /公证/, /手续费/] },
  { id: "occupation", label: "职业限制", keywords: [/职业/, /高危/, /特种作业/] },
  { id: "preexisting_condition", label: "先天与遗传", keywords: [/先天/, /遗传/, /染色体/] },
];

const TERM: CategoryDef[] = [
  { id: "limit", label: "限额", keywords: [/限额/, /上限/, /最高/, /保额/] },
  { id: "ratio", label: "给付比例", keywords: [/比例/, /%/, /百分之/, /给付系数/] },
  { id: "deductible", label: "免赔额", keywords: [/免赔/, /起付/] },
  { id: "waiting_period", label: "等待期", keywords: [/等待期/, /观察期/, /免责期/] },
  { id: "period", label: "保障期间", keywords: [/保险期间/, /保障期间/, /期限/, /有效期/] },
  { id: "grace_period", label: "宽限期", keywords: [/宽限/, /复效/] },
  { id: "premium", label: "保费", keywords: [/保险费/, /保费/, /缴费/] },
  { id: "renewal", label: "续保", keywords: [/续保/, /保证续保/, /重新投保/] },
  { id: "age_limit", label: "年龄限制", keywords: [/周岁/, /年龄/, /投保年龄/] },
];

const TABLES: Record<ElementKind, CategoryDef[]> = {
  coverage: COVERAGE,
  exclusion: EXCLUSION,
  term: TERM,
};

const EXCLUSION_ORDER = EXCLUSION.map((def) => def.id);

/**
 * 免责归组：先按原文重新归类（老数据里存的类别可能是旧词表），
 * 认不出再用入库时的类别，最后兜底「其他免责」。
 */
export function exclusionGroupOf(row: {
  category?: string | null;
  label: string;
  value: string;
  quote: string;
}): { id: string; label: string } {
  // 免责的 label 常常就是归类名（「医院范围」「先天与遗传」），拿它归类会自己套自己，
  // 所以先看正文和引文，最后才看 label，且跳过等于某类名的 label。
  const groupLabels = new Set([...EXCLUSION.map((def) => def.label), FALLBACK.exclusion.label]);
  const haystacks = [row.value, row.quote, groupLabels.has(row.label.trim()) ? "" : row.label];
  for (const text of haystacks) {
    if (!text) continue;
    for (const def of EXCLUSION) {
      if (def.keywords.some((pattern) => pattern.test(text))) return { id: def.id, label: def.label };
    }
  }

  const stored = row.category ?? "";
  if (stored && stored !== FALLBACK.exclusion.id) {
    const def = EXCLUSION.find((item) => item.id === stored);
    if (def) return { id: def.id, label: def.label };
  }
  return { id: FALLBACK.exclusion.id, label: FALLBACK.exclusion.label };
}

export type ElementGroup<T> = { id: string; label: string; items: T[] };

/** 把免责条目按类别归组：组按归类表顺序排，组内保持原文顺序（页码靠前的在前）。 */
export function groupExclusions<
  T extends { category?: string | null; label: string; value: string; quote: string },
>(rows: T[]): ElementGroup<T>[] {
  const groups = new Map<string, ElementGroup<T>>();
  for (const row of rows) {
    const group = exclusionGroupOf(row);
    const bucket = groups.get(group.id) ?? { id: group.id, label: group.label, items: [] };
    bucket.items.push(row);
    groups.set(group.id, bucket);
  }

  const rank = (id: string) => {
    const index = EXCLUSION_ORDER.indexOf(id);
    return index === -1 ? EXCLUSION_ORDER.length : index;
  };
  return [...groups.values()].sort((a, b) => rank(a.id) - rank(b.id));
}

export const FALLBACK: Record<ElementKind, CategoryDef> = {
  coverage: { id: "other_coverage", label: "其他责任", keywords: [] },
  exclusion: { id: "other_exclusion", label: "其他免责", keywords: [] },
  term: { id: "other_term", label: "其他条件", keywords: [] },
};

export const ELEMENT_KIND_LABELS: Record<ElementKind, string> = {
  coverage: "保障责任",
  exclusion: "免责情形",
  term: "金额与期间",
};

/** 详情页三栏：金额类 vs 条件类 */
export const AMOUNT_CATEGORIES = new Set(["limit", "ratio", "deductible", "premium"]);
export const CONDITION_CATEGORIES = new Set([
  "waiting_period",
  "period",
  "grace_period",
  "renewal",
  "age_limit",
  "other_term",
]);

export function isElementKind(value: unknown): value is ElementKind {
  return value === "coverage" || value === "exclusion" || value === "term";
}

export function categoryLabel(kind: ElementKind, id: string): string {
  const found = TABLES[kind].find((item) => item.id === id);
  return found?.label ?? FALLBACK[kind].label;
}

/** 归类：标签 → 值 → 引文，逐级兜底，先命中先算。 */
export function classifyElement(element: {
  kind: ElementKind;
  label: string;
  value: string;
  quote: string;
}): { id: string; label: string } {
  const haystacks = [element.label, element.value, element.quote];
  for (const text of haystacks) {
    if (!text) continue;
    for (const def of TABLES[element.kind]) {
      if (def.keywords.some((pattern) => pattern.test(text))) {
        return { id: def.id, label: def.label };
      }
    }
  }
  return { id: FALLBACK[element.kind].id, label: FALLBACK[element.kind].label };
}

const UNIT_ALIASES: [RegExp, string][] = [
  [/^(万元|万)$/, "万元"],
  [/^(元|人民币元|块)$/, "元"],
  [/^(%|％|百分比)$/, "%"],
  [/^(日|天)$/, "天"],
  [/^(个月|月)$/, "个月"],
  [/^(年|周岁|岁)$/, "年"],
  [/^(次|次\/年|次每年)$/, "次"],
];

export function normalizeUnit(unit: string): string {
  const trimmed = unit.trim().replace(/\s/g, "");
  for (const [pattern, canonical] of UNIT_ALIASES) {
    if (pattern.test(trimmed)) return canonical;
  }
  return trimmed;
}

/** 全角转半角、去掉千分位空格——只用于比较，不用于展示。 */
export function normalizeValue(value: string): string {
  return value
    .replace(/[\uFF01-\uFF5E]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[,，\s]/g, "")
    .trim();
}

/** 金额统一换算成「元」，认不出就返回 null（不猜）。 */
export function parseAmountYuan(value: string, unit: string): number | null {
  const text = normalizeValue(value);
  const match = text.match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;

  const number = Number(match[1]);
  if (!Number.isFinite(number)) return null;

  const normalizedUnit = normalizeUnit(unit || text.replace(match[1], ""));
  if (normalizedUnit === "万元") return Math.round(number * 10_000);
  if (normalizedUnit === "元" || normalizedUnit === "") return number;
  return null;
}

export function dedupeKey(element: { kind: ElementKind; categoryId: string; label: string; value: string; unit: string }): string {
  return [
    element.kind,
    element.categoryId,
    normalizeValue(element.label).toLowerCase(),
    normalizeValue(element.value).toLowerCase(),
    normalizeUnit(element.unit),
  ].join("|");
}

/**
 * 同一条要素可能落在两页、或不同批次重复返回：按归类 + 标签 + 值去重，
 * 保留置信度高的一条（相同则保留页码靠前的，方便溯源）。
 */
export function dedupeElements(drafts: ElementDraft[]): ElementRow[] {
  const byKey = new Map<string, ElementRow>();
  const genericLabels = new Set(Object.values(FALLBACK).map((item) => item.label));

  for (const draft of drafts) {
    const category = classifyElement(draft);
    // 模型没给短标签（免责条目常常没有）时，用归类名当标签，比一串「免责情形」好认
    const label = draft.label.trim() && !genericLabels.has(draft.label.trim()) ? draft.label : category.label;
    const row: ElementRow = { ...draft, label, category: category.id, reviewStatus: "ok" };
    const key = dedupeKey({
      kind: row.kind,
      categoryId: category.id,
      label: row.label,
      value: row.value,
      unit: row.unit,
    });

    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, row);
      continue;
    }

    if (row.confidence > existing.confidence || (row.confidence === existing.confidence && row.page < existing.page)) {
      byKey.set(key, row);
    } else if (row.condition.length > existing.condition.length) {
      // 同一条事实，一页只写了结论、另一页带了条件：条件的补上
      byKey.set(key, { ...existing, condition: row.condition });
    }
  }

  return [...byKey.values()].sort((a, b) => a.page - b.page);
}

/**
 * 同一个标签挂了两个不同的值（比如两处等待期 30 天 / 90 天），
 * 说明保单里确实有分情况，不能替它选：两条都留、都标待复核。
 */
export function markConflicts(rows: ElementRow[]): ElementRow[] {
  // 免责条目本来就是并列多条（都是「违法违约」也不是冲突），不参与冲突比较
  const comparableRow = (row: ElementRow): boolean => row.kind !== "exclusion" && row.label.trim() !== "";

  const byLabel = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!comparableRow(row)) continue;
    const key = `${row.kind}|${normalizeValue(row.label)}`;
    const values = byLabel.get(key) ?? new Set<string>();
    values.add(normalizeValue(row.value));
    byLabel.set(key, values);
  }

  return rows.map((row) => {
    if (!comparableRow(row)) return row;
    const key = `${row.kind}|${normalizeValue(row.label)}`;
    const values = byLabel.get(key);
    if (!values || values.size < 2 || row.value.trim() === "") return row;
    return { ...row, reviewStatus: "needs_review" as const };
  });
}

export type PolicyMetaPatch = {
  insurer?: string | null;
  product_name?: string | null;
  policy_no?: string | null;
  category?: string | null;
  holder_name?: string | null;
  insured_name?: string | null;
  effective_from?: string | null;
  effective_to?: string | null;
  premium?: number | null;
  waiting_days?: number | null;
  hesitation_days?: number | null;
};

const POLICY_CATEGORIES = new Set(["medical", "critical_illness", "accident", "life", "unknown"]);

/** 险种只认这四个值；AI 给的说法先过一遍同义词，认不出就是 unknown。 */
export function normalizePolicyCategory(raw: string | null | undefined, hints: string[] = []): string {
  const text = [raw ?? "", ...hints].join(" ");
  if (/医疗/.test(text)) return "medical";
  if (/重疾|重大疾病/.test(text)) return "critical_illness";
  if (/意外/.test(text)) return "accident";
  if (/寿险|定期寿|终身寿|两全/.test(text)) return "life";
  if (raw && POLICY_CATEGORIES.has(raw)) return raw;
  return "unknown";
}

/** 日期统一成 YYYY-MM-DD；认不出就 null。 */
export function normalizeDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const iso = trimmed.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  const cn = trimmed.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (cn) return `${cn[1]}-${cn[2].padStart(2, "0")}-${cn[3].padStart(2, "0")}`;
  return null;
}
