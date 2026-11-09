import type { PageText } from "./segmentation";
import { cleanLine, isPageFurniture } from "./segmentation";

/**
 * 「附表 N：…保障表」解析。
 *
 * 真实文档里这张表被压平成一段连续文字，列边界全丢：
 *   「一般医疗保险金 我们认可的医院的普通部 对于…不超过 5000 元的部分，给付比例为 80%…」
 *
 * 可用的结构线索有三条：
 * 1. 阅读指引用 ①②③… 列全了保险责任项目名，可直接当行锚点；
 * 2. 医院/药店范围是封闭词表（普通部、特需部、指定药店、质子重离子机构）；
 * 3. 比例永远写成百分比，且条件只有「金额区间」和「是否以社保身份就诊」两种。
 *
 * 属于保守抽取：抽不到就留空，让界面显示「未识别」，不做推测。
 */

export type BenefitTier = { when: string; ratio: number };

export type BenefitItem = {
  name: string;
  hospital_scope: string | null;
  tiers: BenefitTier[];
};

export type BenefitTableSummary = {
  annual_limit: number | null;
  renewal_limit: number | null;
  waiting_days: number | null;
  waiting_exceptions: string | null;
};

export type BenefitTable = BenefitTableSummary & {
  found: boolean;
  items: BenefitItem[];
};

const SCOPES: { pattern: string; label: string }[] = [
  { pattern: "我们认可的医院的特需部或我们指定的医院", label: "特需部/指定医院" },
  { pattern: "我们认可的医院的普通部", label: "普通部" },
  { pattern: "我们指定的质子重离子医疗机构", label: "质子重离子机构" },
  { pattern: "我们指定的药店", label: "指定药店" },
];

const NAME_HEAD = /^([\u4e00-\u9fa5（）()]{2,24}?保险金)/;
// 表格里范围列会被折行截断，只能用短词判锚点
const SCOPE_WORDS = ["普通部", "特需部", "指定医院", "指定药店", "质子重离子"];

/**
 * 定位责任名。表格里责任名会被折行截断（`重大疾病医疗` + `例为 60%` + `保险金`），
 * 整名找不到就退到能命中的最长前缀，宁可位置偏一点，也不要整条丢掉。
 */
function locate(raw: string, name: string): { index: number; length: number } | null {
  const exact = raw.indexOf(name);
  if (exact >= 0) return { index: exact, length: name.length };

  for (let len = Math.min(name.length - 1, 8); len >= 4; len -= 1) {
    const index = raw.indexOf(name.slice(0, len));
    if (index >= 0) return { index, length: len };
  }

  return null;
}

// 表格里范围列会被折行截断（「我们认可的医院的」+ 别的列 + 「普通部」），短词也要认
const SCOPE_ALIASES: { word: string; label: string }[] = [
  { word: "普通部", label: "普通部" },
  { word: "特需部", label: "特需部/指定医院" },
  { word: "指定医院", label: "特需部/指定医院" },
  { word: "指定药店", label: "指定药店" },
  { word: "质子重离子", label: "质子重离子机构" },
];

function firstScope(text: string): string | null {
  let best: { index: number; label: string } | null = null;

  for (const scope of SCOPES) {
    const index = text.indexOf(scope.pattern);
    if (index >= 0 && (!best || index < best.index)) best = { index, label: scope.label };
  }
  for (const alias of SCOPE_ALIASES) {
    const index = text.indexOf(alias.word);
    if (index >= 0 && (!best || index < best.index)) best = { index, label: alias.label };
  }

  return best?.label ?? null;
}

function lastAmount(text: string, before: number): string | null {
  const window = text.slice(Math.max(0, before - 150), before);
  const matches = [...window.matchAll(/(不超过|超过)\s*(\d+)\s*元的部分/g)];
  const last = matches[matches.length - 1];
  if (!last) return null;
  return `${last[1] === "不超过" ? "累计≤" : "累计>"}${last[2]}元`;
}

