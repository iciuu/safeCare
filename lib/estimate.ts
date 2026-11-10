/**
 * 按条款算一笔：把「实际花多少、社保报多少、在哪看、什么时候发生」套进条款规则，
 * 逐段算出预估可赔金额。
 *
 * 这里是纯算术，不调用模型、不做理赔核定：
 * - 每个比例都来自附表（`coverage` 表）或内置的同类产品规则（附表没抽出来时才用，界面会标明）；
 * - 每一步都带条款依据，能在原文里点回去核对；
 * - 拿不准的输入（如未以社保身份就诊时的目录内费用）只在提示里说明口径，不偷偷补数。
 *
 * 本产品的具体口径（附表 1）：
 *   基数 = 责任范围内费用 − 社保/公费/补充医疗已补偿 − 其他途径已补偿   （2.6 补偿原则）
 *   一般医疗：基数 ≤5000 元的部分 80%，超出部分 100%；
 *             未以社保身份就诊时，医保目录内费用改为 48% / 60%。
 *   其余责任：100%，未以社保身份就诊时目录内 60%。
 *   上限：每一保险期间累计给付不超过 400 万元（2.3）。
 */

export type ClauseRef = { clauseNo: string; page: number };

export type TierRule = {
  /** 条款里的原话，界面上直接显示，避免自己造词 */
  label: string;
  /** 金额上限；null 表示这一档没有上限 */
  upto: number | null;
  ratio: number;
  /** 未以社保身份就诊时，医保目录内费用的比例；条款没单列就为 null */
  noSocialRatio: number | null;
};

export type EstimateBenefit = {
  key: string;
  name: string;
  /** 允许的就诊范围标签，与 `benefit-table.ts` 的输出保持一致 */
  scopes: string[];
  tiers: TierRule[];
  /** 这项责任自己的保额上限（定额给付型保单没有比例，只能按保额封顶） */
  cap?: number | null;
  /** table = 从附表抽出来的；builtin = 附表没抽出来，用同产品内置规则 */
  source: "table" | "builtin";
};

export type EstimateRefs = {
  benefitTable: ClauseRef | null;
  liability: ClauseRef | null;
  limit: ClauseRef | null;
  compensation: ClauseRef | null;
  waiting: ClauseRef | null;
  exclusion: ClauseRef | null;
};

export type EstimateInput = {
  benefitKey: string;
  scope: string;
  /** 属于保险责任范围的医疗费用总额 */
  totalCost: number;
  /** 从基本医疗保险、公费医疗、政府主办补充医疗取得的补偿 */
  socialPaid: number;
  /** 从单位、其他商业保险等途径取得的补偿 */
  otherPaid: number;
  usedSocial: boolean;
  /** 未以社保身份就诊时，费用中属于医保目录内的部分；null = 按全额目录内估算 */
  catalogCost: number | null;
  inWaiting: boolean;
  /** 命中的免责情形文字；null = 未命中 */
  exclusion: string | null;
  /** 本保险期间已累计赔付 */
  paidThisYear: number;
  annualLimit: number | null;
  /**
   * 分项限额：合同对某一类费用单独设的累计限额。
   * amount 是「这次这笔费用里属于该类别的金额」，超出 limit 的部分不能计入可赔金额。
   */
  subLimits?: { label: string; limit: number; amount: number }[];
  /**
   * 给付比例表型责任（骨折、关节脱位、残疾、烧伤）：用户按条款附表查到的比例，0~1。
   * 给了就按「保额 × 比例」算；不给就只展示保额，不替用户猜比例。
   */
  flatRatio?: number | null;
};

export type EstimatePart = {
  label: string;
  portion: number;
  ratio: number;
  amount: number;
};

export type EstimateBlocker = {
  title: string;
  detail: string;
  ref: ClauseRef | null;
};

export type EstimateResult = {
  payable: number;
  base: number;
  /** 应用限额之前按比例算出的金额 */
  gross: number;
  parts: EstimatePart[];
  blockers: EstimateBlocker[];
  notes: string[];
};

