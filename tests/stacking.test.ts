import assert from "node:assert/strict";
import test from "node:test";
import { classifyBenefit, combineStack, fixedHighlights, pickIndemnityBenefit } from "../lib/stacking";
import type { EstimateBenefit } from "../lib/estimate";

function benefit(name: string, cap: number | null = null): EstimateBenefit {
  return { key: name, name, scopes: ["普通部"], tiers: [], cap, source: "table" };
}

function entry(name: string, payable: number, kind: "indemnity" | "fixed", cap: number | null = null) {
  return {
    documentId: 1,
    productName: "保单",
    insurer: null,
    benefitName: name,
    kind,
    payable,
    cap,
    blocked: null,
  };
}

test("叠加：医疗类算报销型，重疾/身故/津贴算定额型", () => {
  assert.equal(classifyBenefit("一般医疗保险金"), "indemnity");
  assert.equal(classifyBenefit("意外门（急）诊医疗保险金"), "indemnity");
  assert.equal(classifyBenefit("院外恶性肿瘤特定药品费用医疗保险金"), "indemnity");
  assert.equal(classifyBenefit("意外住院津贴"), "fixed");
  assert.equal(classifyBenefit("意外身故"), "fixed");
  assert.equal(classifyBenefit("首次重大疾病保险金"), "fixed");
});

test("叠加：优先挑费用补偿型里保额最高的一项来算", () => {
  const picked = pickIndemnityBenefit([
    benefit("意外身故", 300_000),
    benefit("意外伤害医疗保险责任", 100_000),
    benefit("一般医疗保险金", 4_000_000),
  ]);
  assert.equal(picked?.name, "一般医疗保险金");
});

test("叠加：纯定额保单不拿保额去凑医疗费", () => {
  assert.equal(pickIndemnityBenefit([benefit("意外身故", 300_000), benefit("意外残疾", 600_000)]), null);
});

test("叠加：医疗津贴算定额型，不进报销型合计", () => {
  assert.equal(classifyBenefit("白血病骨髓移植医疗津贴保险金"), "fixed");
  assert.equal(classifyBenefit("住院津贴"), "fixed");
  assert.equal(
    pickIndemnityBenefit([benefit("白血病骨髓移植医疗津贴保险金", 500), benefit("意外医疗保险责任", 20_000)])?.name,
    "意外医疗保险责任",
  );
});

test("叠加：保额明显偏小的定额项不列（多半是丢了「万」）", () => {
  const items = fixedHighlights([benefit("第二次重大疾病保险金", 130), benefit("意外身故", 300_000)]);
  assert.deepEqual(items.map((item) => item.name), ["意外身故"]);
});

test("叠加：报销型合计按自付封顶，定额型各自相加", () => {
  const summary = combineStack(
    [entry("医疗 A", 18_000, "indemnity"), entry("医疗 B", 9_000, "indemnity"), entry("住院津贴", 1_800, "fixed")],
    20_000,
  );
  assert.equal(summary.indemnityGross, 27_000);
  assert.equal(summary.indemnityTotal, 20_000);
  assert.equal(summary.capped, true);
  assert.equal(summary.fixedTotal, 1_800);
  assert.equal(summary.total, 21_800);
  assert.equal(summary.count, 3);
});

test("叠加：没超过自付时照实相加，不封顶", () => {
  const summary = combineStack([entry("医疗 A", 8_000, "indemnity")], 20_000);
  assert.equal(summary.indemnityTotal, 8_000);
  assert.equal(summary.capped, false);
  assert.equal(summary.total, 8_000);
});

test("叠加：定额给付只看保额最大的几项，且不带医疗类", () => {
  const items = fixedHighlights([
    benefit("一般医疗保险金", 4_000_000),
    benefit("意外身故", 300_000),
    benefit("意外残疾", 600_000),
    benefit("意外住院津贴", 18_000),
    benefit("救护车车费保险金", 2_000),
  ]);
  assert.deepEqual(
    items.map((item) => item.name),
    ["意外残疾", "意外身故", "意外住院津贴", "救护车车费保险金"],
  );
});
