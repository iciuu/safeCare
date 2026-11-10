import assert from "node:assert/strict";
import test from "node:test";
import { buildBatches, dedupeCoverages, locateQuote, shortenTierCondition } from "@/lib/ai/extract";
import {
  classifyElement,
  dedupeElements,
  groupExclusions,
  markConflicts,
  normalizeDate,
  normalizePolicyCategory,
  parseAmountYuan,
  type ElementDraft,
} from "@/lib/elements";

function draft(overrides: Partial<ElementDraft> = {}): ElementDraft {
  return {
    kind: "exclusion",
    label: "既往症",
    value: "",
    unit: "",
    condition: "",
    quote: "被保险人在本合同生效前已患有的疾病",
    page: 3,
    clauseNo: "3.1",
    confidence: 0.75,
    ...overrides,
  };
}

test("归类：靠关键词把要素分到固定类别，而不是照抄模型的说法", () => {
  assert.equal(classifyElement({ kind: "exclusion", label: "特需病房", value: "", quote: "" }).id, "hospital_scope");
  assert.equal(classifyElement({ kind: "term", label: "年度给付限额", value: "400", quote: "" }).id, "limit");
  assert.equal(classifyElement({ kind: "term", label: "社保未报销时的比例", value: "60", quote: "" }).id, "ratio");
  assert.equal(classifyElement({ kind: "coverage", label: "住院医疗保险金", value: "", quote: "" }).id, "inpatient");
  assert.equal(classifyElement({ kind: "coverage", label: "说不清的项目", value: "", quote: "" }).id, "other_coverage");
});

test("金额换算：万元转元，认不出单位不猜", () => {
  assert.equal(parseAmountYuan("400", "万元"), 4_000_000);
  assert.equal(parseAmountYuan("1,015", "元"), 1015);
  assert.equal(parseAmountYuan("60", "%"), null);
  assert.equal(parseAmountYuan("很多", "元"), null);
});

test("日期与险种归一：不同写法落到同一个值", () => {
  assert.equal(normalizeDate("2026年11月8日"), "2026-11-08");
  assert.equal(normalizeDate("2026/11/8"), "2026-11-08");
  assert.equal(normalizeDate("明年"), null);
  assert.equal(normalizePolicyCategory("未知", ["人保寿险关爱 e 生 少儿长期医疗保险"]), "medical");
  assert.equal(normalizePolicyCategory(null, ["某某重大疾病保险"]), "critical_illness");
  assert.equal(normalizePolicyCategory(null, ["驾乘人员意外伤害保险"]), "accident");
  assert.equal(normalizePolicyCategory(null, ["定期寿险"]), "life");
});

test("去重：同一条事实在两页重复出现只留一条，页码靠前的优先", () => {
  const rows = dedupeElements([
    draft({ label: "等待期", value: "90", unit: "天", kind: "term", page: 12 }),
    draft({ label: "等待期", value: "90", unit: "天", kind: "term", page: 10 }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].page, 10);
});

test("去重：条件更长的一条会把条件补过来", () => {
  const rows = dedupeElements([
    draft({ kind: "term", label: "等待期", value: "90", unit: "天", condition: "意外伤害无等待期", page: 10 }),
    draft({ kind: "term", label: "等待期", value: "90", unit: "天", condition: "", page: 12 }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].condition, "意外伤害无等待期");
});

test("冲突：同一个标签两个值，两条都留并标待复核", () => {
  const rows = markConflicts(
    dedupeElements([
      draft({ kind: "term", label: "等待期", value: "90", unit: "天", page: 10 }),
      draft({ kind: "term", label: "等待期", value: "30", unit: "天", page: 14 }),
    ]),
  );
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.reviewStatus === "needs_review"));
});

test("批次：按字符预算切页，页不切开", () => {
  const pages = [1, 2, 3, 4].map((page_no) => ({ page_no, text: "x".repeat(100) }));
  assert.equal(buildBatches(pages, 1000).length, 1);
  assert.equal(buildBatches(pages, 150).length, 4);
});

test("引文反查：模型说错页码也能按原文找到真实页；找不到就返回 null", () => {
  const pages = [
    { page_no: 5, text: "我们在每个保险期间内的累计给付限额为400万元。" },
    { page_no: 6, text: "责任免除：被保险人在等待期内发生疾病。" },
  ];
  assert.equal(locateQuote(pages, "累计给付限额为400万元", 9), 5);
  assert.equal(locateQuote(pages, "这句话原文里根本没有", 6), null);
});

test("分级条件压成短语", () => {
  assert.equal(shortenTierCondition("投保时以有基本医疗保险身份投保，未以基本医疗保险身份就诊的"), "未以社保身份就诊");
  assert.equal(shortenTierCondition("已从基本医疗保险取得医疗费用补偿金额之后的余额部分"), "已从社保报销");
  assert.equal(shortenTierCondition("超过部分"), "超过部分");
});

test("责任去重：同名责任只留信息最全的一条", () => {
  const base = {
    name: "一般医疗保险金",
    benefitType: "reimburse",
    hospitalScope: "",
    tiers: [],
    annualLimit: null,
    annualLimitUnit: "元",
    waitingDays: null,
    quote: "一般医疗保险金",
    page: 42,
    confidence: 0.6,
    reviewStatus: "ok" as const,
  };
  const merged = dedupeCoverages([
    base,
    { ...base, tiers: [{ when: "已从社保报销", ratio: 1 }], page: 43 },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].tiers.length, 1);
});

const exclusion = (label: string, value: string, quote = value) => ({ label, value, quote, category: null });

test("免责归组：label 是旧归类名时不自我套用，按正文重新归", () => {
  const [group] = groupExclusions([
    exclusion("医院范围", "不符合入院标准、挂床住院或住院病人应当出院而拒不出院"),
  ]);
  assert.equal(group.label, "住院行为规范");
});

test("免责归组：把 24 条免责压成几类，组内保留原文顺序，认不出的进「其他免责」", () => {
  const groups = groupExclusions([
    exclusion("违法违约", "被保险人故意犯罪或者抗拒依法采取的刑事强制措施"),
    exclusion("其他免责", "被保险人在酒后驾驶、无合法有效驾驶证驾驶机动车期间遭受意外伤害"),
    exclusion("其他免责", "被保险人进行潜水、攀岩、探险、赛马、特技表演"),
    exclusion("其他免责", "战争、军事冲突、暴乱或恐怖主义行为"),
    exclusion("其他免责", "本合同未约定的事项"),
  ]);
  assert.deepEqual(
    groups.map((item) => [item.label, item.items.length]),
    [
      ["故意与违法犯罪", 1],
      ["驾驶与交通工具", 1],
      ["高风险运动", 1],
      ["战争、暴乱与核污染", 1],
      ["其他免责", 1],
    ],
  );
});