const SCOPE_GENERAL = "普通部";
const SCOPE_VIP = "特需部/指定医院";
const SCOPE_PROTON = "质子重离子机构";
const SCOPE_PHARMACY = "指定药店";
const SCOPE_OTHER = "其他";

/** 界面上可选的就诊范围（顺序即下拉框顺序） */
export const SCOPE_OPTIONS: { value: string; label: string }[] = [
  { value: SCOPE_GENERAL, label: "普通部" },
  { value: SCOPE_VIP, label: "特需部 / 国际部 / 指定医院" },
  { value: SCOPE_PROTON, label: "指定质子重离子机构" },
  { value: SCOPE_PHARMACY, label: "指定药店" },
  { value: SCOPE_OTHER, label: "其他医院或机构" },
];

type BenefitSpec = {
  key: string;
  name: string;
  /** 附表里可能被折行拆散，用短词判断这条责任在不在 */
  aliases: string[];
  scopes: string[];
  defaultTiers: TierRule[];
};

const BENEFIT_SPECS: BenefitSpec[] = [
  {
    key: "general",
    name: "一般医疗保险金",
    aliases: ["一般医疗"],
    scopes: [SCOPE_GENERAL],
    defaultTiers: [
      { label: "累计≤5000元", upto: 5000, ratio: 0.8, noSocialRatio: 0.48 },
      { label: "累计>5000元", upto: null, ratio: 1, noSocialRatio: 0.6 },
    ],
  },
  {
    key: "critical",
    name: "重大疾病医疗保险金",
    aliases: ["重大疾病医疗"],
    scopes: [SCOPE_GENERAL, SCOPE_VIP],
    defaultTiers: [{ label: "标准情形", upto: null, ratio: 1, noSocialRatio: 0.6 }],
  },
  {
    key: "proton",
    name: "质子重离子医疗保险金",
    aliases: ["质子重离子"],
    scopes: [SCOPE_PROTON],
    defaultTiers: [{ label: "标准情形", upto: null, ratio: 1, noSocialRatio: 0.6 }],
  },
  {
    key: "drug",
    name: "院外恶性肿瘤特定药品费用医疗保险金",
    aliases: ["院外恶性肿瘤"],
    scopes: [SCOPE_PHARMACY],
    defaultTiers: [{ label: "标准情形", upto: null, ratio: 1, noSocialRatio: 0.6 }],
  },
  {
    key: "accident_opd",
    name: "意外门（急）诊医疗保险金",
    aliases: ["意外门"],
    scopes: [SCOPE_GENERAL],
    defaultTiers: [{ label: "标准情形", upto: null, ratio: 1, noSocialRatio: 0.6 }],
  },
];

function normalize(text: string): string {
  return text.replace(/\s+/g, "");
}

/**
 * 把附表里的 when 说明解析成可以计算的档位：
 *   「累计≤5000元」                  → 上限 5000
 *   「累计≤5000元，未以社保身份就诊」 → 同一档的社保降档比例
 *   「未以社保身份就诊」「标准情形」   → 无上限的一档
 */
