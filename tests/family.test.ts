import assert from "node:assert/strict";
import test from "node:test";
import {
  activeOnly,
  archiveOf,
  daysUntil,
  expiryLabel,
  expiryOf,
  groupByInsured,
  isExpired,
  remindersOf,
  termKindLabel,
  termKindOf,
} from "../lib/family";
import type { ManagedPolicy } from "../lib/policy-store";

const today = new Date(2026, 10, 10); // 2026-11-10

function policy(overrides: Partial<ManagedPolicy> = {}): ManagedPolicy {
  return {
    documentId: 1,
    policyId: 1,
    filename: "a.pdf",
    category: "accident",
    insurer: "平安",
    productName: "小顽童",
    policyNo: null,
    holderName: "牛广",
    insuredName: "牛秋绥",
    effectiveFrom: "2025-11-12",
    effectiveTo: "2026-11-11",
    premium: 167,
    waitingDays: null,
    annualLimit: null,
    pageCount: 2,
    clauseCount: 0,
    coverageCount: 9,
    exclusionCount: 0,
    aiFacts: 10,
    needsReview: 0,
    aiStatus: "succeeded",
    createdAt: "2026-11-01",
    hasTextLayer: true,
    ...overrides,
  };
}

test("到期：按自然日算，明天到期就是 1 天", () => {
  assert.equal(daysUntil("2026-11-11", today), 1);
  assert.equal(daysUntil("2026-11-10", today), 0);
  assert.equal(daysUntil("2026-11-09", today), -1);
  assert.equal(daysUntil(null, today), null);
  assert.equal(daysUntil("日期不详", today), null);
});

test("到期：60 天内算即将到期，过了算过期", () => {
  assert.equal(expiryOf("2026-11-11", today).status, "soon");
  assert.equal(expiryLabel(expiryOf("2026-11-11", today)), "1 天后到期");
  assert.equal(expiryOf("2026-11-09", today).status, "expired");
  assert.equal(expiryLabel(expiryOf("2026-11-09", today)), "已过期 1 天");
  assert.equal(expiryOf("2056-01-15", today).status, "ok");
  assert.equal(expiryOf(null, today).status, "unknown");
  assert.equal(expiryLabel(expiryOf(null, today)), "期限未识别");
});

test("家庭：按被保险人分组，保额/保费/待复核各自汇总", () => {
  const members = groupByInsured([
    policy({ documentId: 23, insuredName: "牛秋绥", premium: 167 }),
    policy({ documentId: 26, insuredName: "牛秋绥", premium: 3220, effectiveTo: null }),
    policy({ documentId: 30, insuredName: "牛广", premium: 500, effectiveTo: "2050-01-01", needsReview: 3 }),
    policy({ documentId: 31, insuredName: null, premium: 100 }),
  ]);

  const byName = new Map(members.map((member) => [member.name, member]));
  assert.equal(members.length, 3);
  assert.equal(byName.get("牛秋绥")?.policies.length, 2);
  assert.equal(byName.get("牛秋绥")?.premium, 3387);
  assert.equal(byName.get("牛广")?.needsReview, 3);
  assert.ok(byName.has("未识别被保险人"));
  // 快到期的排在前面
  assert.equal(members[0].name, "牛秋绥");
});

test("家庭：到期提醒只列还没过期、60 天内的，期限未识别的单独计数", () => {
  const { due, unknown } = remindersOf(
    [
      policy({ documentId: 23, effectiveTo: "2026-11-11" }),
      policy({ documentId: 18, effectiveTo: null }),
      policy({ documentId: 25, effectiveTo: "2056-01-15" }),
      policy({ documentId: 40, effectiveTo: "2026-09-01" }),
    ],
    today,
  );
  // 已过期的 40 不在提醒里，去归档
  assert.deepEqual(due.map((item) => item.policy.documentId), [23]);
  assert.equal(unknown, 1);
});

test("期限：一年上下算一年期，明显更长算长期，缺日期不猜", () => {
  assert.equal(termKindOf("2025-11-12", "2026-11-11"), "short");
  assert.equal(termKindOf("2026-01-16", "2056-01-15"), "long");
  assert.equal(termKindOf("2026-11-08", null), "unknown");
  assert.equal(termKindOf(null, null), "unknown");
  assert.equal(termKindLabel("short"), "一年期");
  assert.equal(termKindLabel("long"), "长期");
  assert.equal(termKindLabel("unknown"), "期限未识别");
});

test("过期：过了止期算过期，没止期的不算", () => {
  assert.equal(isExpired(policy({ effectiveTo: "2026-09-01" }), today), true);
  assert.equal(isExpired(policy({ effectiveTo: "2026-11-11" }), today), false);
  assert.equal(isExpired(policy({ effectiveTo: null }), today), false);
});

test("过期：按到期年份归档，新的在前，未过期的不进归档", () => {
  const archive = archiveOf(
    [
      policy({ documentId: 40, effectiveTo: "2026-09-01" }),
      policy({ documentId: 41, effectiveTo: "2025-03-02" }),
      policy({ documentId: 42, effectiveTo: "2026-06-15" }),
      policy({ documentId: 23, effectiveTo: "2026-11-11" }),
      policy({ documentId: 18, effectiveTo: null }),
    ],
    today,
  );
  assert.deepEqual(
    archive.map((group) => [group.year, group.policies.map((item) => item.documentId)]),
    [
      [2026, [40, 42]],
      [2025, [41]],
    ],
  );
});

test("计算口径：只留在保的保单", () => {
  const active = activeOnly(
    [
      policy({ documentId: 23, effectiveTo: "2026-11-11" }),
      policy({ documentId: 40, effectiveTo: "2026-09-01" }),
      policy({ documentId: 18, effectiveTo: null }),
    ],
    today,
  );
  assert.deepEqual(active.map((item) => item.documentId), [23, 18]);
});

test("家庭：没有任何期限信息时不报警", () => {
  assert.deepEqual(remindersOf([policy({ effectiveTo: null })], today), { due: [], unknown: 1 });
});
