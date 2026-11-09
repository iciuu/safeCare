import assert from "node:assert/strict";
import test from "node:test";
import { extractBenefitTable, extractTiers } from "../lib/benefit-table";
import type { PageText } from "../lib/segmentation";

/** 结构与原文逐句对齐：阅读指引的 ①② 清单 + 压平的保障表。 */
const pages: PageText[] = [
  {
    page_no: 6,
    text: `阅读指引
我们提供的保障
保障责任
①一般医疗保险金 ②重大疾病医疗保险金 ③院外恶性肿瘤特定药品费用医疗保险金 ④质子重离子医疗保险金 ⑤意外门（急）诊医疗保险金 ⑥重大疾病关爱保险金 ⑦重大疾病异地就医费用保险金
保险期间 1 年`,
  },
  {
    page_no: 30,
    text: `条款正文第 28 页 /共 37 页
附表 1
人保寿险关爱 e 生 2.0 少儿长期医疗保险（费率可调）（互联网专属）保障表
给付限额
保险期间内给付限额：各项保险金累计给付总限额 400 万元，其中，重大疾病异地就医费用保险金额为 2 万元。
保证续保期间内给付总限额：800 万元
等待期 90 天；意外伤害、续保，无等待期
保险责任项目 医院或药店等范围 给付比例
一般医疗保险金 我们认可的医院的
普通部 对于被保险人实际发生的属于本合同保险责任范围内的医疗费用金额扣除其从基本医疗保险、公费医疗、政府主办补充医疗取得的医疗费用补偿金额之后的余额累计不超过 5000 元的部分（含本数），给付比例为 80%，若投保时被保险人以有基本医疗保险或公费医疗身份投保，对于基本医疗保险支付范围内的一般医疗费用，如未以基本医疗保险或公费医疗身份就诊的，则给付比例为 48%
对于被保险人实际发生的属于本合同保险责任范围内的医疗费用金额扣除其从基本医疗保险、公费医疗、政府主办补充医疗取得的医疗费用补偿金额之后的余额累计超过 5000 元的部分，给付比例为 100%，若投保时被保险人以有基本医疗保险或公费医疗身份投保，对于基本医疗保险支付范围内的一般医疗费用，如未以基本医疗保险或公费医疗身份就诊的，则给付比例为 60%
重大疾病医疗保险金 我们认可的医院的普通部 100%，若投保时被保险人以有基本医疗保险或公费医疗身份投保，对于基本医疗保险支付范围内的重大疾病医疗费用，如未以基本医疗保险或公费医疗身份就诊的，则给付比例为 60% 我们认可的医院的特需部或我们指定的医院 100%
院外恶性肿瘤特定药品费用医疗保险金 我们指定的药店 100%，若投保时被保险人以有基本医疗保险或公费医疗身份投保，对于医保目录内的院外恶性肿瘤特定药品费用，如未以基本医疗保险或公费医疗身份就诊的，则给付比例为 60%
第30页，共44页`,
  },
];

const table = extractBenefitTable(pages);
const byName = new Map(table.items.map((item) => [item.name, item]));

test("找到保障表并解析出限额与等待期", () => {
  assert.equal(table.found, true);
  assert.equal(table.annual_limit, 4_000_000);
  assert.equal(table.renewal_limit, 8_000_000);
  assert.equal(table.waiting_days, 90);
  assert.ok(table.waiting_exceptions?.includes("无等待期"));
});

test("用阅读指引的 ①② 清单当行锚点，切出责任项", () => {
  assert.equal(table.items.length, 3);
  assert.deepEqual(
    table.items.map((item) => item.name),
    ["一般医疗保险金", "重大疾病医疗保险金", "院外恶性肿瘤特定药品费用医疗保险金"],
  );
});

test("一般医疗：金额分档 + 未以社保身份的降档", () => {
  const item = byName.get("一般医疗保险金");
  assert.ok(item);
  assert.equal(item.hospital_scope, "普通部");
  assert.deepEqual(
    item.tiers.map((tier) => [tier.when, tier.ratio]),
    [
      ["累计≤5000元", 0.8],
      ["累计≤5000元，未以社保身份就诊", 0.48],
      ["累计>5000元", 1],
      ["累计>5000元，未以社保身份就诊", 0.6],
    ],
  );
});

test("重大疾病：普通部 100%、未以社保 60%、特需部 100%", () => {
  const item = byName.get("重大疾病医疗保险金");
  assert.ok(item);
  assert.equal(item.hospital_scope, "普通部");
  assert.deepEqual(
    item.tiers.map((tier) => [tier.when, tier.ratio]),
    [
      ["标准情形", 1],
      ["未以社保身份就诊", 0.6],
      ["特需部/指定医院", 1],
    ],
  );
});

test("特药责任只认指定药店", () => {
  const item = byName.get("院外恶性肿瘤特定药品费用医疗保险金");
  assert.ok(item);
  assert.equal(item.hospital_scope, "指定药店");
  assert.ok(item.tiers.length >= 2);
});

test("没有保障表的文档返回空结果", () => {
  const empty = extractBenefitTable([{ page_no: 1, text: "随便一份文档\n没有任何表格" }]);
  assert.equal(empty.found, false);
  assert.equal(empty.items.length, 0);
  assert.equal(empty.annual_limit, null);
});

test("单行比例抽取：金额条件与社保条件分别落到 when 上", () => {
  const tiers = extractTiers("余额累计超过 5000 元的部分，给付比例为 100%");
  assert.deepEqual(tiers, [{ when: "累计>5000元", ratio: 1 }]);
});
