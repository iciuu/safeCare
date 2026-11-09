/**
 * 走云 API 前的脱敏（docs/PLAN.md §8.1）。
 *
 * 原则：只抹掉「谁」，不改条款说了什么。
 * 姓名、证件号、电话、保单号、卡号、地址、邮箱一律换成占位符，
 * 病种定义、免责表述、金额比例全部原样发送——模型要靠这些判断保障范围。
 *
 * 映射表只存本地 redaction_map，不随请求发送、不写日志。
 */

export type RedactionEntry = {
  placeholder: string;
  entity_type: string;
  entity_value: string;
};

export type RedactionResult = {
  text: string;
  entries: RedactionEntry[];
  /** 占位符 -> 原文，回填模型输出用 */
  restore: (value: string) => string;
};

type LabeledRule = { type: string; prefix: string; pattern: RegExp };
type BareRule = { type: string; prefix: string; pattern: RegExp };

// 带标签的字段：占位符插在标签后面，标签本身保留，模型才知道这是谁
const LABELED: LabeledRule[] = [
  {
    type: "policy_no",
    prefix: "POLICYNO",
    pattern: /(?:保险合同号|保单号|投保单号)[：:]\s*([A-Za-z0-9]{6,})/g,
  },
  // 名字后面必须跟着空白/换行/证件字样，否则「受益人：被保险人本人」会被当成姓名误抹
  {
    type: "name",
    prefix: "NAME",
    pattern: /(?:投保人|被保险人|受益人)[：:]\s*([\u4e00-\u9fa5]{2,4})(?=\s|$|证件|身份证|户口)/g,
  },
  { type: "name", prefix: "NAME", pattern: /尊敬的客户([\u4e00-\u9fa5]{2,4})[：:]/g },
  {
    type: "address",
    prefix: "ADDR",
    pattern: /(?:联系地址|通讯地址|住址|地址)[：:]\s*([^\n]{4,60}?)(?=\s*(?:联系电话|电话|手机|邮编)|$)/g,
  },
];

// 无标签的标识符：出现在任何位置都要抹掉
const BARE: BareRule[] = [
  { type: "id_card", prefix: "ID", pattern: /\b\d{17}[\dXx]\b/g },
  { type: "phone", prefix: "PHONE", pattern: /\b1[3-9]\d{9}\b/g },
  { type: "bank_card", prefix: "BANK", pattern: /\b\d{16,19}\b/g },
  { type: "email", prefix: "EMAIL", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
];

export function placeholderOf(prefix: string, index: number): string {
  return `‹${prefix}_${index}›`;
}

export function redactDocument(raw: string): RedactionResult {
  const entries: RedactionEntry[] = [];
  const byValue = new Map<string, string>();
  const counters = new Map<string, number>();

  const placeholderFor = (type: string, prefix: string, value: string): string => {
    const key = `${type}\u0000${value}`;
    const existing = byValue.get(key);
    if (existing) return existing;

    const index = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, index);

    const placeholder = placeholderOf(prefix, index);
    byValue.set(key, placeholder);
    entries.push({ placeholder, entity_type: type, entity_value: value });
    return placeholder;
  };

  let text = raw;

  for (const rule of LABELED) {
    text = text.replace(rule.pattern, (match: string, value: string) => {
      const placeholder = placeholderFor(rule.type, rule.prefix, value);
      const at = match.indexOf(value);
      return match.slice(0, at) + placeholder + match.slice(at + value.length);
    });
  }

  for (const rule of BARE) {
    text = text.replace(rule.pattern, (match: string) => placeholderFor(rule.type, rule.prefix, match));
  }

  // 同一实体在别处再出现（比如保单号在正文里被引用）也要抹掉
  for (const entry of entries) {
    if (entry.entity_value.length < 3) continue;
    text = text.split(entry.entity_value).join(entry.placeholder);
  }

  const restore = (value: string): string => {
    let result = value;
    for (const entry of entries) {
      result = result.split(entry.placeholder).join(entry.entity_value);
    }
    return result;
  };

  return { text, entries, restore };
}

export type Leak = { type: string; length: number };

/** 出口校验：仍然命中标识符正则就阻断。样本只回报长度，绝不回显原值。 */
export function findLeaks(text: string): Leak[] {
  const leaks: Leak[] = [];
  let masked = text;

  // 命中后就地抹成星号，避免 18 位身份证再被 16–19 位卡号正则报一遍
  for (const rule of BARE) {
    masked = masked.replace(rule.pattern, (match: string) => {
      leaks.push({ type: rule.type, length: match.length });
      return "*".repeat(match.length);
    });
  }

  return leaks;
}

/** 已知实体值（姓名/地址等）有没有漏网。 */
export function findEntityLeaks(text: string, entries: RedactionEntry[]): Leak[] {
  return entries
    .filter((entry) => entry.entity_value.length >= 3 && text.includes(entry.entity_value))
    .map((entry) => ({ type: entry.entity_type, length: entry.entity_value.length }));
}
