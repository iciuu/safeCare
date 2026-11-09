import assert from "node:assert/strict";
import test from "node:test";
import { extractPolicyMeta } from "../lib/policy-meta";
import type { PageText } from "../lib/segmentation";

/** 按真实保单的字段排布构造；姓名与证件号用假数据。 */
const pages: PageText[] = [
  {
    page_no: 3,
    text: `致客户的一封信
尊敬的客户：
中国人民人寿保险股份有限公司
2026年11月08日`,
  },
  {
    page_no: 4,
    text: `首期/一次交清保险费合计：壹仟零壹拾伍圆整 （RMB1,015.00）
保险合同号：016968397114158
投保单号：016968397114158
合同成立日期：2025年11月07日
合同生效日期：2026年11月08日零时零分
投保人：张三
证件类型：居民身份证
证件号码：110101199001010000
被保险人：李四
证件类型：户口簿
1.人保寿险关爱e生2.0少儿长期医
疗保险（费率可调）（互联网专
属）
至2027年11月08 日零时止
1年
第1页，共44页`,
  },
  {
    page_no: 6,
    text: `阅读指引
犹豫期：自您签收本合同之日起，有 15 日的犹豫期。
等待期：自本合同生效之日起 90 日内被保险人发生疾病，由此导致治疗的，我们均不承担给付保险金的责任。
条款正文第 1 页 /共 37 页
人保寿险关爱 e 生 2.0 少儿长期医疗保险
（费率可调）（互联网专属）条款
本产品为费率可调的长期医疗保险产品。`,
  },
];

const meta = extractPolicyMeta(pages);

test("保单号与保险公司", () => {
  assert.equal(meta.policy_no, "016968397114158");
  assert.equal(meta.insurer, "中国人民人寿保险股份有限公司");
});

test("投保人与被保险人不会把「投保单号」误识别成投保人", () => {
  assert.equal(meta.holder_name, "张三");
  assert.equal(meta.insured_name, "李四");
});

test("日期统一成 ISO，保险期间来自「至…止」", () => {
  assert.equal(meta.effective_from, "2026-11-08");
  assert.equal(meta.effective_to, "2027-11-08");
});

test("保费取 RMB 金额并去掉千分位", () => {
  assert.equal(meta.premium, 1015);
});

test("等待期与犹豫期", () => {
  assert.equal(meta.waiting_days, 90);
  assert.equal(meta.hesitation_days, 15);
});

test("产品名由条款册首页两行拼接、去掉结尾「条款」", () => {
  assert.ok(meta.product_name?.includes("人保寿险关爱"));
  assert.ok(meta.product_name?.includes("少儿长期医疗保险"));
  assert.ok(meta.product_name?.includes("（费率可调）（互联网专属）"));
  assert.ok(!meta.product_name?.endsWith("条款"));
});

test("险种按产品名判定：品牌里的「寿险」不能覆盖「医疗」", () => {
  assert.equal(meta.category, "medical");
});

test("缺少字段时返回 null 且不抛错", () => {
  const empty = extractPolicyMeta([{ page_no: 1, text: "随便一份文档" }]);
  assert.equal(empty.policy_no, null);
  assert.equal(empty.premium, null);
  assert.equal(empty.category, "unknown");
  assert.equal(empty.product_name, null);
});