export function extractTiers(row: string): BenefitTier[] {
  const primaryScope = firstScope(row);
  const tiers: BenefitTier[] = [];
  const seen = new Set<string>();
  let previousEnd = 0;

  for (const match of row.matchAll(/(\d{1,3}(?:\.\d+)?)\s*%/g)) {
    const before = match.index ?? 0;
    const ratio = Number(match[1]) / 100;

    if (Number.isFinite(ratio) && ratio > 0 && ratio <= 2) {
      const conditions: string[] = [];

      const amount = lastAmount(row, before);
      if (amount) conditions.push(amount);

      let scopeIndex = -1;
      let scopeLabel: string | null = null;
      for (const scope of SCOPES) {
        const index = row.lastIndexOf(scope.pattern, before);
        if (index >= 0 && index > scopeIndex) {
          scopeIndex = index;
          scopeLabel = scope.label;
        }
      }
      if (scopeLabel && primaryScope && scopeLabel !== primaryScope) conditions.push(scopeLabel);

      // 社保条件只在「上一档结束之后」这一段里找，否则会把上一档的条件带过来
      const socialStart = Math.max(previousEnd, scopeIndex, before - 120);
      if (/未以(基本医疗保险|公费医疗|社保)/.test(row.slice(socialStart, before))) {
        conditions.push("未以社保身份就诊");
      }

      const when = conditions.join("，") || "标准情形";
      const key = `${when}|${ratio}`;
      if (!seen.has(key)) {
        seen.add(key);
        tiers.push({ when, ratio });
      }
    }

    previousEnd = before + match[0].length;
  }

  return tiers;
}

/** 从阅读指引的 ①②③… 清单里拿项目名。 */
function harvestNamesFromGuide(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(/([①-⑳])([^①-⑳]{1,60})/g)) {
    const name = match[2].match(NAME_HEAD)?.[1];
    if (name) names.push(name);
  }
  return [...new Set(names)];
}

/** 没有清单时退化：在表格里找「…保险金」+ 紧随范围/百分比的位置。 */
function harvestNamesFromTable(block: string): string[] {
  const names: string[] = [];
  for (const match of block.matchAll(
    /([\u4e00-\u9fa5（）()]{2,20}?保险金)(?=我们认可|我们指定|\d{1,3}%)/g,
  )) {
    names.push(match[1]);
  }
  return [...new Set(names)];
}

function findBlock(lines: string[]): { start: number; end: number } | null {
  const start = lines.findIndex((line) => /保障表$/.test(line) && !/详见/.test(line));
  if (start < 0) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    // 前面的「附表 1」标题行不能当成结束标记
    if (i > start + 3 && /^(附表\s*\d|理赔服务指引)/.test(lines[i])) {
      end = i;
      break;
    }
  }

  return { start, end };
}

/**
 * 同一比例被相邻行重复扫到时，只保留条件更具体的那一条：
 * 「标准情形 100%」与「累计>5000元 100%」并存时，前者是后者的截断尾巴。
 */
function dedupeTiers(tiers: BenefitTier[]): BenefitTier[] {
  return tiers.filter((tier) => {
    const when = tier.when.replace(/\s/g, "");
    // 只有「金额条件」那一档才可能是同一行更完整的说法
    if (when !== "标准情形" && when !== "未以社保身份就诊") return true;

    const sameRatio = tiers.some(
      (other) => other !== tier && other.ratio === tier.ratio && other.when.startsWith("累计"),
    );
    return !sameRatio;
  });
}

function parseWan(text: string, pattern: RegExp): number | null {
  const match = text.match(pattern);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? Math.round(value * 10000) : null;
}

