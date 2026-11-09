import assert from "node:assert/strict";
import test from "node:test";
import { segmentPolicy, type PageText } from "../lib/segmentation";

/**
 * fixture 按真实保单的排版结构构造（人保寿险少儿长期医疗险）：
 * 页眉页脚、十进制编号、跨行标题、页码脚注、正文里的「1 年」。
 * 内容为缩写，结构逐行对齐原文。
 */
const pages: PageText[] = [
  {
    page_no: 5,
    text: `条款正文第 1 页 /共 37 页
人保寿险关爱 e 生 2.0 少儿长期医疗保险
（费率可调）（互联网专属）条款
本产品为费率可调的长期医疗保险产品，在保证续保期间内费率可能调整。
1 合同的构成与生效
这部分讲的是本合同包括哪些部分，以及在什么时候生效。
1.1 合同构成
本合同由本保险条款、保险单或其他保险凭证共同构成。
1.2 合同成立与
生效
您提出保险申请且我们同意承保，本合同成立。
1 保单生效对应日：本合同生效日每年的对应日为保单年生效对应日。
2 保险费约定支付日：分期支付保险费的，首期保险费后的半年交、季交或月交保险费约定支付日分别为本合同的保单半年生效对应日。
第5页，共44页`,
  },
  {
    page_no: 6,
    text: `条款正文第 2 页 /共 37 页
2 我们保多久、保什么
这部分讲的是我们提供保障的期间以及我们提供的保障。
2.1 保险期间
本合同的保险期间为 1 年，自本合同生效日零时起算。
2.2 保证续保
本合同是费率可调的保证续保型医疗保险合同。
2.3 保险金额与
给付限额
本合同的保险金额为 400 万元。
（一）保险金额
其中重大疾病关爱保险金额为 1 万元。
1 年
2.4 等待期
自本合同生效之日起 90 日内被保险人发生疾病，我们均不承担给付保险金的责任。
第6页，共44页`,
  },
  {
    page_no: 7,
    text: `条款正文第 3 页 /共 37 页
2.5 保险责任
在本合同有效期内，我们承担如下保险责任：
一般医疗保
险金
被保险人于等待期后，在我们认可的医院的普通部接受治疗的，我们按约定给付一般医疗保险金。
3 我们不保什么
3.1 责任免除
因下列情形之一导致被保险人发生医疗费用的，我们不承担给付保险金的责任。
（1）您对被保险人的故意杀害、故意伤害；
3.2 其他免责或
重大利害关
系条款
除“3.1 责任免除”外，本合同中还有一些免除本公司责任的条款。
第7页，共44页`,
  },
  {
    page_no: 8,
    text: `条款正文第 4 页 /共 37 页
4 如何支付保险费
4.1 保险费的支付
您应按本合同约定交纳保险费。
5 如何领取保险金
5.1 受益人
本合同的受益人为被保险人本人。
6 如何退保
6.1 犹豫期
自您签收本合同之日起有 15 日的犹豫期。
7 其他权益
7.1 现金价值
现金价值按保单年度列示。
8 需关注的其他事项
8.1 明确说明与如实告知
我们就您和被保险人的有关情况提出询问的，您应当如实告知。
第8页，共44页`,
  },
  {
    page_no: 9,
    text: `条款正文第 5 页 /共 37 页
9 定义
9.1 重大疾病定义
恶性肿瘤——重度指恶性细胞不受控制的进行性增长和扩散的疾病。
9.2 “恶性肿瘤——轻度”定义
指不符合“恶性肿瘤——重度”定义的情形。
第9页，共44页`,
  },
];

const { clauses, stats } = segmentPolicy(pages);
const byNo = new Map(clauses.map((clause) => [clause.clause_no, clause]));

test("从条款册页眉开始切分，页码脚注被剔除", () => {
  assert.equal(stats.found_book, true);
  assert.ok(!clauses.some((clause) => clause.text.includes("保单生效对应日：本合同生效日每年")));
  assert.ok(!clauses.some((clause) => clause.text.includes("共37页")));
});

