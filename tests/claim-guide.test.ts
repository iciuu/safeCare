import assert from "node:assert/strict";
import test from "node:test";
import { buildClaimGuide, hasClaimGuide } from "../lib/claim-guide";

/** 取自真实合同的片段（换行和双栏错位都保留原样）。 */
const NOTICE = `5.2 保险事故通知
保险事故通您、被保险人或受益人知道保险事故发生后应当及时通知我们。
知如果您、被保险人或受益人故意或者因重大过失未及时通知，致使保险事故的性
质、原因、损失程度等难以确定的，我们对无法确定的部分不承担保险责任。`;

const MATERIALS = `5.3 保险金申请
保险金申请 申请保险金时，由相应保险金受益人作为申请人填写保险金给付申请书，并提供
下列证明和资料：
（1）保险合同；
（2）申请人及被保险人的有效身份证件；
（3）我们认可的医院出具的医疗诊断书、医疗病历或出入院小结、检查检验报告；
（4）所能提供的与确认保险事故的性质、原因、伤害程度等有关的其他证明和资料。
以上证明和资料不完整的，我们将在 2 个工作日内一次性通知申请人补充提供有关证明和资料。`;

const PAYOUT = `5.4 保险金给付 保险金给付
我们在收到保险金给付申请书及合同约定的证明和资料后，将在 5 个工作日内作出核定；
情形复杂的，在 30 日内作出核定。经我们核定属于保险责任的，我们在与受益人达成
有关给付保险金数额的协议后 10 日内，履行给付保险金义务。对不属于保险责任的，
我们自作出核定之日起 3 日内向受益人发出拒绝给付保险金通知书，并说明理由。`;

function clause(clauseNo: string, page: number, text: string) {
  return { clause_no: clauseNo, page_from: page, heading_path: null, text };
}

test("理赔流程：报案、材料、核定时限都从原文里来，且各带页码", () => {
  const guide = buildClaimGuide([clause("5.2", 20, NOTICE), clause("5.3", 20, MATERIALS), clause("5.4", 21, PAYOUT)]);

  assert.equal(guide.notify?.text, "及时通知（合同没写具体天数，越早越好）");
  assert.equal(guide.notify?.days, null);
  assert.equal(guide.notify?.source.page, 20);

  assert.deepEqual(
    guide.materials.map((item) => item.text),
    [
      "保险合同",
      "申请人及被保险人的有效身份证件",
      "我们认可的医院出具的医疗诊断书、医疗病历或出入院小结、检查检验报告",
      "所能提供的与确认保险事故的性质、原因、伤害程度等有关的其他证明和资料。",
    ],
  );
  assert.ok(guide.materials.every((item) => item.source.page === 20 && item.source.clauseNo === "5.3"));
  assert.match(guide.materialsNote ?? "", /2\s*个工作日内一次性通知/);

  const values = guide.timeline.map((item) => `${item.label}=${item.value}`);
  assert.deepEqual(values, [
    "材料不全时通知补充=2 个工作日内一次性通知补充",
    "作出核定=5 个工作日内作出核定",
    "情形复杂的核定=情形复杂的 30 日内作出核定",
    "给付保险金=达成协议后 10 日内给付",
    "拒赔通知=3 日内发出拒赔通知并说明理由",
  ]);
  // 「材料不全时通知补充」写在第 5.3 条（P20），其余核定时限都在 5.4 条（P21）
  assert.equal(guide.timeline[0].source.page, 20);
  assert.ok(guide.timeline.slice(1).every((item) => item.source.page === 21));
});

test("理赔流程：报案时限只认讲事故通知的那句，别把拒赔的 3 日当成报案期限", () => {
  const withDeadline = `保险事故通知
您应当在知道保险事故发生之日起 10 日内通知我们，否则我们对无法确定的部分不承担责任。`;
  const guide = buildClaimGuide([clause("5.2", 3, withDeadline), clause("5.3", 4, PAYOUT)]);
  assert.equal(guide.notify?.text, "10 日内通知保险公司");
  assert.equal(guide.notify?.days, 10);
});

test("理赔流程：条款写的期限优先于后面的理赔服务指南", () => {
  const pages = [
    clause("第十一条", 25, "第十一条 保险事故通知\n您、被保险人或受益人知道保险事故发生后应当在十日内通知我们。"),
    clause("第十一条", 121, "理赔服务指南\n出险报案若被保险人不幸发生保险事故，请在三日内向我司报案，以便为您提供服务。"),
  ];
  const guide = buildClaimGuide(pages);
  assert.equal(guide.notify?.text, "10 日内通知保险公司");
  assert.equal(guide.notify?.source.page, 25);
});

test("理赔流程：中文序号的材料清单也能切（（一）（二）（三））", () => {
  const chinese = `第十二条 保险金申请
申请保险金时，由相应保险金受益人作为申请人填写保险金给付申请书，并提供下列证明和资
料：
一、重大疾病保险金申请所需的证明和资料
（一）保险合同；
（二）申请人及被保险人的有效身份证件；
（三）由我们认可的医院出具的确诊本主险合同定义的重大疾病的证明材料；
（四）其他证明和资料。`;
  const guide = buildClaimGuide([clause("12", 25, chinese)]);
  assert.equal(guide.materials.length, 4);
  assert.equal(guide.materials[0].text, "保险合同");
  assert.match(guide.materials[2].text, /确诊本主险合同定义的重大疾病/);
});

test("理赔流程：中文数字的报案期限也认（十日内）", () => {
  const guide = buildClaimGuide([
    clause("第十一条", 25, "第十一条 保险事故通知\n您应当在知道保险事故发生后十日内通知我们。"),
  ]);
  assert.equal(guide.notify?.days, 10);
});

test("理赔流程：疾病定义里的分条条件不算理赔材料", () => {
  const definition = `重大疾病
指经专科医生确诊的下列疾病，须同时符合下列条件：
（1）由我们认可的医院中设有专门血液病专科的公立三级甲等医院确诊；
（2）骨髓穿刺或骨髓活检结果支持诊断；
（3）被保险人已持续接受一个月以上的化疗或已接受骨髓移植治疗。`;
  const guide = buildClaimGuide([clause("9.1", 23, definition)]);
  assert.deepEqual(guide.materials, []);
  assert.equal(hasClaimGuide(guide), false);
});

test("理赔流程：没有条款正文的文件返回空，不瞎猜", () => {
  const guide = buildClaimGuide([]);
  assert.equal(guide.notify, null);
  assert.deepEqual(guide.materials, []);
  assert.deepEqual(guide.timeline, []);
  assert.equal(guide.hotline, null);
  assert.equal(hasClaimGuide(guide), false);
});
