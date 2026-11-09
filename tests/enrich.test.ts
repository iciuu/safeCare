import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAiClauses, planStructuredRows, quoteMatches, selectClauses } from "../lib/ai/enrich";

type ClauseRow = {
  id: number;
  seq: number;
  clause_no: string | null;
  heading_path: string | null;
  category: string | null;
  text: string;
  page_from: number;
};

const clause: ClauseRow = {
  id: 7,
  seq: 5,
  clause_no: "2.5",
  heading_path: "2 我们保多久、保什么 > 2.5 保险责任",
  category: "coverage",
  text: "在本合同有效期内，我们承担如下保险责任：年度给付限额为 400 万元。未以社保身份就诊的，给付比例为 60%。",
  page_from: 10,
};

test("引文能反查：原文包含即通过", () => {
  assert.equal(quoteMatches(clause.text, "年度给付限额为 400 万元"), true);
});

test("引文反查容忍空格与标点差异", () => {
  assert.equal(quoteMatches(clause.text, "年度给付限额为400万元"), true);
});

test("改写过的引文不通过", () => {
  assert.equal(quoteMatches(clause.text, "每年最多可以报销四百万"), false);
});

test("太短的引文不算证据", () => {
  assert.equal(quoteMatches(clause.text, "400"), false);
});

test("幻觉字段被丢弃，合规字段保留并回填占位符", () => {
  const redacted = new Map([["2.5", clause.text]]);
  const data = {
    clauses: [
      {
        clause_no: "2.5",
        kind: "coverage",
        summary: "年度 400 万，社保外 60%",
        facts: [
          {
            type: "limit",
            label: "年度给付限额",
            value: "400",
            unit: "万元",
            condition: "",
            quote: "年度给付限额为 400 万元",
          },
          {
            type: "ratio",
            label: "社保外比例",
            value: "60",
            unit: "%",
            condition: "未以社保身份就诊",
            quote: "未以社保身份就诊的，给付比例为 90%",
          },
        ],
      },
      {
        clause_no: "9.9",
        kind: "coverage",
        summary: "不存在的小节",
        facts: [],
      },
    ],
  };

  const result = normalizeAiClauses(data, [clause], redacted, (value) => value);

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].facts.length, 1);
  assert.equal(result.rows[0].facts[0].label, "年度给付限额");
  assert.equal(result.rows[0].review, "ok");
  // 一条引文伪造 + 一条不存在的小节
  assert.equal(result.rejected, 2);
});

test("一条要点都没验证通过的条款标待复核", () => {
  const result = normalizeAiClauses(
    {
      clauses: [
        {
          clause_no: "2.5",
          kind: "coverage",
          summary: "",
          facts: [{ type: "limit", label: "限额", value: "1000", unit: "万元", quote: "限额为一千万元" }],
        },
      ],
    },
    [clause],
    new Map([["2.5", clause.text]]),
    (value) => value,
  );

  assert.equal(result.rows[0].facts.length, 0);
  assert.equal(result.rows[0].review, "needs_review");
});

test("AI 要点落到责任/免责表", () => {
  const plan = planStructuredRows([
    {
      clause_id: 7,
      kind: "exclusion",
      review_status: "ok",
      facts: [
        {
          type: "exclusion",
          label: "故意行为免责",
          value: "不承担给付保险金责任",
          unit: "",
          condition: "",
          quote: "故意伤害",
        },
      ],
    },
    {
      clause_id: 8,
      kind: "limit",
      review_status: "ok",
      facts: [
        { type: "limit", label: "年度限额", value: "400", unit: "万元", condition: "每保单年度", quote: "400 万元" },
      ],
    },
  ]);

  assert.equal(plan.exclusions.length, 1);
  assert.equal(plan.exclusions[0].text, "故意行为免责：不承担给付保险金责任");
  assert.equal(plan.exclusions[0].citation_clause_id, 7);

  assert.equal(plan.terms.length, 1);
  assert.equal(plan.terms[0].kind, "limit");
  assert.equal(plan.terms[0].value, "400 万元 每保单年度");
});

test("选送条款：只送关键类别，按优先级截断", () => {
  const rows: ClauseRow[] = [
    { ...clause, id: 1, seq: 1, clause_no: "1", category: "other" },
    { ...clause, id: 2, seq: 2, clause_no: "1.1", category: "premium" },
    { ...clause, id: 3, seq: 3, clause_no: "2.5", category: "coverage" },
    { ...clause, id: 4, seq: 4, clause_no: "3.1", category: "exclusion" },
  ];

  const selected = selectClauses(rows, 2);
  assert.deepEqual(
    selected.map((row) => row.clause_no),
    ["2.5", "3.1"],
  );
});