test("按十进制编号切出全部条款", () => {
  assert.deepEqual(
    clauses.map((clause) => clause.clause_no),
    [
      "1", "1.1", "1.2",
      "2", "2.1", "2.2", "2.3", "2.4", "2.5",
      "3", "3.1", "3.2",
      "4", "4.1", "5", "5.1", "6", "6.1", "7", "7.1", "8", "8.1",
      "9", "9.1", "9.2",
    ],
  );
});

test("跨行标题被正确拼接", () => {
  assert.equal(byNo.get("1.2")?.heading, "合同成立与生效");
  assert.equal(byNo.get("2.3")?.heading, "保险金额与给付限额");
  assert.equal(byNo.get("3.2")?.heading, "其他免责或重大利害关系条款");
});

test("正文里的「1 年」不会被当成章节标题", () => {
  assert.equal(byNo.get("1")?.heading, "合同的构成与生效");
  assert.ok(!clauses.some((clause) => clause.heading === "年"));
  assert.ok(byNo.get("2.3")?.text.includes("1 年"));
});

test("分类命中关键章节", () => {
  assert.equal(byNo.get("2.5")?.category, "coverage");
  assert.equal(byNo.get("3.1")?.category, "exclusion");
  assert.equal(byNo.get("2.4")?.category, "waiting_period");
  assert.equal(byNo.get("2.3")?.category, "limit");
  assert.equal(byNo.get("9.1")?.category, "definition");
});

test("跨页条款记录页码范围", () => {
  assert.equal(byNo.get("2.5")?.page_from, 7);
  assert.equal(byNo.get("3.2")?.page_from, 7);
  assert.equal(byNo.get("9.2")?.page_from, 9);
});

test("覆盖率能反映漏切", () => {
  assert.ok(stats.coverage > 0.85, `coverage=${stats.coverage}`);
  assert.ok(stats.coverage <= 1);
});

test("编号与正文挤在同一行时也能切分（真实排版）", () => {
  const real: PageText[] = [
    {
      page_no: 9,
      text: `人保寿险关爱 e 生 2.0 少儿长期医疗保险
1 合同的构成与生效
1.1 合同构成 本合同由本保险条款、保险单或其他保险凭证共同构成。
1.2 合同成立与您提出保险申请且我们同意承保，本合同成立。
生效本合同成立、我们收取首期保险费并签发保险单为本合同的生效条件。
2 我们保多久、保什么
2.1 保险期间 本合同的保险期间为 1 年，在保险单上载明。
条款正文第 1 页 /共 37 页`,
    },
  ];

  // 页眉在页面末尾，但条款册要从这一页的第一行算起
  const result = segmentPolicy(
    real,
    new Map([
      ["1.1", "合同构成"],
      ["1.2", "合同成立与生效"],
      ["2.1", "保险期间"],
    ]),
  );

  assert.deepEqual(
    result.clauses.map((clause) => clause.clause_no),
    ["1", "1.1", "1.2", "2", "2.1"],
  );

  const c11 = result.clauses.find((clause) => clause.clause_no === "1.1");
  assert.equal(c11?.heading, "合同构成");
  assert.ok(c11?.text.includes("本合同由本保险条款"));

  // 标题被正文挤开时，标题取目录，正文原样保留
  const c12 = result.clauses.find((clause) => clause.clause_no === "1.2");
  assert.equal(c12?.heading, "合同成立与生效");
  assert.ok(c12?.text.includes("生效本合同成立"));
});

test("不是合同条款的 PDF 返回空结果，不误切", () => {
  const result = segmentPolicy([{ page_no: 1, text: "招标文件\n1 总则\n本项目不接受联合体投标。" }]);
  assert.equal(result.stats.found_book, false);
  assert.equal(result.clauses.length, 0);
});
