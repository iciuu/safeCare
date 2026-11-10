import assert from "node:assert/strict";
import test from "node:test";
import { expiryFromTerm } from "../lib/ai/extract";
import { extractPolicyMeta } from "../lib/policy-meta";

const term = (label: string, value: string, unit: string) => ({ kind: "term", label, value, unit });

test("止期推导：起期 + 保险期间 30 年 - 1 天", () => {
  assert.equal(
    expiryFromTerm({ effective_from: "2021-09-01" }, [term("保险期间", "30", "年")]),
    "2051-08-31",
  );
});

test("止期推导：闰日起期也对得上（2024-02-29 起一年，到 2025-02-28）", () => {
  assert.equal(
    expiryFromTerm({ effective_from: "2024-02-29" }, [term("保险期间", "1", "年")]),
    "2025-02-28",
  );
});

test("止期推导：没有起期、期间不是按年、数字不合理都不猜", () => {
  assert.equal(expiryFromTerm({}, [term("保险期间", "30", "年")]), null);
  assert.equal(expiryFromTerm({ effective_from: "2021-09-01" }, [term("保险期间", "70", "周岁")]), null);
  assert.equal(expiryFromTerm({ effective_from: "2021-09-01" }, [term("保险期间", "0", "年")]), null);
  assert.equal(expiryFromTerm({ effective_from: "2021-09-01" }, [term("交费期间", "30", "年")]), null);
});

test("止期推导：已有止期且与保险期间一致时不动它", () => {
  assert.equal(
    expiryFromTerm({ effective_from: "2021-09-01", effective_to: "2051-08-31" }, [
      term("保险期间", "30", "年"),
    ]),
    null,
  );
});

test("止期推导：止期明显不是保险期间届满日（公告到期日）时纠正", () => {
  assert.equal(
    expiryFromTerm({ effective_from: "2021-09-01", effective_to: "2021-12-31" }, [
      term("保险期间", "30", "年"),
    ]),
    "2051-08-31",
  );
});

test("规则层止期：公告里的「…日…止」不能当保单止期", () => {
  const meta = extractPolicyMeta([
    {
      page_no: 1,
      text: [
        "华贵大麦甜蜜家2021定期寿险",
        "保险合同号码：888050001698520合同生效日期：2021年09月01日零时",
        "保险期间：30年",
      ].join("\n"),
    },
    {
      page_no: 10,
      text: "责任扩展公告：本扩展责任自保险合同生效日起至2021年12月31日24时止。",
    },
  ]);
  assert.equal(meta.effective_from, "2021-09-01");
  assert.equal(meta.effective_to, null);
});
