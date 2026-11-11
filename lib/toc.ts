import type { PageText } from "./segmentation";
import { cleanLine } from "./segmentation";

/**
 * 条款目录对账。
 *
 * 合同自带的「条款目录」页就是这份文件自己的金标准：
 * 目录里列了 N 个小节，切分结果也应该有这 N 个编号。
 * 漏条、错号都能自动暴露，不需要人工比对。
 */

export type TocCheck = {
  expected: string[];
  actual: string[];
  missing: string[];
  extra: string[];
  matched: number;
};

const TOC_HEADING = /^条款目录/;
const BOOK_HEADER = /^条款正文第\s*\d+\s*页/;

/** 目录里的小节号是并排排版的，一行可能挤着好几个：`1.1 合同构成 1.2 合同成立与生效`。 */
/**
 * 只取「条款目录」所在的那一页：条款册页眉排在页面末尾，
 * 跨页判断会把紧接的正文页（里面带着「关爱 e 生 2.0」）当成目录内容。
 */
function tocBlock(pages: PageText[]): string | null {
  const kept: string[] = [];
  let found = false;

  for (const page of pages) {
    const lines = page.text
      .split(/\r?\n/)
      .map(cleanLine)
      .filter((line) => line.length > 0);

    const start = lines.findIndex((line) => TOC_HEADING.test(line));
    if (start < 0) continue;
    found = true;

    for (let i = start + 1; i < lines.length; i += 1) {
      if (BOOK_HEADER.test(lines[i])) break;
      kept.push(lines[i]);
    }
  }

  return found ? kept.join("\n") : null;
}

/** 两列表格里章节号会串行：`88.3` 其实是 8.3，`99.1` 是 9.1。 */
function normalizeNo(chapter: string, section: string): string | null {
  const head = chapter.length === 2 && chapter[0] === chapter[1] ? chapter[0] : chapter;
  const value = Number(head);
  // 小节号从 .1 起，没有「第 0 节」；把「关爱 e 生 2.0」这种版本号挡在外面
  if (!Number.isInteger(value) || value < 1 || value > 20) return null;
  if (!Number.isInteger(Number(section)) || Number(section) < 1) return null;
  return `${head}.${section}`;
}

export function extractTocClauseNos(pages: PageText[]): string[] {
  const lines: string[] = [];
  for (const page of pages) {
    for (const raw of page.text.split(/\r?\n/)) {
      const text = cleanLine(raw);
      if (text) lines.push(text);
    }
  }

  const start = lines.findIndex((line) => TOC_HEADING.test(line));
  if (start < 0) return [];

  const numbers: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const text = lines[i];
    // 目录之后、条款正文之前的页脚要跳过，遇到条款册页眉就结束
    if (i > start && BOOK_HEADER.test(text)) break;
    if (i > start && TOC_HEADING.test(text)) continue;

    for (const match of text.matchAll(/(\d{1,2})\.(\d{1,2})(?![\d.])/g)) {
      const no = normalizeNo(match[1], match[2]);
      if (no) numbers.push(no);
    }
  }

  return [...new Set(numbers)];
}

export type TocEntry = { no: string; title: string | null };

/**
 * 目录里每个小节的标题：取本小节号到下一个编号之间的文字。
 * 排版是两列表格，章节号会串到行首（`88.3 年龄性别错误的处理`），
 * 所以尾部的数字要剔掉；落单的编号（如 2.7）标题会被拆到两行，做不到就不猜。
 */
export function extractTocEntries(pages: PageText[]): TocEntry[] {
  const block = tocBlock(pages);
  if (!block) return [];

  const matches = [...block.matchAll(/(\d{1,2})\.(\d{1,2})(?![\d.])/g)];
  const entries: TocEntry[] = [];
  const seen = new Set<string>();

  for (let k = 0; k < matches.length; k += 1) {
    const match = matches[k];
    const no = normalizeNo(match[1], match[2]);
    if (!no) continue;
    if (seen.has(no)) continue;
    seen.add(no);

    const from = (match.index ?? 0) + match[0].length;
    const nextIndex = k + 1 < matches.length ? matches[k + 1].index : undefined;
    const to = nextIndex ?? Math.min(block.length, from + 40);

    const raw = block
      .slice(from, to)
      .replace(/\s+/g, "")
      // 两列排版会把下一章的条目挤到同一行：`1.1 基本保险金额5.如何退保`
      .replace(/\d{1,2}\.(?=[^\d.])[\s\S]*$/, "")
      .replace(/\d+$/, "")
      .replace(/^[，。、；：]/, "")
      // 标题被两栏挤断时尾巴会留一个顿号
      .replace(/[，。、；：]+$/, "");

    const usable = raw.length >= 2 && raw.length <= 20 && !/[。；]/.test(raw) && !/\d/.test(raw);
    entries.push({ no, title: usable ? raw : null });
  }

  return entries;
}

export function checkToc(pages: PageText[], clauseNos: string[]): TocCheck {
  const expected = extractTocClauseNos(pages);
  const actual = clauseNos.filter((no) => /^\d{1,2}\.\d{1,2}$/.test(no));

  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);

  return {
    expected,
    actual,
    missing: expected.filter((no) => !actualSet.has(no)),
    extra: actual.filter((no) => !expectedSet.has(no)),
    matched: expected.filter((no) => actualSet.has(no)).length,
  };
}
