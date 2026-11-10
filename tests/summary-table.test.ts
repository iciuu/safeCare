import assert from "node:assert/strict";
import test from "node:test";
import { extractSummaryCoverages } from "../lib/summary-table";

const page = {
  page_no: 1,
  text: [
    "4、保障责任明细",
    "责任名称 每人/份保额 免赔及责任说明",
    "每次事故绝对免赔额(元):0;每次事故赔付比例(%):100.0%;责任描述:被保险人意外医疗就诊医院限",
    "意外伤害医疗保险责任 100,000.00",
    "意外伤害骨折、关节脱位 3,000.00",
    "意外身故 300,000.00",
    "险种名称：平安产险附加意外伤害住院津贴保险（互联网版）",
    "责任名称 每人/份保额 免赔及责任说明",
    "意外住院津贴 18,000.00 天。",
  ].join("\n"),
};

test("保单摘要：把「责任名 + 保额」的行捞成责任项，比例从责任说明里带过来", () => {
  const items = extractSummaryCoverages([page]);
  const names = items.map((item) => item.name);
  assert.deepEqual(names, ["意外伤害医疗保险责任", "意外伤害骨折、关节脱位", "意外身故", "意外住院津贴"]);

  const medical = items.find((item) => item.name === "意外伤害医疗保险责任");
  assert.equal(medical?.amount, 100_000);
  assert.equal(medical?.ratio, 1);
  assert.equal(medical?.deductible, 0);
  assert.equal(items.find((item) => item.name === "意外住院津贴")?.amount, 18_000);
});

test("保单摘要：没有责任明细表头的页面不瞎抽", () => {
  assert.deepEqual(
    extractSummaryCoverages([{ page_no: 3, text: "一般医疗保险金 100,000.00 元，按 80% 给付。" }]),
    [],
  );
});
