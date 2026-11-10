import type { PageText } from "./segmentation";
import { cleanLine } from "./segmentation";

/**
 * 保单元信息抽取（规则版）。
 *
 * 依据真实保单首页的写法：字段是「标签：值」的短行，
 * 产品名在条款册首页，且常被换行拆成「名称」+「（费率可调）…条款」两行。
 */

export type PolicyCategory = "medical" | "critical_illness" | "accident" | "life" | "unknown";

export type PolicyMeta = {
  insurer: string | null;
  product_name: string | null;
  policy_no: string | null;
  category: PolicyCategory;
  holder_name: string | null;
  insured_name: string | null;
  effective_from: string | null;
  effective_to: string | null;
  premium: number | null;
  hesitation_days: number | null;
  waiting_days: number | null;
  source_page: number | null;
};

type Line = { page: number; text: string };

function toLines(pages: PageText[]): Line[] {
  const lines: Line[] = [];
  for (const page of pages) {
    for (const raw of page.text.split(/\r?\n/)) {
      const text = cleanLine(raw);
      if (text) lines.push({ page: page.page_no, text });
    }
  }
  return lines;
}

function isoDate(year: string, month: string, day: string): string {
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function findDate(lines: Line[], pattern: RegExp): string | null {
  for (const line of lines) {
    const match = line.text.match(pattern);
    if (match) return isoDate(match[1], match[2], match[3]);
  }
  return null;
}

function findText(lines: Line[], pattern: RegExp, group = 1): { value: string; page: number } | null {
  for (const line of lines) {
    const match = line.text.match(pattern);
    const value = match?.[group]?.trim();
    if (value) return { value, page: line.page };
  }
  return null;
}

function findNumber(lines: Line[], pattern: RegExp): number | null {
  for (const line of lines) {
    const match = line.text.match(pattern);
    if (match) {
      const value = Number(match[1].replace(/,/g, ""));
      if (Number.isFinite(value)) return value;
    }
  }
  return null;
}

/**
 * 产品名在条款册首页的标题两行：
 * `人保寿险关爱 e 生 2.0 少儿长期医疗保险` + `（费率可调）（互联网专属）请扫描以查询验证条款`。
 * 第二行只取开头的括号部分，后面那句是防伪提示。
 */
function extractProductName(lines: Line[]): string | null {
  for (let i = 0; i < lines.length - 1; i += 1) {
    const current = lines[i].text;
    if (!/保险$/.test(current) || current.length < 6) continue;
    if (/^本产品|^本条款|^条款目录|保险单$/.test(current)) continue;

    const next = lines[i + 1].text;
    const groups = next.match(/^(?:[（(][^）)]{0,20}[）)])+/);
    if (!groups) continue;

    return `${current}${groups[0]}`.trim();
  }

  return null;
}

/**
 * 险种判定顺序很重要：品牌名里常带「人保寿险」，先判医疗/重疾/意外，最后才判寿险。
 */
function inferCategory(names: Array<string | null>): PolicyCategory {
  const text = names.filter((name): name is string => Boolean(name)).join(" ");
  if (/医疗/.test(text)) return "medical";
  if (/重大疾病|重疾/.test(text)) return "critical_illness";
  if (/意外/.test(text)) return "accident";
  if (/寿险|定期寿|终身寿/.test(text)) return "life";
  return "unknown";
}

export function extractPolicyMeta(pages: PageText[]): PolicyMeta {
  const lines = toLines(pages);

  // 有的保单写「保险合同号」，有的直接写「保单号」（短期意外险的保单摘要）
  const policyNo = findText(lines, /(?:保险合同号|保单号)[：:]\s*([A-Za-z0-9-]{6,})/);
  const insurer = findText(
    lines,
    /([\u4e00-\u9fa5]{2,10}?(?:人寿|财产|健康)保险(?:股份)?有限公司)/,
  );
  const holder = findText(lines, /^投保人[：:]\s*([^\s：:]{2,12})/);
  const insured = findText(lines, /^被保险人[：:]\s*([^\s：:]{2,12})/);
  const productName = extractProductName(lines);

  // 日期在保单摘要里常被表格拆行：「2025年11月12日00时00分00秒 起」/「2026年11月11日24时00分00秒 止」
  const flat = lines.map((line) => line.text).join("\n");
  // 止期只从「保险期间」那种短行取：长句里的「…日…止」多半是公告、活动、附加条款的期限，
  // 把全文第一个「日…止」当保单止期，华贵那类保单会被认成 2021-12-31。
  const fromFlat = flat.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日[^\n]{0,14}?起/);
  const termLines = lines.filter(
    (line) =>
      !/公告|扩展|活动|赠送|声明/.test(line.text) &&
      (/保险期间|保障期间|合同期间/.test(line.text) ||
        (line.text.length <= 24 && /^\s*至/.test(line.text))),
  );
  const toFlat = termLines
    .map((line) => line.text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日[^\n]{0,20}?止/))
    .find((match) => match !== null) ?? null;

  const effectiveFrom =
    findDate(lines, /合同生效日期[：:]\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/) ??
    (fromFlat ? isoDate(fromFlat[1], fromFlat[2], fromFlat[3]) : null);
  const effectiveTo =
    findDate(
      termLines,
      /至\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*零?时?止/,
    ) ?? (toFlat ? isoDate(toFlat[1], toFlat[2], toFlat[3]) : null);

  const premium = findNumber(lines, /保险费合计[：:][^\n]*?(?:RMB|￥|¥)\s*([\d,]+(?:\.\d+)?)/);
  const hesitation = findNumber(lines, /(\d{1,3})\s*(?:日|天)(?:（[^）]*）)?(?:的)?犹豫期/);
  const waiting =
    findNumber(lines, /等待期[：:][^\n]{0,40}?(\d{1,3})\s*日/) ??
    findNumber(lines, /生效之日起\s*(\d{1,3})\s*日内被保险人发生疾病/);

  return {
    // 条款正文里写的是「“我们”、“本公司”均指中国人民人寿保险股份有限公司」，前缀要剔掉
    insurer: insurer?.value.replace(/^(均指|指)/, "") ?? null,
    product_name: productName,
    policy_no: policyNo?.value ?? null,
    category: inferCategory([productName, insurer?.value ?? null]),
    holder_name: holder?.value ?? null,
    insured_name: insured?.value ?? null,
    effective_from: effectiveFrom,
    effective_to: effectiveTo,
    premium,
    hesitation_days: hesitation && hesitation > 0 ? hesitation : null,
    // 「等待期 0 天」等于没有等待期，不要当成识别结果留在界面上
    waiting_days: waiting && waiting > 0 ? waiting : null,
    source_page: policyNo?.page ?? null,
  };
}