export function parseTiers(tiers: { when: string; ratio: number }[]): TierRule[] {
  const rules: TierRule[] = [];
  // 模型常把「未以社保身份就诊」单独列一条、不带金额上限：按顺序挂到上一条金额档上
  let lastBand: TierRule | null = null;

  for (const tier of tiers) {
    if (!Number.isFinite(tier.ratio) || tier.ratio <= 0) continue;
    const when = normalize(tier.when ?? "");
    const social = /未以(基本医疗保险|公费医疗|社保)/.test(when);
    // 附表原话是「累计≤5000 元」，AI 抄回来的常是「余额累计不超过 5000 元的部分」，两种都要认
    const atMost = when.match(/(?:不超过|不高于|最多|以内|以下|≤|<)\s*([\d.]+)\s*元/);
    const moreThan = when.match(/(?:超过|高于|以上|≥|>)\s*([\d.]+)\s*元/);
    const boundary = atMost ?? moreThan;
    const limit = boundary ? Number(boundary[1]) : null;
    const upto = atMost ? limit : null;
    const label = boundary
      ? `${atMost ? "累计≤" : "累计>"}${boundary[1]}元`
      : "标准情形";

    if (!boundary && social && lastBand) {
      lastBand.noSocialRatio = tier.ratio;
      continue;
    }

    let rule = rules.find((item) => item.upto === upto && item.label === label);
    if (!rule) {
      rule = { label, upto, ratio: tier.ratio, noSocialRatio: null };
      rules.push(rule);
    }
    if (social) rule.noSocialRatio = tier.ratio;
    else rule.ratio = tier.ratio;
    lastBand = rule;
  }

  return rules.sort((a, b) => (a.upto ?? Number.POSITIVE_INFINITY) - (b.upto ?? Number.POSITIVE_INFINITY));
}

export type CoverageRowInput = {
  name: string | null;
  hospital_scope: string | null;
  tiers: { when: string; ratio: number }[];
  annual_limit?: number | null;
};

/** 责任清单：附表里出现的责任都列出来；比例优先用附表抽取值，抽不到才退到内置规则。 */
/** 责任写的是哪类就诊范围，映射到估算页的下拉选项。 */
export function scopeOf(name: string, hospitalScope: string | null): string[] {
  const text = `${name} ${hospitalScope ?? ""}`;
  if (/质子重离子/.test(text)) return [SCOPE_PROTON];
  if (/药店|特定药品/.test(text)) return [SCOPE_PHARMACY];
  if (/特需|国际部|VIP/.test(text)) return [SCOPE_VIP, SCOPE_GENERAL];
  if (!hospitalScope) return [SCOPE_GENERAL];
  if (/指定医院|其他医院|非公立/.test(text)) return [SCOPE_OTHER, SCOPE_GENERAL];
  return [SCOPE_GENERAL];
}

/**
 * 责任清单完全从库里读：
 * 1. 有分级比例的责任（附表规则或 AI 抽的都算）直接列出来；
 * 2. 附表里提到但没抽到比例的责任，用同产品内置规则兜底；
 * 3. 两边都没提到就不显示——不替增责任。
 */
