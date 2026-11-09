import assert from "node:assert/strict";
import test from "node:test";
import {
  lastAmountInReasoning,
  normalizeClaimAnalysis,
  prepareClaimMessages,
  type ClaimContext,
} from "../lib/ai/claim";
import type { EstimateInput } from "../lib/estimate";

const context: ClaimContext = {
  benefitName: "一般医疗保险金",
  scopes: ["普通部"],
  clauses: [
    {
      clauseNo: "附表1",
      page: 43,
      text: [
        "一般医疗保险金 普通部",
        "对于被保险人实际发生的属于本合同保险责任范围内的医疗费用金额扣除其从基本医疗保险、公费医疗、政府主办补充医疗取得的医疗费用补偿金额之后的余额累计不超过 5000 元的部分（含本数），给付比例为 80%。",
        "对于上述余额累计超过 5000 元的部分，给付比例为 100%。",
        "保险期间内给付限额：各项保险金累计给付总限额 400 万元。",
      ].join("\n"),
    },
    {
      clauseNo: "2.6",
      page: 15,
      text: "本合同医疗保险金的给付性质为费用补偿型。若被保险人已通过其他途径获得补偿，我们给付的金额不得超过实际发生的医疗费用扣除已获补偿后的余额。",
    },
  ],
};

const input: EstimateInput = {
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
};

test("提示词带上本次情况与条款原文，且不泄露本地算出的金额", () => {
  const prepared = prepareClaimMessages(input, context);
  const user = prepared.messages[1]?.content ?? "";

  assert.equal(prepared.messages.length, 2);
  assert.ok(user.includes("责任范围内医疗费用：32,000 元"));
  assert.ok(user.includes("社保 / 公费 / 补充医疗已补偿：12,000 元"));
  assert.ok(user.includes("<<<CLAUSE 附表1 · P43>>>"));
  assert.ok(user.includes("<<<CLAUSE 2.6 · P15>>>"));
  assert.ok(user.includes("给付比例为 80%"));
  // 独立判断：不把本地结果给模型，避免照抄
  assert.ok(!user.includes("19,000"));
  assert.deepEqual([...prepared.redactedByNo.keys()], ["附表1", "2.6"]);
});

test("出口脱敏：条款里的证件号换成占位符，并能回填", () => {
  const withId: ClaimContext = {
    ...context,
    clauses: [
      {
        clauseNo: "附表1",
        page: 43,
        text: "被保险人身份证号 110105199003071234 的保单，给付比例为 80%。",
      },
    ],
  };

  const prepared = prepareClaimMessages(input, withId);
  const user = prepared.messages[1]?.content ?? "";
  assert.ok(!user.includes("110105199003071234"));
  assert.ok(user.includes("‹ID_1›"));
  assert.equal(prepared.restore("证件 ‹ID_1›"), "证件 110105199003071234");
});

test("解析模型输出：引文反查不过就丢，未知条款号也丢", () => {
  const prepared = prepareClaimMessages(input, context);
  const data = {
    verdict: "partly",
    payable: 19_000,
    reasoning: ["先扣掉社保已报的 12,000 元，再按 5000 元分两段计算。"],
    conditions: ["必须在普通部就诊"],
    citations: [
      {
        clause_no: "附表1",
        quote: "余额累计不超过 5000 元的部分（含本数），给付比例为 80%",
      },
      { clause_no: "附表1", quote: "本产品还报销牙齿矫正费用" },
      { clause_no: "9.9", quote: "任意内容不低于四个字" },
    ],
  };

  const analysis = normalizeClaimAnalysis(
    data,
    context,
    prepared.redactedByNo,
    prepared.restore,
    input.totalCost,
  );

  assert.equal(analysis.verdict, "partly");
  assert.equal(analysis.payable, 19_000);
  assert.equal(analysis.citations.length, 1);
  assert.deepEqual(
    { clauseNo: analysis.citations[0]?.clauseNo, page: analysis.citations[0]?.page },
    { clauseNo: "附表1", page: 43 },
  );
  assert.equal(analysis.rejected, 2);
  assert.deepEqual(analysis.conditions, ["必须在普通部就诊"]);
});

test("金额封顶在当天费用总额，未知 verdict 归为 uncertain", () => {
  const prepared = prepareClaimMessages(input, context);
  const analysis = normalizeClaimAnalysis(
    { verdict: "maybe", payable: 999_999, reasoning: [], conditions: [], citations: [] },
    context,
    prepared.redactedByNo,
    prepared.restore,
    input.totalCost,
  );

  assert.equal(analysis.verdict, "uncertain");
  assert.equal(analysis.payable, 32_000);
});

test("推理最后算出的金额和 payable 不一致时，单独标出来", () => {
  const prepared = prepareClaimMessages(input, context);
  const mismatched = normalizeClaimAnalysis(
    {
      verdict: "partly",
      payable: 20_000,
      reasoning: ["5000×80% + 15000×100% = 19000 元。"],
      citations: [],
    },
    context,
    prepared.redactedByNo,
    prepared.restore,
    input.totalCost,
  );
  assert.equal(mismatched.payableInReasoning, 19_000);

  const consistent = normalizeClaimAnalysis(
    {
      verdict: "partly",
      payable: 19_000,
      reasoning: ["5000×80% + 15000×100% = 19000 元。"],
      citations: [],
    },
    context,
    prepared.redactedByNo,
    prepared.restore,
    input.totalCost,
  );
  assert.equal(consistent.payableInReasoning, null);
});

/** 「400万元」是限额，不能当成结论金额。 */
test("带万字的限额数字不参与一致性比对", () => {
  assert.equal(lastAmountInReasoning(["未超每期限额 400万元，本次赔付 19000 元。"]), 19_000);
});

test("模型没给金额时保持 null，不编一个数", () => {
  const prepared = prepareClaimMessages(input, context);
  const analysis = normalizeClaimAnalysis(
    { verdict: "uncertain", payable: null, reasoning: ["条款未写这一项"], citations: [] },
    context,
    prepared.redactedByNo,
    prepared.restore,
    input.totalCost,
  );

  assert.equal(analysis.payable, null);
  assert.deepEqual(analysis.reasoning, ["条款未写这一项"]);
});
