/**
 * 分项限额：合同对「某一类费用」单独设的累计给付限额。
 *
 * 例：人保 e 生 2.0 第 2.2 条「我们对…住院期间耐用医疗设备费用的累计给付限额为 2 万元」。
 * 这种限额不会被「年度总限额」覆盖掉——总限额之外，这一项还要再压一次。
 *
 * 只认两种写法，认不出来的不猜：
 * - 「…费用的累计给付限额为 X 元/万元」
 * - 「…每日限额为 X 元」（按天算的，只展示不参与一次性估算）
 */

export type SubLimitKind = "total" | "daily";

export type SubLimit = {
  label: string;
  limit: number;
  kind: SubLimitKind;
  page: number;
  clauseNo: string | null;
  quote: string;
};

export type SubLimitSource = { clause_no: string | null; page_from: number; text: string };

const TOTAL_PATTERN =
  /([\u4e00-\u9fa5A-Za-z（）()]{2,24}?费用)的?(?:累计)?(?:给付)?限额(?:为|是)?(\d+(?:\.\d+)?)(万元|元)/g;
const DAILY_PATTERN = /([\u4e00-\u9fa5（）()]{2,20}?)(?:每日|每天)(?:给付)?限额(?:为|是)?(\d+(?:\.\d+)?)(元)/g;

const LEADING_NOISE = /^(?:对|其中|我们|本公司|本公司对|本合同|若|则|并且|及)/;

function cleanLabel(raw: string): string {
  let label = raw.trim();
  // 「…保险金中的住院期间耐用医疗设备费用」：把连接词和前缀切掉
  label = label.replace(/^.*(?:中的|内的|项下的|下的)/, "");
  label = label.replace(LEADING_NOISE, "");
  return label.trim();
}

function toAmount(value: string, unit: string): number {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 0;
  return unit === "万元" ? Math.round(amount * 10_000) : amount;
}

function quoteAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 40);
  return text.slice(start, end).replace(/\s+/g, "");
}

export function extractSubLimits(clauses: SubLimitSource[]): SubLimit[] {
  const found: SubLimit[] = [];
  const seen = new Set<string>();

  for (const clause of clauses) {
    const text = (clause.text ?? "").replace(/\s+/g, "");
    if (!/限额/.test(text)) continue;

    for (const match of text.matchAll(TOTAL_PATTERN)) {
      const label = cleanLabel(match[1] ?? "");
      const limit = toAmount(match[2] ?? "", match[3] ?? "元");
      // 「医疗费用限额」这种一句话覆盖全部费用的写法不是分项限额，跳过
      if (!label || /^医疗费用$|^各项费用$|^保险金$/.test(label)) continue;
      if (limit < 100) continue;
      const key = `${label}|${limit}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({
        label,
        limit,
        kind: "total",
        page: clause.page_from,
        clauseNo: clause.clause_no,
        quote: quoteAround(text, match.index ?? 0, match[0].length),
      });
    }

    for (const match of text.matchAll(DAILY_PATTERN)) {
      const label = cleanLabel(match[1] ?? "");
      const limit = toAmount(match[2] ?? "", "元");
      if (!label || limit < 10) continue;
      const key = `${label}|${limit}|daily`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({
        label,
        limit,
        kind: "daily",
        page: clause.page_from,
        clauseNo: clause.clause_no,
        quote: quoteAround(text, match.index ?? 0, match[0].length),
      });
    }
  }

  // 同一类别只留最严的那条限额（合同里常有总限额 + 子项各自限额的重复表述）
  const strictest = new Map<string, SubLimit>();
  for (const item of found) {
    const current = strictest.get(item.label);
    if (!current || item.limit < current.limit) strictest.set(item.label, item);
  }

  return [...strictest.values()].sort((a, b) => a.limit - b.limit);
}
