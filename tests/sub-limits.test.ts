import assert from "node:assert/strict";
import test from "node:test";
import { extractSubLimits } from "../lib/sub-limits";

function clause(text: string, page = 11, clauseNo: string | null = "2.5") {
  return { clause_no: clauseNo, page_from: page, text };
}

test("分项限额：认「…费用的累计给付限额为 X 万元」", () => {
  const limits = extractSubLimits([
    clause("在每个保险期间内，我们对一般医疗保险金和重大疾病医疗保险金中的住院期间耐用医疗设备费用的累计给付限额为2万元。"),
  ]);
  assert.equal(limits.length, 1);
  assert.equal(limits[0].label, "住院期间耐用医疗设备费用");
  assert.equal(limits[0].limit, 20_000);
  assert.equal(limits[0].kind, "total");
  assert.equal(limits[0].page, 11);
  assert.equal(limits[0].clauseNo, "2.5");
});

test("分项限额：整单限额、保证续保总限额不算分项", () => {
  const limits = extractSubLimits([
    clause("本合同的保险金额是每一保险期间内我们累计给付的保险金限额。"),
    clause("在保证续保期间内，我们累计给付的保险金总限额为800万元。"),
    clause("上述各项保险金在保险期间内的累计给付限额之和为人民币400万元。"),
  ]);
  assert.deepEqual(limits, []);
});

test("分项限额：限的是保额而不是费用时不算", () => {
  const limits = extractSubLimits([clause("我们对重大疾病异地就医费用保险金的累计给付限额为本合同的重大疾病异地就医费用保险金额。")]);
  assert.deepEqual(limits, []);
});

test("分项限额：每日限额单独标成 daily，不混进一次性估算", () => {
  const limits = extractSubLimits([clause("床位费每日限额为300元。", 12, "2.5")]);
  assert.equal(limits.length, 1);
  assert.equal(limits[0].kind, "daily");
  assert.equal(limits[0].limit, 300);
});

test("分项限额：同一类别只留最严的一条", () => {
  const limits = extractSubLimits([
    clause("对院外恶性肿瘤特定药品费用的累计给付限额为100万元。", 13),
    clause("对院外恶性肿瘤特定药品费用的累计给付限额为30万元。", 14),
  ]);
  assert.equal(limits.length, 1);
  assert.equal(limits[0].limit, 300_000);
});

test("分项限额：太小的数字（明显是排版串行）不收", () => {
  const limits = extractSubLimits([clause("对某项费用的累计给付限额为5元。")]);
  assert.deepEqual(limits, []);
});
