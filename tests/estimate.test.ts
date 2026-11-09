import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPlan,
  computeEstimate,
  parseTiers,
  type EstimateBenefit,
  type EstimateInput,
  type EstimateRefs,
} from "../lib/estimate";

const refs: EstimateRefs = {
  benefitTable: { clauseNo: "附表1", page: 43 },
  liability: { clauseNo: "2.5", page: 10 },
  limit: { clauseNo: "2.3", page: 10 },
  compensation: { clauseNo: "2.6", page: 15 },
  waiting: { clauseNo: "2.4", page: 10 },
  exclusion: { clauseNo: "3.1", page: 17 },
};

/** 附表 1 抽出来的四档比例。 */
const general: EstimateBenefit = {
  key: "general",
  name: "一般医疗保险金",
  scopes: ["普通部"],
  source: "table",
  tiers: parseTiers([
    { when: "累计≤5000元", ratio: 0.8 },
    { when: "累计≤5000元，未以社保身份就诊", ratio: 0.48 },
    { when: "累计>5000元", ratio: 1 },
    { when: "累计>5000元，未以社保身份就诊", ratio: 0.6 },
  ]),
};

const critical: EstimateBenefit = {
  key: "critical",
  name: "重大疾病医疗保险金",
  scopes: ["普通部", "特需部/指定医院"],
  source: "table",
  tiers: parseTiers([{ when: "标准情形", ratio: 1 }, { when: "未以社保身份就诊", ratio: 0.6 }]),
};

function input(overrides: Partial<EstimateInput> = {}): EstimateInput {
  return {
    benefitKey: "general",
    scope: "普通部",
    totalCost: 32_000,
    socialPaid: 12_000,
    otherPaid: 0,
    usedSocial: true,
    catalogCost: null,
    inWaiting: false,
    exclusion: null,
    paidThisYear: 0,
    annualLimit: 4_000_000,
    ...overrides,
  };
}

test("档位解析：金额分档与社保降档合并到同一档", () => {
  assert.deepEqual(general.tiers, [
    { label: "累计≤5000元", upto: 5000, ratio: 0.8, noSocialRatio: 0.48 },
    { label: "累计>5000元", upto: null, ratio: 1, noSocialRatio: 0.6 },
  ]);
  assert.deepEqual(critical.tiers, [
    { label: "标准情形", upto: null, ratio: 1, noSocialRatio: 0.6 },
  ]);
});

test("一般医疗：先扣社保已补偿，再按 5000 元分段计算", () => {
  const result = computeEstimate(input(), general, refs);
  assert.equal(result.base, 20_000);
  assert.deepEqual(
    result.parts.map((part) => [part.portion, part.ratio, part.amount]),
    [
      [5000, 0.8, 4000],
      [15_000, 1, 15_000],
    ],
  );
  assert.equal(result.payable, 19_000);
  assert.equal(result.blockers.length, 0);
});

test("补偿原则：社保之外的其他途径赔付也先扣掉", () => {
  const result = computeEstimate(input({ socialPaid: 10_000, otherPaid: 2000 }), general, refs);
  assert.equal(result.base, 20_000);
  assert.equal(result.payable, 19_000);
});

test("余额不足 5000 元时只走 80% 一档", () => {
  const result = computeEstimate(input({ totalCost: 32_000, socialPaid: 30_000 }), general, refs);
  assert.equal(result.base, 2000);
  assert.equal(result.payable, 1600);
});

test("未以社保身份就诊：目录内 48%/60%，目录外仍按标准档", () => {
  const result = computeEstimate(
    input({ totalCost: 10_000, socialPaid: 0, usedSocial: false, catalogCost: 8000 }),
    general,
    refs,
  );
  // 目录内 8000 → 5000×48% + 3000×60% = 4200；目录外 2000 → 2000×80% = 1600
  assert.equal(result.payable, 5800);
  assert.deepEqual(
    result.parts.map((part) => part.label),
    ["医保目录内 · 累计≤5000元", "医保目录内 · 累计>5000元", "医保目录外 · 累计≤5000元"],
  );
});

