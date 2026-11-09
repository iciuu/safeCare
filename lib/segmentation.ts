/**
 * 条款切分（规则版）。
 *
 * 规则来自真实保单的结构（见 docs/PLAN.md §5 S2）：
 * - 编号是十进制 `2.5 保险责任` / `1.1 合同构成`，不是「第X条」；
 * - 标题排在窄栏里，常与正文混在同一行，甚至折到下一行开头：
 *   `1.2 合同成立与` + `生效本合同成立、我们收取首期保险费…`；
 *   所以标题优先取合同自带「条款目录」里的对应标题，正文保持原样不拆；
 * - 脚注 `4 重大疾病：名称列表见…` 混排在正文流里，必须先剔除；
 * - 页眉页脚两套：`条款正文第 1 页 /共 37 页`、`第5页，共44页`；
 *   页眉排在页面末尾，所以条款册起点是「出现页眉的那一页」，不是页眉那一行；
 * - 条款只占整份 PDF 的一册，前面还有客户指南、保单页、阅读指引、条款目录。
 *
 * 编号顺序是有用的强约束：章节从 1 递增，小节在同一章内从 .1 递增。
 * 用它可以把「1 年」「1 0/x 0」这类正文误判为标题的情况挡掉。
 */

export type PageText = { page_no: number; text: string };

export type ClauseCategory =
  | "coverage"
  | "exclusion"
  | "waiting_period"
  | "limit"
  | "renewal"
  | "definition"
  | "premium"
  | "termination"
  | "claims"
  | "other";

export type SegmentedClause = {
  seq: number;
  clause_no: string;
  heading: string;
  heading_path: string;
  category: ClauseCategory;
  page_from: number;
  page_to: number;
  text: string;
  char_count: number;
};

export type SegmentationStats = {
  found_book: boolean;
  /** 条款册内、剔除页眉页脚与脚注后的全部字符 */
  book_chars: number;
  clause_chars: number;
  /** 覆盖率 = 归入条款的字符 / 条款册字符，用来暴露漏切 */
  coverage: number;
  dropped_lines: number;
  clause_count: number;
};

export type SegmentationResult = {
  clauses: SegmentedClause[];
  stats: SegmentationStats;
};

// 这批 PDF 的页眉页脚里夹着大量字体映射失败的占位符，如 \uFFFC-\uFFFF 与私有区
const NOISE = /[\uFFFC-\uFFFF\uE000-\uF8FF]/g;
const HEADER = /^条款正文第\s*\d+\s*页\s*[\/／]\s*共\s*\d+\s*页$/;
const FOOTER = /^第\s*\d+\s*页\s*[，,、]\s*共\s*\d+\s*页$/;
// 脚注：小号数字 + 术语 + 冒号，如「4 重大疾病：名称列表见…」「1 保单生效对应日：…」
const FOOTNOTE = /^(\d{1,2})\s*([^\s：:]{1,14})[：:]/;
const L1 = /^(\d{1,2})\s+(\S.*)$/;
// 小节号后面可能是空格、也可能直接接标题/正文（窄栏排版会把标题压平）
const L2 = /^(\d{1,2}\.\d{1,2})(?![\d.])\s*(.*)$/;
const ATTACHMENT = /^附表\s*(\d+)\s*[：:]?\s*(.*)$/;
const CLAIM_GUIDE = /^理赔服务指引/;

type Row = { page: number; text: string };

