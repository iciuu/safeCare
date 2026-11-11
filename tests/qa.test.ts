import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { DDL } from "../lib/db";
import { answerQuestion, normalizeQaAnswer, retrieveClauses } from "../lib/qa";
import { searchClauses, searchTokens } from "../lib/search";

/** 两份保单、四条条款：住院前后门急诊、免责、免赔额、寿险保额。 */
function seed(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(DDL);

  db.prepare(
    "INSERT INTO document (id, sha256, filename, byte_size, page_count, clause_count, has_text_layer) VALUES (1, 'a', 'medical.pdf', 1024, 20, 3, 1)",
  ).run();
  db.prepare(
    "INSERT INTO document (id, sha256, filename, byte_size, page_count, clause_count, has_text_layer) VALUES (2, 'b', 'life.pdf', 1024, 8, 1, 1)",
  ).run();

  db.prepare(
    "INSERT INTO policy (document_id, category, insurer, product_name, data) VALUES (1, 'medical', '人保寿险', '关爱 e 生', '{}')",
  ).run();
  db.prepare(
    "INSERT INTO policy (document_id, category, insurer, product_name, data) VALUES (2, 'life', '华贵人寿', '大麦定期寿险', '{}')",
  ).run();

  const insert = db.prepare(
    "INSERT INTO clause (document_id, seq, page_from, page_to, clause_no, heading_path, category, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insert.run(
    1,
    0,
    10,
    10,
    "2.3",
    "第二章 > 2.3 住院前后门急诊",
    "coverage",
    "本合同对被保险人在住院前七日内及出院后三十日内的门急诊医疗费用，按百分之百给付。",
  );
  insert.run(
    1,
    1,
    12,
    12,
    "3.1",
    "第三章 > 3.1 责任免除",
    "exclusion",
    "被保险人在等待期内因疾病住院的，本公司不承担保险责任。",
  );
  insert.run(
    1,
    2,
    14,
    14,
    "5.2",
    "第五章 > 5.2 免赔额",
    "limit",
    "本合同年度免赔额为一万元，经社保结算后按百分之百赔付。",
  );
  insert.run(
    2,
    0,
    3,
    3,
    "1.1",
    "第一章 > 1.1 保险金额",
    "coverage",
    "本合同的身故保险金额为五十万元。",
  );

  return db;
}

test("中文按二元组切词，英文数字整段保留", () => {
  const tokens = searchTokens("住院前门急诊，共 400 元");
  for (const expected of ["住院", "院前", "前门", "门急", "急诊", "400", "元"]) {
    assert.ok(tokens.includes(expected), `缺少 ${expected}：${tokens.join(",")}`);
  }
  // 单字不会被拆成空串
  assert.deepEqual(searchTokens("保"), ["保"]);
});

test("检索能按问题找到对应条款，并按相关度把命中排前面", () => {
  const hits = searchClauses(seed(), "住院前七天的门诊检查费用能报吗");
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].clauseNo, "2.3");
  assert.equal(hits[0].page, 10);
  assert.equal(hits[0].productName, "关爱 e 生");
  // 无关的寿险条款不该被捞回来
  assert.ok(!hits.some((hit) => hit.documentId === 2));
});

test("条款增删之后索引会自动对齐，不需要手动重建", () => {
  const db = seed();
  assert.ok(searchClauses(db, "住院前后的门急诊").length > 0);

  db.prepare(
    "INSERT INTO clause (document_id, seq, page_from, page_to, clause_no, heading_path, category, text) VALUES (1, 3, 20, 20, '6.1', '第六章 > 6.1 质子重离子', 'coverage', '本合同质子重离子医疗费用按百分之百给付。')",
  ).run();
  db.prepare("UPDATE document SET clause_count = 4 WHERE id = 1").run();

  const hits = searchClauses(db, "质子重离子怎么赔");
  assert.equal(hits[0]?.clauseNo, "6.1");
});

test("检索可以用 documentId 收窄到某一份保单", () => {
  const db = seed();
  assert.deepEqual(searchClauses(db, "保险金额是多少", { documentId: 1 }), []);
  const hits = searchClauses(db, "保险金额是多少", { documentId: 2 });
  assert.equal(hits[0]?.clauseNo, "1.1");
});

test("问题太短或完全无关时检索为空", () => {
  const db = seed();
  assert.deepEqual(retrieveClauses(db, "报"), []);
  assert.deepEqual(retrieveClauses(db, "今天天气怎么样"), []);
});

test("检索不到就不调用模型，直接拒答", async () => {
  const answer = await answerQuestion(seed(), "今天天气怎么样");
  assert.equal(answer.kind, "refused");
  assert.equal(answer.reason, "no-match");
  assert.equal(answer.tokens, 0);
  assert.deepEqual(answer.citations, []);
});

test("编造的引文会被丢掉，模型说不够时不给结论", () => {
  const hits = searchClauses(seed(), "免赔额是多少");
  assert.ok(hits.length > 0);

  const redacted = new Map(hits.map((hit, index) => [`C${index + 1}`, hit.text] as const));
  const restore = (value: string) => value;

  const fabricated = normalizeQaAnswer(
    {
      sufficient: true,
      points: ["免赔额为零"],
      citations: [{ ref: "C1", quote: "免赔额为零，全部赔付" }],
    },
    hits,
    redacted,
    restore,
  );
  assert.equal(fabricated.citations.length, 0);
  assert.equal(fabricated.rejected, 1);

  const insufficient = normalizeQaAnswer(
    {
      sufficient: false,
      points: ["随便下个结论"],
      citations: [{ ref: "C1", quote: hits[0].text.slice(0, 20) }],
    },
    hits,
    redacted,
    restore,
  );
  assert.equal(insufficient.sufficient, false);
  assert.deepEqual(insufficient.points, []);
});

test("引文是真的但编号给错时，归到真正包含这句原文的条款上", () => {
  const hits = searchClauses(seed(), "免赔额是多少");
  const quote = "本合同年度免赔额为一万元";
  assert.ok(hits.some((hit) => hit.text.includes(quote)));

  const redacted = new Map(hits.map((hit, index) => [`C${index + 1}`, hit.text] as const));
  const normalized = normalizeQaAnswer(
    { sufficient: true, points: ["年度免赔额一万元"], citations: [{ ref: "C9", quote }] },
    hits,
    redacted,
    (value) => value,
  );

  assert.equal(normalized.citations.length, 1);
  assert.equal(normalized.citations[0].clauseNo, "5.2");
  assert.equal(normalized.citations[0].page, 14);
});