test("没填目录内金额时按全额目录内估算并给出提示", () => {
  const result = computeEstimate(
    input({ totalCost: 10_000, socialPaid: 0, usedSocial: false }),
    general,
    refs,
  );
  assert.equal(result.payable, 5400);
  assert.ok(result.notes.some((note) => note.includes("目录内")));
});

test("等待期内一律为 0，并给出 2.4 依据", () => {
  const result = computeEstimate(input({ inWaiting: true }), general, refs);
  assert.equal(result.payable, 0);
  assert.equal(result.parts.length, 0);
  assert.equal(result.blockers[0]?.title, "发生在等待期内");
  assert.deepEqual(result.blockers[0]?.ref, { clauseNo: "2.4", page: 10 });
});

test("命中免责情形一律为 0", () => {
  const result = computeEstimate(input({ exclusion: "既往症免责" }), general, refs);
  assert.equal(result.payable, 0);
  assert.equal(result.blockers[0]?.title, "属于责任免除情形");
});

test("一般医疗不覆盖特需部", () => {
  const result = computeEstimate(input({ scope: "特需部/指定医院" }), general, refs);
  assert.equal(result.payable, 0);
  assert.equal(result.blockers[0]?.title, "就诊范围不在这一项责任的范围内");
});

test("重疾责任可以走特需部，且无 5000 元分档", () => {
  const result = computeEstimate(
    input({ benefitKey: "critical", scope: "特需部/指定医院", totalCost: 80_000, socialPaid: 30_000 }),
    critical,
    refs,
  );
  assert.equal(result.payable, 50_000);
});

test("按本保险期间剩余限额封顶", () => {
  const result = computeEstimate(
    input({ totalCost: 100_000, socialPaid: 0, paidThisYear: 3_990_000 }),
    general,
    refs,
  );
  // 5000×80% + 95000×100% = 99000，再被剩余额度 10000 封顶
  assert.equal(result.gross, 99_000);
  assert.equal(result.payable, 10_000);
  assert.ok(result.notes.some((note) => note.includes("限额")));
});

test("没有限额时不做封顶，并说明原因", () => {
  const result = computeEstimate(input({ annualLimit: null }), general, refs);
  assert.equal(result.payable, 19_000);
  assert.ok(result.notes.some((note) => note.includes("限额")));
});

test("责任清单：优先用附表抽到的比例，缺的责任退回内置规则", () => {
  const plan = buildPlan({
    coverage: [
      {
        name: "一般医疗保险金",
        hospital_scope: "普通部",
        tiers: [
          { when: "累计≤5000元", ratio: 0.8 },
          { when: "累计≤5000元，未以社保身份就诊", ratio: 0.48 },
          { when: "累计>5000元", ratio: 1 },
          { when: "累计>5000元，未以社保身份就诊", ratio: 0.6 },
        ],
      },
    ],
    benefitTableText: "一般医疗保险金 普通部 80% 重大疾病医疗保险金 100% 质子重离子医疗保险金 100%",
  });

  assert.deepEqual(
    plan.benefits.map((benefit) => [benefit.name, benefit.source]),
    [
      ["一般医疗保险金", "table"],
      ["重大疾病医疗保险金", "builtin"],
      ["质子重离子医疗保险金", "builtin"],
    ],
  );
  assert.equal(plan.benefits[0]?.tiers.length, 2);
  assert.ok(plan.notes.some((note) => note.includes("内置规则")));
});

test("附表里没提到的责任不列出来", () => {
  const plan = buildPlan({ coverage: [], benefitTableText: "一般医疗保险金 80%" });
  assert.deepEqual(
    plan.benefits.map((benefit) => benefit.key),
    ["general"],
  );
});

test("没有附表时给出核对提示", () => {
  const plan = buildPlan({ coverage: [], benefitTableText: null });
  assert.equal(plan.benefits.length, 0);
  assert.equal(plan.notes.length, 1);
});
