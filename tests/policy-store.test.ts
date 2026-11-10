import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { DDL } from "../lib/db";
import { deletePolicyDocument, listPolicies, resolveElement, updatePolicyMeta } from "../lib/policy-store";

/** 一份医疗险保单：1 条条款 + 1 条 AI 要点 + 1 项责任（待复核）。 */
function seed(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(DDL);

  db.prepare(
    "INSERT INTO document (id, sha256, filename, byte_size, page_count, clause_count, has_text_layer) VALUES (1, 'abc', 'heart.pdf', 1024, 50, 1, 1)",
  ).run();
  db.prepare(
    "INSERT INTO policy (id, document_id, category, insurer, product_name, policy_no, data) VALUES (1, 1, 'medical', '人保寿险', '关爱 e 生 2.0', 'P123', ?)",
  ).run(
    JSON.stringify({
      insured_name: "被保人甲",
      holder_name: "投保人乙",
      effective_from: "2025-06-01",
      effective_to: "2026-05-31",
      premium: 3260,
      benefit_table: { annual_limit: 4_000_000, waiting_days: 90 },
    }),
  );
  db.prepare(
    "INSERT INTO clause (id, document_id, seq, page_from, page_to, clause_no, text) VALUES (1, 1, 0, 10, 10, '2.5', '一般医疗保险金')",
  ).run();
  db.prepare(
    "INSERT INTO coverage (policy_id, name, data, review_status) VALUES (1, '一般医疗保险金', '{}', 'needs_review')",
  ).run();
  db.prepare(
    "INSERT INTO clause_ai (clause_id, model, kind, data, review_status) VALUES (1, 'deepseek-chat', 'liability', '{}', 'needs_review')",
  ).run();
  db.prepare(
    "INSERT INTO policy_element (document_id, policy_id, kind, category, label, value, unit, quote, page_no, review_status, source, dedupe_key) VALUES (1, 1, 'term', 'limit', '年度限额', '400', '万元', '限额400万元', 10, 'needs_review', 'ai', 'k1')",
  ).run();

  return db;
}

test("保单管理列表带上抽取出的关键信息与待复核数", () => {
  const [policy] = listPolicies(seed());
  assert.ok(policy);
  assert.equal(policy.documentId, 1);
  assert.equal(policy.policyId, 1);
  assert.equal(policy.category, "medical");
  assert.equal(policy.insuredName, "被保人甲");
  assert.equal(policy.waitingDays, 90);
  assert.equal(policy.annualLimit, 4_000_000);
  assert.equal(policy.coverageCount, 1);
  assert.equal(policy.aiFacts, 1);
  assert.equal(policy.needsReview, 1); // 有要素时只看要素冲突（与详情页同口径）
});

test("手工修正保单信息写回列和 data，并覆盖快照字段", () => {
  const db = seed();
  const saved = updatePolicyMeta(db, 1, {
    category: "life",
    insurer: "中国人寿",
    productName: "定期寿险",
    policyNo: "P999",
    holderName: "投保人乙",
    insuredName: "被保人丙",
    effectiveFrom: "2026-01-01",
    effectiveTo: "2036-12-31",
  });
  assert.equal(saved, true);

  const [policy] = listPolicies(db);
  assert.equal(policy?.category, "life");
  assert.equal(policy?.productName, "定期寿险");
  assert.equal(policy?.insuredName, "被保人丙");
  assert.equal(policy?.effectiveTo, "2036-12-31");
  // 没改的字段（保费）要留着
  assert.equal(policy?.premium, 3260);

  assert.equal(updatePolicyMeta(db, 404, {
    category: "medical",
    insurer: null,
    productName: null,
    policyNo: null,
    holderName: null,
    insuredName: null,
    effectiveFrom: null,
    effectiveTo: null,
  }), false);
});

test("删除保单时条款、责任、要点一起清掉", () => {
  const db = seed();
  assert.equal(deletePolicyDocument(db, 1), true);

  const count = (table: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  assert.equal(count("document"), 0);
  assert.equal(count("policy"), 0);
  assert.equal(count("clause"), 0);
  assert.equal(count("clause_ai"), 0);
  assert.equal(count("policy_element"), 0);
  assert.equal(count("coverage"), 0);
  assert.equal(deletePolicyDocument(db, 1), false);
});

test("待复核要素：确认后退出待复核，并留下一条改动记录", () => {
  const db = seed();
  const elementId = 1;
  assert.equal(resolveElement(db, { documentId: 1, elementId, action: "confirm" }), true);

  const row = db.prepare("SELECT review_status, label, value FROM policy_element WHERE id = ?").get(elementId) as {
    review_status: string;
    label: string;
    value: string;
  };
  assert.equal(row.review_status, "ok");
  assert.equal(row.label, "年度限额");
  assert.equal(row.value, "400");

  const review = db.prepare("SELECT action, before_json FROM element_review WHERE element_id = ?").get(elementId) as {
    action: string;
    before_json: string;
  };
  assert.equal(review.action, "confirm");
  assert.match(review.before_json, /needs_review/);
});

test("待复核要素：修正同时改值和状态，忽略后不再计入列表", () => {
  const db = seed();
  assert.equal(
    resolveElement(db, {
      documentId: 1,
      elementId: 1,
      action: "save",
      label: "年度限额",
      value: "300",
      unit: "万元",
    }),
    true,
  );
  const saved = db.prepare("SELECT review_status, value, unit FROM policy_element WHERE id = 1").get() as {
    review_status: string;
    value: string;
    unit: string;
  };
  assert.deepEqual({ ...saved }, { review_status: "ok", value: "300", unit: "万元" });

  assert.equal(resolveElement(db, { documentId: 1, elementId: 1, action: "ignore" }), true);
  const ignored = db.prepare("SELECT review_status FROM policy_element WHERE id = 1").get() as { review_status: string };
  assert.equal(ignored.review_status, "ignored");
  assert.equal(listPolicies(db)[0].aiFacts, 0);
});

test("待复核要素：documentId 对不上就不动", () => {
  const db = seed();
  assert.equal(resolveElement(db, { documentId: 2, elementId: 1, action: "confirm" }), false);
  const row = db.prepare("SELECT review_status FROM policy_element WHERE id = 1").get() as { review_status: string };
  assert.equal(row.review_status, "needs_review");
});
