import assert from "node:assert/strict";
import test from "node:test";
import type { PageText } from "../lib/segmentation";
import { checkToc, extractTocClauseNos } from "../lib/toc";

/** 目录页在真实保单里是小节号并排排版，一行挤好几个。 */
const pages: PageText[] = [
  {
    page_no: 8,
    text: `第4页，共44页
条款目录
1.1 合同构成 1.2 合同成立与生效
2.1 保险期间 2.2 保证续保 2.3 保险金额与给付限额
3.1 责任免除 3.2 其他免责或重大利害关系条款
第5页，共44页
条款正文第 1 页 /共 37 页
1 合同的构成与生效
这部分讲的是本合同包括哪些部分。`,
  },
];

test("目录里并排的小节号都能抽出来", () => {
  assert.deepEqual(extractTocClauseNos(pages), ["1.1", "1.2", "2.1", "2.2", "2.3", "3.1", "3.2"]);
});

test("遇到条款册页眉就停止，不把正文当目录", () => {
  const numbers = extractTocClauseNos(pages);
  assert.ok(!numbers.includes("1"));
  assert.equal(numbers.length, 7);
});

test("对账能指出漏切的小节", () => {
  const check = checkToc(pages, ["1", "1.1", "1.2", "2", "2.1", "2.2", "3", "3.1"]);
  assert.deepEqual(check.missing, ["2.3", "3.2"]);
  assert.deepEqual(check.extra, []);
  assert.equal(check.matched, 5);
  assert.equal(check.expected.length, 7);
});

test("切出目录里没有的编号算错号", () => {
  const check = checkToc(pages, ["1.1", "1.2", "2.1", "2.2", "2.3", "2.4", "3.1", "3.2"]);
  assert.deepEqual(check.missing, []);
  assert.deepEqual(check.extra, ["2.4"]);
});

test("没有目录的文档不产生虚假期望", () => {
  const check = checkToc([{ page_no: 1, text: "随便一份文档" }], ["1.1"]);
  assert.deepEqual(check.expected, []);
  assert.deepEqual(check.missing, []);
});
