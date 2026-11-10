/**
 * 保单摘要里的「保障责任明细表」解析（规则，兜底用）。
 *
 * 短期意外险常常只上传两页保单摘要：一张表写着「责任名称 / 每人份保额 / 免赔及责任说明」。
 * 这类表在 PDF 抽出的文字里是被打散的，模型也常常抄不全，所以这里用确定性规则把
 * 「名称 + 金额」的行捞出来，作为责任项补进 coverage 表；分级比例仍交给 AI 或附表解析。
 */

export type SummaryCoverage = {
  name: string;
  amount: number;
  page: number;
  /** 同一段「免赔及责任说明」里出现的比例，能认出来就顺手带上 */
  ratio: number | null;
  deductible: number | null;
};

const HEADER = /责任名称/;
const AMOUNT_TAIL = /\s([\d,]+\.\d{2})\s*(?:$|\n)/;
const INLINE_AMOUNT = /([\u4e00-\u9fa5][\u4e00-\u9fa5A-Za-z0-9（）()、·\-\s]{1,29}?)\s+([\d,]+\.\d{2})(?!\d)/g;

const SKIP = /^(序号|责任名称|险种名称|方案名称|投保人|被保险人|保险期限|保险费合计|特别约定)/;

function cleanName(raw: string): string {
  return raw
    .replace(/(每人|每份|每次|保额|元|（元）|\(元\))/g, "")
    .replace(/^[0-9]+[、.]/, "")
    .replace(/\s+/g, "")
    .trim();
}

/** 一段责任说明里找免赔额与给付比例，例如「每次事故绝对免赔额(元):0;每次事故赔付比例(%):100.0%」 */
function readTerms(text: string): { ratio: number | null; deductible: number | null } {
  const ratio = text.match(/赔付比例[^:：]*[:：]\s*(\d+(?:\.\d+)?)\s*%/);
  const deductible = text.match(/免赔额[^:：\d]*[:：]\s*(\d+(?:\.\d+)?)/);
  return {
    ratio: ratio ? Number(ratio[1]) / 100 : null,
    deductible: deductible ? Number(deductible[1]) : null,
  };
}

export function extractSummaryCoverages(pages: { page_no: number; text: string }[]): SummaryCoverage[] {
  const found = new Map<string, SummaryCoverage>();

  for (const page of pages) {
    const text = page.text;
    if (!HEADER.test(text)) continue;
    // 只认「责任名称 … 每人/份保额」这种明细表，避免把普通条款里的金额行当责任
    if (!/(每人\/份保额|每人份保额|每人\/份|保额)/.test(text)) continue;

    const terms = readTerms(text);

    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || SKIP.test(trimmed)) continue;

      const tail = trimmed.match(AMOUNT_TAIL);
      let name = "";
      let amount = 0;

      if (tail) {
        // 「意外伤害骨折、关节脱位 3,000.00」
        name = cleanName(trimmed.slice(0, tail.index ?? 0));
        amount = Number(tail[1].replace(/,/g, ""));
      } else {
        for (const match of trimmed.matchAll(INLINE_AMOUNT)) {
          const candidate = cleanName(match[1]);
          const value = Number(match[2].replace(/,/g, ""));
          // 名称里带「表 / 条款 / 方式 / 限额」的多半不是责任行
          if (candidate.length < 3 || candidate.length > 30) continue;
          if (/表|条款|方式|合计|保费|限额$/.test(candidate)) continue;
          if (value < 100) continue;
          name = candidate;
          amount = value;
        }
      }

      if (!name || !Number.isFinite(amount) || amount <= 0) continue;
      if (found.has(name)) continue;

      found.set(name, {
        name,
        amount,
        page: Number(page.page_no),
        ratio: terms.ratio,
        deductible: terms.deductible,
      });
    }
  }

  return [...found.values()].slice(0, 40);
}
