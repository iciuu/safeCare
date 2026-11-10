/**
 * 家庭总览：按被保险人把保单归到一起，顺手算到期还有多少天。
 *
 * 只用库里已有的字段（data.insured_name / effective_to / premium），
 * 期限没识别出来的就老实写「期限未识别」，不按一年期默认补一个。
 */

import type { ManagedPolicy } from "./policy-store";

export type ExpiryStatus = "expired" | "soon" | "ok" | "unknown";

export type Expiry = { status: ExpiryStatus; days: number | null };

/** 到期前多少天开始提醒（家长续保通常提前一两周办） */
export const SOON_DAYS = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 只收 YYYY-MM-DD，且必须是真实存在的日期（2026-02-31 不算）。 */
export function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** 只比日期，不看时分秒：用 UTC 0 点相减，避免时区把一天算成 23 小时 */
export function daysUntil(date: string | null, today: Date = new Date()): number | null {
  if (!date) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date.trim());
  if (!match) return null;
  const target = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(target)) return null;
  const base = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((target - base) / DAY_MS);
}

export function expiryOf(effectiveTo: string | null, today: Date = new Date(), soonDays = SOON_DAYS): Expiry {
  const days = daysUntil(effectiveTo, today);
  if (days === null) return { status: "unknown", days: null };
  if (days < 0) return { status: "expired", days };
  if (days <= soonDays) return { status: "soon", days };
  return { status: "ok", days };
}

export type HouseholdMember = {
  name: string;
  policies: ManagedPolicy[];
  premium: number;
  needsReview: number;
  /** 最近一个到期日（不含已过期），用来排先后 */
  nextExpiry: number | null;
};

export function groupByInsured(policies: ManagedPolicy[]): HouseholdMember[] {
  const groups = new Map<string, ManagedPolicy[]>();
  for (const policy of policies) {
    const name = policy.insuredName?.trim() || "未识别被保险人";
    groups.set(name, [...(groups.get(name) ?? []), policy]);
  }

  return [...groups.entries()]
    .map(([name, list]) => {
      const days = list
        .map((policy) => daysUntil(policy.effectiveTo))
        .filter((value): value is number => value !== null && value >= 0);
      return {
        name,
        policies: list,
        premium: list.reduce((sum, policy) => sum + (policy.premium ?? 0), 0),
        needsReview: list.reduce((sum, policy) => sum + policy.needsReview, 0),
        nextExpiry: days.length > 0 ? Math.min(...days) : null,
      };
    })
    .sort((a, b) => {
      if (a.nextExpiry === null && b.nextExpiry === null) return a.name.localeCompare(b.name, "zh-CN");
      if (a.nextExpiry === null) return 1;
      if (b.nextExpiry === null) return -1;
      return a.nextExpiry - b.nextExpiry;
    });
}

export type HouseholdReminder = {
  policy: ManagedPolicy;
  insured: string;
  expiry: Expiry;
  term: TermKind;
};

/**
 * 到期提醒只算「还没过期、60 天内要处理」的：一年期是续保，长期是期满。
 * 已经过期的进年份归档（`archiveOf`），不在这里提醒，也不参与后续计算。
 * 期限没识别的单独计数，不当成快到期。
 */
export function remindersOf(
  policies: ManagedPolicy[],
  today: Date = new Date(),
  soonDays = SOON_DAYS,
): { due: HouseholdReminder[]; unknown: number } {
  const due: HouseholdReminder[] = [];
  let unknown = 0;

  for (const policy of policies) {
    const expiry = expiryOf(policy.effectiveTo, today, soonDays);
    if (expiry.status === "unknown") {
      unknown += 1;
      continue;
    }
    if (expiry.status === "soon") {
      due.push({
        policy,
        insured: policy.insuredName?.trim() || "未识别被保险人",
        expiry,
        term: termKindOf(policy.effectiveFrom, policy.effectiveTo),
      });
    }
  }

  due.sort((a, b) => (a.expiry.days ?? 0) - (b.expiry.days ?? 0));
  return { due, unknown };
}

/**
 * 期限类型：保障期间一年上下（含续保当年）算一年期，明显更长算长期。
 * 起期或止期缺一个就返回 unknown——短期医疗险常常只印起期，不能当成长期。
 */
export type TermKind = "short" | "long" | "unknown";

/** 一年期保单可能多出几天宽限（如 366 天），留一点余量 */
export const SHORT_TERM_MAX_DAYS = 400;

export function termKindOf(effectiveFrom: string | null, effectiveTo: string | null): TermKind {
  const from = daysUntil(effectiveFrom);
  const to = daysUntil(effectiveTo);
  if (from === null || to === null) return "unknown";
  const span = to - from;
  if (span <= 0) return "unknown";
  return span <= SHORT_TERM_MAX_DAYS ? "short" : "long";
}

export function termKindLabel(kind: TermKind): string {
  return kind === "short" ? "一年期" : kind === "long" ? "长期" : "期限未识别";
}

/** 过期了就不算在保：叠加、汇总这类计算都用它过滤。 */
export function isExpiredDate(effectiveTo: string | null, today: Date = new Date()): boolean {
  return expiryOf(effectiveTo, today).status === "expired";
}

export function isExpired(policy: ManagedPolicy, today: Date = new Date()): boolean {
  return isExpiredDate(policy.effectiveTo, today);
}

export function activeOnly(policies: ManagedPolicy[], today: Date = new Date()): ManagedPolicy[] {
  return policies.filter((policy) => !isExpired(policy, today));
}

/** 过期归档：按到期年份分组，新的在前；同一年内按到期日排。 */
export function archiveOf(
  policies: ManagedPolicy[],
  today: Date = new Date(),
): { year: number; policies: ManagedPolicy[] }[] {
  const groups = new Map<number, ManagedPolicy[]>();

  for (const policy of policies) {
    if (!isExpired(policy, today)) continue;
    const match = /^(\d{4})-/.exec(policy.effectiveTo?.trim() ?? "");
    if (!match) continue;
    const year = Number(match[1]);
    groups.set(year, [...(groups.get(year) ?? []), policy]);
  }

  return [...groups.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, list]) => ({
      year,
      policies: [...list].sort((a, b) => (b.effectiveTo ?? "").localeCompare(a.effectiveTo ?? "")),
    }));
}

export function expiryLabel(expiry: Expiry): string {
  if (expiry.days === null) return "期限未识别";
  if (expiry.days < 0) return `已过期 ${Math.abs(expiry.days)} 天`;
  if (expiry.days === 0) return "今天到期";
  // 长期重疾险剩十几年，写「10658 天后到期」没人看得懂
  // 上百年基本是「长期有效」，写「973 年后到期」没意义
  if (expiry.days > 365 * 100) return "长期有效";
  if (expiry.days > 730) return `${Math.round(expiry.days / 365)} 年后到期`;
  return `${expiry.days} 天后到期`;
}