export function cleanLine(raw: string): string {
  return raw
    .replace(NOISE, "")
    .replace(/[\u00A0\u3000]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isHeadingTitle(title: string): boolean {
  if (!title || title.length > 24) return false;
  // 「2 我们保多久、保什么」这种章节标题自带顿号，不能因此判成正文
  if (/[。；：!?！？]/.test(title)) return false;
  if (/^[（(]/.test(title)) return false;
  return true;
}

/** 标题里的字按顺序出现在原文开头就算对得上（混排时字会被正文隔开）。 */
function subsequenceIn(text: string, term: string, limit = 200): boolean {
  const head = text.slice(0, limit);
  let j = 0;
  for (let i = 0; i < head.length && j < term.length; i += 1) {
    if (head[i] === term[j]) j += 1;
  }
  return j === term.length;
}

function categorize(heading: string): ClauseCategory {
  const h = heading.replace(/\s/g, "");
  if (/责任免除|除外责任|不保什么|免责/.test(h)) return "exclusion";
  if (/等待期|观察期/.test(h)) return "waiting_period";
  if (/续保/.test(h)) return "renewal";
  if (/疾病列表|定义/.test(h)) return "definition";
  if (/保险金额|给付限额|限额|计算方法|补偿原则|给付比例/.test(h)) return "limit";
  if (/保险费|交费|费率/.test(h)) return "premium";
  if (/解除合同|退保|犹豫期|合同终止/.test(h)) return "termination";
  if (/保险金申请|保险金给付|事故通知|理赔|购药流程|受益人/.test(h)) return "claims";
  if (/保险责任|保障|我们保/.test(h)) return "coverage";
  return "other";
}

/**
 * 标题独占行时的跨行拼接：`2.3 保险金额与` + `给付限额`。
 * 判据：上一段以「与/和/或/及」结尾，或者下一段极短且其后再下一段已经是正文。
 */
function extendTitle(title: string, rows: Row[], from: number): { title: string; consumed: number } {
  let index = from;
  let merged = title;

  while (index < rows.length && merged.length <= 18) {
    const next = rows[index].text;
    const after = rows[index + 1]?.text ?? "";

    if (/^[\d（(]/.test(next) || next.length > 10) break;

    const byConjunction = /[与和或及]$/.test(merged);
    const byLookahead = next.length <= 6 && after.length > 30 && /[。：]$/.test(after);
    if (!byConjunction && !byLookahead) break;

    merged += next;
    index += 1;
  }

  return { title: merged, consumed: index - from };
}

export function isPageFurniture(text: string): boolean {
  return HEADER.test(text) || FOOTER.test(text);
}

export function segmentPolicy(
  pages: PageText[],
  tocTitles: Map<string, string> = new Map(),
): SegmentationResult {
  const rows: Row[] = [];
  for (const page of pages) {
    for (const raw of page.text.split(/\r?\n/)) {
      const text = cleanLine(raw);
      if (text) rows.push({ page: page.page_no, text });
    }
  }

  const empty: SegmentationResult = {
    clauses: [],
    stats: {
      found_book: false,
      book_chars: 0,
      clause_chars: 0,
      coverage: 0,
      dropped_lines: 0,
      clause_count: 0,
    },
  };

  const firstHeader = rows.findIndex((row) => HEADER.test(row.text));
  if (firstHeader < 0) return empty;

  // 页眉排在页脚位置，条款册第一页的正文在它之前，所以起点要退回该页第一行
  const bookPage = rows[firstHeader].page;
  const bookStart = rows.findIndex((row) => row.page === bookPage);

  const clauses: SegmentedClause[] = [];
  let seq = 0;
  let droppedLines = 0;
  let bookChars = 0;

  let chapterNo = 0;
  let chapterTitle = "";
  let lastL1 = 0;
  let lastL2 = 0;
  let inFootnote = false;
  let currentPage = -1;

  type Draft = {
    no: string;
    heading: string;
    path: string;
    category: ClauseCategory;
    pageFrom: number;
    pageTo: number;
    lines: string[];
  };

  // 用栈而不是闭包变量：闭包里赋值会让 TS 在外层把变量收窄成 null
  const drafts: Draft[] = [];
  const lastDraft = (): Draft | undefined => drafts[drafts.length - 1];

  const flush = () => {
    const draft = drafts.pop();
    if (!draft) return;
    const text = draft.lines.join("\n");
    const charCount = text.replace(/\s/g, "").length;
    // 只有标题、没有正文的章节也要保留（如「3 我们不保什么」后面直接接小节）
    seq += 1;
    clauses.push({
      seq,
      clause_no: draft.no,
      heading: draft.heading,
      heading_path: draft.path,
      category: draft.category,
      page_from: draft.pageFrom,
      page_to: draft.pageTo,
      text,
      char_count: charCount,
    });
  };

  const start = (no: string, heading: string, path: string, page: number) => {
    flush();
    drafts.push({
      no,
      heading,
      path,
      category: categorize(heading),
      pageFrom: page,
      pageTo: page,
      lines: [],
    });
  };

  const append = (line: string, page: number) => {
    const draft = lastDraft();
    if (!draft) {
      droppedLines += 1; // 章节开始前的说明性文字
      return;
    }
    draft.lines.push(line);
    draft.pageTo = page;
    bookChars += line.replace(/\s/g, "").length;
  };

  let i = bookStart;
  while (i < rows.length) {
    const row = rows[i];

    // 脚注不会跨页续写：换页就结束脚注区，否则会把下一页正文一起吞掉
    if (row.page !== currentPage) {
      currentPage = row.page;
      inFootnote = false;
    }

    if (HEADER.test(row.text) || FOOTER.test(row.text)) {
      droppedLines += 1;
      inFootnote = false;
      i += 1;
      continue;
    }

    // 条款册结束，后面是理赔服务指引
    if (CLAIM_GUIDE.test(row.text) && clauses.length > 0) break;

    const l2 = row.text.match(L2);
    const l1 = row.text.match(L1);

    if (l2 && Number(l2[1].split(".")[0]) === chapterNo && Number(l2[1].split(".")[1]) === lastL2 + 1) {
      const no = l2[1];
      const rest = (l2[2] ?? "").trim();
      const window = rows.slice(i, i + 3).map((item) => item.text).join("");

      let title: string | null = null;
      let consumed = 0;

      const known = tocTitles.get(no);
      if (known && subsequenceIn(window, known)) {
        // 目录里的标题：标题和正文混排时只借标题，正文原样保留
        title = known;
      } else if (rest && isHeadingTitle(rest)) {
        const extended = extendTitle(rest, rows, i + 1);
        title = extended.title;
        consumed = extended.consumed;
      }

      lastL2 = Number(no.split(".")[1]);
      const path = chapterTitle
        ? `${chapterNo} ${chapterTitle} > ${no}${title ? ` ${title}` : ""}`
        : `${no}${title ? ` ${title}` : ""}`;
      start(no, title ?? "", path, row.page);

      if (consumed > 0) {
        // 标题独占若干行，正文从后面开始
        i += 1 + consumed;
        continue;
      }

      const inline = title === null ? rest || row.text : rest === title ? "" : rest;
      if (inline) append(inline, row.page);
      i += 1;
      continue;
    }

    if (l1 && Number(l1[1]) === lastL1 + 1) {
      const title = l1[2].trim();
      if (isHeadingTitle(title)) {
        const extended = extendTitle(title, rows, i + 1);
        chapterNo = Number(l1[1]);
        chapterTitle = extended.title;
        lastL1 = chapterNo;
        lastL2 = 0;
        start(l1[1], extended.title, `${l1[1]} ${extended.title}`, row.page);
        i += 1 + extended.consumed;
        continue;
      }
    }

    if (inFootnote) {
      droppedLines += 1;
      i += 1;
      continue;
    }

    if (FOOTNOTE.test(row.text) && !l2) {
      inFootnote = true;
      droppedLines += 1;
      i += 1;
      continue;
    }

    const attachment = row.text.match(ATTACHMENT);
    if (attachment) {
      const no = `附表${attachment[1]}`;
      const title = attachment[2].trim() || "保障表";
      start(no, title, `${no}: ${title}`, row.page);
      i += 1;
      continue;
    }

    append(row.text, row.page);
    i += 1;
  }

  flush();

  const clauseChars = clauses.reduce((sum, clause) => sum + clause.char_count, 0);
  const coverage = bookChars > 0 ? Math.min(1, clauseChars / bookChars) : 0;

  return {
    clauses,
    stats: {
      found_book: true,
      book_chars: bookChars,
      clause_chars: clauseChars,
      coverage,
      dropped_lines: droppedLines,
      clause_count: clauses.length,
    },
  };
}
