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
};

/** 到期提醒：已过期和 60 天内到期的，按紧急性排；期限没识别的单独统计不混进来。 */
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
    if (expiry.status === "expired" || expiry.status === "soon") {
      due.push({ policy, insured: policy.insuredName?.trim() || "未识别被保险人", expiry });
    }
  }

  due.sort((a, b) => (a.expiry.days ?? 0) - (b.expiry.days ?? 0));
  return { due, unknown };
}

export function expiryLabel(expiry: Expiry): string {
  if (expiry.days === null) return "期限未识别";
  if (expiry.days < 0) return `已过期 ${Math.abs(expiry.days)} 天`;
  if (expiry.days === 0) return "今天到期";
  // 长期重疾险剩十几年，写「10658 天后到期」没人看得懂
  if (expiry.days > 730) return `${Math.round(expiry.days / 365)} 年后到期`;
  return `${expiry.days} 天后到期`;
}