export function extractBenefitTable(pages: PageText[]): BenefitTable {
  const lines: string[] = [];
  for (const page of pages) {
    for (const raw of page.text.split(/\r?\n/)) {
      const text = cleanLine(raw);
      if (text) lines.push(text);
    }
  }

  const empty: BenefitTable = {
    found: false,
    annual_limit: null,
    renewal_limit: null,
    waiting_days: null,
    waiting_exceptions: null,
    items: [],
  };

  const block = findBlock(lines);
  if (!block) return empty;

  // 表格跨页会夹着页眉页脚，去掉后再把整段拼成无空白字符串，列的内容才能接上
  const raw = lines
    .slice(block.start, block.end)
    .filter((line) => !isPageFurniture(line))
    .join("")
    .replace(/\s+/g, "");

  if (!/给付比例/.test(raw)) return empty;

  const guideText = lines
    .slice(0, block.start)
    .join("")
    .replace(/\s+/g, "");

  let names = harvestNamesFromGuide(guideText);
  if (names.length < 2) names = harvestNamesFromTable(raw);

  type Position = { name: string; index: number; anchored: boolean };

  // 所有能定位到的责任名都留着当行边界，哪怕它自己没通过锚点校验：
  // 责任名排在左栏，它就是下一行的起点
  const located = names
    .map((name): Position | null => {
      const found = locate(raw, name);
      if (!found) return null;

      // 锚点后面得紧接着范围或百分比，避免把「…保险金额为 2 万元」当成责任项
      const after = raw.slice(found.index + found.length, found.index + found.length + 24);
      const anchored =
        SCOPES.some((scope) => after.startsWith(scope.pattern)) ||
        SCOPE_WORDS.some((word) => after.startsWith(word)) ||
        after.includes("%");
      return { name, index: found.index, anchored };
    })
    .filter((entry): entry is Position => entry !== null)
    .sort((a, b) => a.index - b.index);

  const positions = located.filter((entry) => entry.anchored);

  const items: BenefitItem[] = positions.map((entry) => {
    const next = located.find((other) => other.index > entry.index);
    // 下一条责任名在近处就直接切在它前面；太远说明名字被折行拆散、没被定位到，
    // 那就按一行的篇幅（约 240 字）截断，免得把下一行的比例算到自己头上
    const end =
      next && next.index - entry.index <= 400
        ? next.index
        : Math.min(raw.length, entry.index + 240);
    // 责任名排在行中间：它前面那段若是纯表格文字（无句号、无别的范围词），
    // 也是本行的比例（80%/48% 就写在名字前面）；否则从名字开始，避免吃到上一行。
    const previous = [...located].reverse().find((other) => other.index < entry.index);
    const backFrom = previous ? previous.index + previous.name.length : 0;
    const rawBack = raw.slice(backFrom, entry.index);
    // 只回看到上一个句号：句号之前是别的行（如「给付限额…2 万元。」）
    const cut = rawBack.lastIndexOf("。");
    const back = rawBack.slice(cut + 1);
    const keepBack = back.length > 0 && !SCOPE_WORDS.some((word) => back.includes(word));
    const from = keepBack ? backFrom + cut + 1 : entry.index;
    const row = raw.slice(from, end);

    // 范围取名字之后的第一个范围词；名字前面的是上一行的
    return {
      name: entry.name,
      hospital_scope: firstScope(raw.slice(entry.index, end)),
      tiers: dedupeTiers(extractTiers(row)),
    };
  });

  const waiting = raw.match(/等待期\s*(\d+)\s*天/);
  const exceptions = raw.match(/等待期\s*\d+\s*天[；;]([^。]{0,30})/);

  return {
    found: items.length > 0,
    // 「400 万」后面常插着左栏的「给付限额」再跟「元」，不能要求万元连写
    annual_limit: parseWan(raw, /各项保险金累计给付总限额(\d+(?:\.\d+)?)万/),
    renewal_limit: parseWan(raw, /保证续保期间内给付总限额[:：]?(\d+(?:\.\d+)?)万元/),
    waiting_days: waiting ? Number(waiting[1]) : null,
    waiting_exceptions: exceptions?.[1]?.replace(/保险责任.*$/, "") ?? null,
    items,
  };
}