export function buildPlan(input: {
  coverage: CoverageRowInput[];
  benefitTableText: string | null;
}): { benefits: EstimateBenefit[]; notes: string[] } {
  const table = input.benefitTableText ? normalize(input.benefitTableText) : "";
  const benefits: EstimateBenefit[] = [];
  const notes: string[] = [];
  const taken = new Set<string>();

  // 先列库里有比例的责任（任何险种都适用）
  for (const row of input.coverage) {
    const name = (row.name ?? "").trim();
    if (!name) continue;
    const key = normalize(name);
    if (taken.has(key)) continue;

    const tiers = parseTiers(row.tiers);
    const usable = tiers.some((tier) => tier.ratio > 0);
    const limit = typeof row.annual_limit === "number" && row.annual_limit > 0 ? row.annual_limit : null;

    // 定额给付/一次性给付型（意外骨折、身故、伤残）没有比例可乘，只能按保额封顶
    if (!usable && limit === null) continue;

    taken.add(key);
    benefits.push({
      key: `row-${benefits.length}`,
      name,
      scopes: scopeOf(name, row.hospital_scope),
      tiers: usable ? tiers : [{ label: "按保额封顶", upto: null, ratio: 1, noSocialRatio: null }],
      cap: usable ? limit : limit,
      source: "table",
    });
  }

  if (benefits.some((item) => item.cap !== null && item.cap !== undefined)) {
    notes.push("带「按保额封顶」的责任没有可乘的给付比例：这里只算到保额上限，实际要按合同里的给付比例表核定。");
  }

  for (const spec of BENEFIT_SPECS) {
    const row = input.coverage.find((item) => {
      const name = normalize(item.name ?? "");
      if (!name) return false;
      return name === spec.name || spec.name.includes(name) || name.includes(spec.name);
    });

    // 附表提到这条责任，或者已经有抽出来的比例，才算这份保单保这一项
    const mentioned = spec.aliases.some((alias) => table.includes(alias));
    if (!row && !mentioned) continue;
    // 上面已经从库里列过同名责任了，别重复
    if (benefits.some((item) => normalize(item.name) === normalize(spec.name))) continue;

    const tiers = row ? parseTiers(row.tiers) : [];
    const usable = tiers.some((tier) => tier.ratio > 0);

    if (!usable) {
      if (!mentioned) continue;
      benefits.push({
        key: spec.key,
        name: spec.name,
        scopes: [...spec.scopes],
        tiers: spec.defaultTiers.map((tier) => ({ ...tier })),
        source: "builtin",
      });
      continue;
    }

    benefits.push({
      key: spec.key,
      name: spec.name,
      scopes: [...spec.scopes],
      tiers,
      source: "table",
    });
  }

  if (benefits.length === 0) {
    notes.push("附表里没认出保险责任项目，先在「保障表」里核对条款，再回来估算。");
  }
  if (benefits.some((item) => item.source === "builtin")) {
    notes.push("标为「内置规则」的责任比例没能从附表抽出来，用的是同产品通用比例，请对照附表 1 原文核对。");
  }

  return { benefits, notes };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function toAmount(text: string | null | undefined): number {
  if (!text) return 0;
  const value = Number(String(text).replace(/[,\s，]/g, ""));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 按档位逐段计算：每一段用这一段的额度 × 该档比例。 */
function tierParts(
  amount: number,
  tiers: TierRule[],
  useNoSocial: boolean,
  prefix: string | null,
): EstimatePart[] {
  const parts: EstimatePart[] = [];
  let lower = 0;

  for (const tier of tiers) {
    if (amount <= lower) break;
    const upper = tier.upto ?? Number.POSITIVE_INFINITY;
    const portion = Math.min(amount, upper) - lower;
    if (portion > 0) {
      const ratio = useNoSocial ? (tier.noSocialRatio ?? tier.ratio) : tier.ratio;
      parts.push({
        label: prefix ? `${prefix} · ${tier.label}` : tier.label,
        portion: round2(portion),
        ratio,
        amount: round2(portion * ratio),
      });
    }
    lower = Math.max(lower, Math.min(amount, upper));
  }

  return parts;
}

export function computeEstimate(
  input: EstimateInput,
  benefit: EstimateBenefit,
  refs: EstimateRefs,
): EstimateResult {
  const blockers: EstimateBlocker[] = [];
  const notes: string[] = [];

  if (!benefit.scopes.includes(input.scope)) {
    blockers.push({
      title: "就诊范围不在这一项责任的范围内",
      detail: `${benefit.name}只覆盖${benefit.scopes.join("、")}，当前填的是${input.scope}。`,
      ref: refs.liability ?? refs.benefitTable,
    });
  }

  if (input.inWaiting) {
    blockers.push({
      title: "发生在等待期内",
      detail: "等待期内因疾病发生的治疗，不承担给付责任；合同对等待期另有约定的，以条款为准。",
      ref: refs.waiting,
    });
  }

  if (input.exclusion) {
    blockers.push({
      title: "属于责任免除情形",
      detail: input.exclusion,
      ref: refs.exclusion,
    });
  }

  // 分项限额：超出该类限额的部分不能计入可赔金额，先剔掉再按比例算
  const subLimits = (input.subLimits ?? []).filter((item) => item.limit > 0 && item.amount > 0);
  let subExcess = 0;
  for (const item of subLimits) {
    const excess = Math.max(0, round2(item.amount - item.limit));
    if (excess <= 0) continue;
    subExcess += excess;
    notes.push(
      `这里填的「${item.label}」是 ${formatMoney(item.amount)} 元，合同对这一项单独限额 ${formatMoney(
        item.limit,
      )} 元，超出的 ${formatMoney(excess)} 元不计入可赔金额。`,
    );
  }

  const base = Math.max(0, round2(input.totalCost - input.socialPaid - input.otherPaid - subExcess));
  const parts: EstimatePart[] = [];
  let gross = 0;
  const flatRatio =
    typeof input.flatRatio === "number" && Number.isFinite(input.flatRatio)
      ? clamp(input.flatRatio > 1 ? input.flatRatio / 100 : input.flatRatio, 0, 1)
      : null;

  if (blockers.length === 0) {
    if (flatRatio !== null && typeof benefit.cap === "number" && benefit.cap > 0) {
      // 给付比例表型：这一项给的是「保额 × 比例」，不跟实际花费走
      const amount = round2(benefit.cap * flatRatio);
      parts.push({
        label: `保额 × ${Math.round(flatRatio * 100)}%`,
        portion: benefit.cap,
        ratio: flatRatio,
        amount,
      });
      gross = amount;
      notes.push(
        "这项责任按《给付比例表》的比例乘保额，比例是你对照条款附表查出来填的，这里没有替你猜。",
      );
    } else if (base <= 0) {
      notes.push("扣掉已获得的补偿后没有余额，这一笔没有可赔的金额。");
    } else {
      const hasNoSocial = benefit.tiers.some((tier) => tier.noSocialRatio !== null);

      if (input.usedSocial || !hasNoSocial) {
        parts.push(...tierParts(base, benefit.tiers, false, null));
        if (!input.usedSocial && !hasNoSocial) {
          notes.push("附表没写未以社保身份就诊时的降档比例，这里按标准比例估算，实际可能更低。");
        }
      } else {
        const catalogBase = clamp(input.catalogCost ?? base, 0, base);
        if (input.catalogCost === null) {
          notes.push("未填「其中医保目录内费用」，按全部费用属于目录内估算（偏保守）。");
        }
        if (catalogBase > 0) {
          parts.push(...tierParts(catalogBase, benefit.tiers, true, "医保目录内"));
        }
        if (base - catalogBase > 0) {
          parts.push(...tierParts(base - catalogBase, benefit.tiers, false, "医保目录外"));
        }
      }

      gross = round2(parts.reduce((sum, part) => sum + part.amount, 0));
      // 2.6 补偿原则：给付金额不得超过实际费用扣除已获补偿后的余额
      if (gross > base) {
        gross = base;
        notes.push("按 2.6 补偿原则，给付金额封顶在扣除已获补偿后的余额。");
      }
    }
  }

  let payable = gross;

  if (blockers.length === 0 && typeof benefit.cap === "number" && benefit.cap > 0 && payable > benefit.cap) {
    payable = benefit.cap;
    notes.push(`这一项责任自己的保额上限是 ${formatMoney(benefit.cap)} 元，本次按保额封顶。`);
  }

  if (blockers.length === 0 && input.annualLimit !== null) {
    const remaining = Math.max(0, round2(input.annualLimit - input.paidThisYear));
    if (payable > remaining) {
      payable = remaining;
      notes.push(
        `本保险期间累计给付限额 ${formatMoney(input.annualLimit)} 元，扣掉已赔 ${formatMoney(
          input.paidThisYear,
        )} 元后只剩 ${formatMoney(remaining)} 元，本次按剩余额度封顶。`,
      );
    }
  } else if (blockers.length === 0) {
    notes.push("没识别到每一保险期间的累计给付限额，这次估算没有做限额封顶。");
  }

  if (input.paidThisYear > 0 && input.annualLimit === null) {
    notes.push("填了本年度已赔付金额，但没有限额可扣，未参与计算。");
  }

  return {
    payable: round2(payable),
    base,
    gross,
    parts,
    blockers,
    notes,
  };
}

export function formatMoney(value: number): string {
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}
