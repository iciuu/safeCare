import assert from "node:assert/strict";
import test from "node:test";
import { findEntityLeaks, findLeaks, redactDocument } from "../lib/redact";

/** 取自真实保单页，逐行对齐原文。 */
const page = `保险合同号：016968397114158 投保单号：016968397114158 币值单位：人民币元
投保人：牛广 证件类型：居民身份证 证件号码：130481199003070072
联系地址：江苏省南京市江宁区中海国际社区三期一栋1202 联系电话：13770935407
被保险人：牛秋绥 证件类型：户口簿 证件号码：320115202510130199
本合同的受益人为被保险人本人
2.5 保险责任 在本合同有效期内，我们承担如下保险责任，年度给付限额 400 万元。`;

const result = redactDocument(page);

test("身份信息被替换成占位符", () => {
  for (const secret of [
    "牛广",
    "牛秋绥",
    "130481199003070072",
    "320115202510130199",
    "13770935407",
    "016968397114158",
    "中海国际社区",
  ]) {
    assert.ok(!result.text.includes(secret), `漏了 ${secret}`);
  }

  assert.ok(result.text.includes("‹POLICYNO_1›"));
  assert.ok(result.text.includes("‹NAME_1›"));
  assert.ok(result.text.includes("‹NAME_2›"));
  assert.ok(result.text.includes("‹ID_1›"));
  assert.ok(result.text.includes("‹ID_2›"));
  assert.ok(result.text.includes("‹PHONE_1›"));
  assert.ok(result.text.includes("‹ADDR_1›"));
});

test("条款正文一个字都不改", () => {
  assert.ok(result.text.includes("2.5 保险责任 在本合同有效期内，我们承担如下保险责任，年度给付限额 400 万元。"));
  // 「受益人」不是人名，不能被抹
  assert.ok(result.text.includes("本合同的受益人为被保险人本人"));
});

test("同一实体只分配一个占位符", () => {
  const policyPlaceholders = result.entries.filter((entry) => entry.entity_type === "policy_no");
  assert.equal(policyPlaceholders.length, 1);
  assert.equal(policyPlaceholders[0].entity_value, "016968397114158");
});

test("出口校验：脱敏后不再命中任何标识符", () => {
  assert.deepEqual(findLeaks(result.text), []);
  assert.deepEqual(findEntityLeaks(result.text, result.entries), []);
});

test("出口校验能拦住漏网的身份证号", () => {
  const leaks = findLeaks("客户的证件号码 130481199003070072 还在");
  assert.equal(leaks.length, 1);
  assert.equal(leaks[0].type, "id_card");
  // 只回报长度，不回显原值
  assert.equal(leaks[0].length, 18);
});

test("占位符可以回填", () => {
  assert.equal(result.restore("‹NAME_1›"), "牛广");
  assert.equal(result.restore("‹PHONE_1›"), "13770935407");
});
