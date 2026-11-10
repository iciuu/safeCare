/**
 * 多保单叠加：同一被保险人的几张保单放在一起看。
 *
 * 只区分两类，不做比这更细的判断：
 * - 费用补偿型（医疗费用报销）：赔的是「花掉的钱」，几家合计不会超过自付部分。
 * - 定额给付型（重疾 / 身故 / 残疾 / 津贴）：按约定金额给，各自独立，通常可以叠加。
 *
 * 真实理赔还有分摊顺序、社保先行、重复保险比例分摊等规则，这里只给量级参考。
 */

import type { EstimateBenefit } from "./estimate";

export type StackKind = "indemnity" | "fixed";

const INDEMNITY_HINT = /医疗|门（急）诊|门诊|住院医疗|药品费|药费|自费医疗|费用补偿/;
/** 「医疗津贴」是每天/每次给固定金额，不跟着实际花费走，仍算定额型 */
const FIXED_HINT = /津贴|补贴|关爱金|保险金（定额）/;

/** 保额低于这个数的多半是解析时把「万」丢了，列出来只会误导 */
export const MIN_FIXED_CAP = 1_000;

export function classifyBenefit(name: string): StackKind {
  if (FIXED_HINT.test(name)) return "fixed";
  return INDEMNITY_HINT.test(name) ? "indemnity" : "fixed";
}

/**
 * 挑「这次看病能报多少」要算的那一项：保额最高的费用补偿型责任。
 * 一份保单里没有任何费用补偿责任（纯重疾/寿险）就返回 null，不要拿重疾保额去凑医疗费。
 */
export function pickIndemnityBenefit(benefits: EstimateBenefit[]): EstimateBenefit | null {
  const indemnity = benefits.filter((benefit) => classifyBenefit(benefit.name) === "indemnity");
  if (indemnity.length === 0) return null;
  return [...indemnity].sort((a, b) => (b.cap ?? 0) - (a.cap ?? 0))[0];
}

export type StackEntry = {
  documentId: number;
  productName: string;
  insurer: string | null;
  benefitName: string;
  kind: StackKind;
  payable: number;
  cap: number | null;
  /** 这一项算不出来时的原因（就诊范围不符、等待期、免责…） */
  blocked: string | null;
};

export type StackSummary = {
  /** 费用补偿型合计（已按自付金额封顶） */
  indemnityTotal: number;
  /** 费用补偿型未封顶前的合计，用来提示被谁压住了 */
  indemnityGross: number;
  capped: boolean;
  fixedTotal: number;
  total: number;
  count: number;
};

export function combineStack(entries: StackEntry[], selfPay: number): StackSummary {
  const indemnity = entries.filter((entry) => entry.kind === "indemnity");
  const fixed = entries.filter((entry) => entry.kind === "fixed");

  const indemnityGross = indemnity.reduce((sum, entry) => sum + entry.payable, 0);
  const ceiling = Math.max(0, selfPay);
  const indemnityTotal = Math.min(indemnityGross, ceiling);
  const fixedTotal = fixed.reduce((sum, entry) => sum + entry.payable, 0);

  return {
    indemnityTotal,
    indemnityGross,
    capped: indemnityGross > ceiling,
    fixedTotal,
    total: indemnityTotal + fixedTotal,
    count: entries.length,
  };
}

/** 定额给付的保额清单：重疾/身故/残疾这类要「符合定义」才给，不按医疗费用算。 */
export function fixedHighlights(benefits: EstimateBenefit[], limit = 4): { name: string; cap: number }[] {
  return benefits
    .filter((benefit) => classifyBenefit(benefit.name) === "fixed" && (benefit.cap ?? 0) >= MIN_FIXED_CAP)
    .sort((a, b) => (b.cap ?? 0) - (a.cap ?? 0))
    .slice(0, limit)
    .map((benefit) => ({ name: benefit.name, cap: benefit.cap ?? 0 }));
}
