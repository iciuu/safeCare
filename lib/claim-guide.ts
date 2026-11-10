/**
 * 理赔实操：从合同原文里把「多久内报案 / 要准备什么材料 / 保险公司多久给答复」捞出来。
 *
 * 只做三件事：找条款、切清单、抓天数。抓不到就返回 null，界面上写「未识别」，
 * 不拿常识或别的公司的规则填空。每条都带条款号和页码，点得回原文。
 */

export type ClaimSource = {
  clauseNo: string | null;
  page: number;
  quote: string;
};

export type ClaimMaterial = {
  text: string;
  source: ClaimSource;
};

export type ClaimTimelineItem = {
  label: string;
  value: string;
  source: ClaimSource;
};

export type ClaimGuide = {
  /** 事故通知义务：合同给的天数，没有具体天数时 days 为 null（多为「及时」） */
  notify: { text: string; days: number | null; source: ClaimSource } | null;
  materials: ClaimMaterial[];
  materialsNote: string | null;
  timeline: ClaimTimelineItem[];
  hotline: string | null;
};

export type ClaimClause = {
  clause_no: string | null;
  page_from: number;
  heading_path?: string | null;
  text: string;
};

/** 看起来像「要你交的东西」的行：两头排版错位也能认，所以不靠表头文字 */
const DOCUMENT_HINT = /资料|证明|发票|病历|诊断|证件|身份|申请书|合同|报告|清单|凭证|结算|文件|鉴定|户口|死亡|条款/;
const LIST_END = /(?:以上|上述)[^。]{0,10}(?:资料|材料)/;

/** （1）/（一）/（十一）都要能读成序号 */
const MARK = /[（(]\s*([0-9]{1,2}|[一二三四五六七八九十]{1,3})\s*[)）]/g;
const CN_DIGITS: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

function numberOf(raw: string): number {
  if (/^[0-9]+$/.test(raw)) return Number(raw);
  if (raw === "十") return 10;
  if (raw.length === 1) return CN_DIGITS[raw] ?? 0;
  if (raw.startsWith("十")) return 10 + (CN_DIGITS[raw[1]] ?? 0);
  if (raw.endsWith("十")) return (CN_DIGITS[raw[0]] ?? 0) * 10;
  const [tens, ones] = raw.split("十");
  return (CN_DIGITS[tens] ?? 0) * 10 + (CN_DIGITS[ones] ?? 0);
}

function tidy(value: string): string {
  return value.replace(/\s+/g, " ").replace(/[；;]\s*$/, "").trim();
}

function sentenceAround(text: string, index: number): string {
  const flat = text.replace(/\s+/g, "");
  const before = flat.lastIndexOf("。", index);
  const after = flat.indexOf("。", index);
  const start = before === -1 ? 0 : before + 1;
  const end = after === -1 ? Math.min(flat.length, start + 120) : after + 1;
  return flat.slice(start, end).trim();
}

function isClaimClause(clause: ClaimClause): boolean {
  return /保险金申请|申请保险金|保险金给付|索赔|理赔|保险事故通知|知道保险事故发生后/.test(
    `${clause.heading_path ?? ""}${clause.text}`,
  );
}

/**
 * 把「提供下列证明和资料：（1）…；（2）…」切成条。
 * 一页里可能有好几份清单（身故一份、其他疾病一份），每份都收。
 */
function splitMaterials(clause: ClaimClause): ClaimMaterial[] {
  const flat = clause.text.replace(/\s+/g, "");
  const source = (quote: string): ClaimSource => ({
    clauseNo: clause.clause_no,
    page: clause.page_from,
    quote: quote.slice(0, 120),
  });

  // 编号会从 1 重新开始，于是「1,2,3 然后又 1,2,3」就是两份清单
  const marks = [...flat.matchAll(MARK)];
  const groups: { number: number; index: number; length: number }[][] = [];
  let current: { number: number; index: number; length: number }[] = [];
  let lastNumber = 0;
  for (const mark of marks) {
    const number = numberOf(mark[1]);
    if (number <= lastNumber && current.length > 0) {
      groups.push(current);
      current = [];
    }
    lastNumber = number;
    current.push({ number, index: mark.index ?? 0, length: mark[0].length });
  }
  if (current.length > 0) groups.push(current);

  const items: ClaimMaterial[] = [];
  for (const group of groups) {
    if (group.length < 2) continue; // 单条编号列表多半不是材料清单

    // 紧跟着「提供下列证明和资料：」这种话才收；疾病定义里的分条条件也有编号，不能当材料
    const lead = flat.slice(Math.max(0, group[0].index - 200), group[0].index);
    const isMaterialList = /(?:提供|提交|出具|附上)[^。]{0,40}(?:资料|材料|证明|文件)/.test(lead);
    if (!isMaterialList) continue;

    const texts: string[] = [];
    for (let index = 0; index < group.length; index += 1) {
      const mark = group[index];
      const next = group[index + 1] ?? marks.find((candidate) => (candidate.index ?? 0) > mark.index);
      const stop = next ? (next.index ?? flat.length) : Math.min(flat.length, mark.index + 200);
      let body = flat.slice(mark.index + mark.length, stop);
      // 最后一条容易把后面的段落一口吞下，按页脚、下一份清单、注意事项这些位置剪掉
      const cut = [
        LIST_END,
        /\d{1,3}\/\d{1,3}/,
        /特别注意事项|注意事项|理赔须知/,
        /[一二三四五六七八九十]{1,3}、/, // 下一份清单的小标题，如「二、白血病…所需的证明和资料」
        /保险金作为被保险人遗产|继承人还须提供/,
      ]
        .map((pattern) => pattern.exec(body)?.index)
        .filter((index): index is number => typeof index === "number");
      if (cut.length > 0) body = body.slice(0, Math.min(...cut));
      // 双栏排版会把尾巴切碎，「…身份证件；申请」这种碎片直接丢掉
      body = body.replace(/[；;、][^；;。]{0,3}$/, "");
      texts.push(tidy(body.replace(MARK, " ")).replace(/\s*\d{1,3}\s*$/, ""));
    }

    const looksLikeDocuments = texts.filter((text) => DOCUMENT_HINT.test(text)).length;
    if (looksLikeDocuments * 2 < group.length) continue; // 一半以上的条目不像证明材料，就不是清单

    for (const text of texts) {
      if (text.length < 2) continue;
      // 退保/犹豫期的材料不是理赔材料
      if (/解除合同|犹豫期|退保/.test(text)) continue;
      items.push({ text, source: source(text) });
    }
  }
  return items;
}

function timelineOf(clause: ClaimClause): ClaimTimelineItem[] {
  const flat = clause.text.replace(/\s+/g, "");
  const rules: { label: string; pattern: RegExp; format: (match: RegExpMatchArray) => string }[] = [
    {
      label: "材料不全时通知补充",
      pattern: /(\d{1,3})\s*个工作日内(?:一次性)?通知/,
      format: (match) => `${match[1]} 个工作日内一次性通知补充`,
    },
    {
      label: "作出核定",
      pattern: /(\d{1,3})\s*个工作日内[^。；]{0,8}作出核定/,
      format: (match) => `${match[1]} 个工作日内作出核定`,
    },
    {
      label: "情形复杂的核定",
      pattern: /情形复杂[^。；]{0,24}?(\d{1,3})\s*日内[^。；]{0,8}作出核定/,
      format: (match) => `情形复杂的 ${match[1]} 日内作出核定`,
    },
    {
      label: "给付保险金",
      pattern: /(\d{1,3})\s*日内[^。；]{0,12}履行给付/,
      format: (match) => `达成协议后 ${match[1]} 日内给付`,
    },
    {
      label: "拒赔通知",
      pattern: /(\d{1,3})\s*日内[^。；]{0,14}拒绝给付/,
      format: (match) => `${match[1]} 日内发出拒赔通知并说明理由`,
    },
    {
      label: "先予支付",
      pattern: /收到[^。；]{0,30}(\d{1,3})\s*日内[^。；]{0,16}先予支付/,
      format: (match) => `${match[1]} 日内数额未定时先予支付可确定的部分`,
    },
  ];

  const items: ClaimTimelineItem[] = [];
  for (const rule of rules) {
    const match = rule.pattern.exec(flat);
    if (!match) continue;
    items.push({
      label: rule.label,
      value: rule.format(match),
      source: { clauseNo: clause.clause_no, page: clause.page_from, quote: sentenceAround(clause.text, match.index ?? 0) },
    });
  }
  return items;
}

function notifyOf(clauses: ClaimClause[]): ClaimGuide["notify"] {
  // 只认「事故通知」这一类条款：别的条款里也有「3 日内通知受益人」，那是拒赔通知，不是报案时限
  const notifyClauses = clauses.filter((clause) =>
    /保险事故通知|知道保险事故发生后|事故发生后[^。]{0,12}(?:通知|报案)|及时通知/.test(
      `${clause.heading_path ?? ""}${clause.text.replace(/\s+/g, "")}`,
    ),
  );
  type Candidate = { sentence: string; days: number | null; unit: "小时" | "日"; source: ClaimSource; score: number };
  const candidates: Candidate[] = [];

  for (const clause of notifyClauses) {
    const flat = clause.text.replace(/\s+/g, "");
    // 只在讲「事故要通知」的那句话里找天数，别把「3 日内发出拒赔通知」当成报案时限
    for (const sentence of flat.split(/(?<=[。；])/)) {
      if (!/事故|出险/.test(sentence)) continue;
      if (!/(通知|报案|告知)/.test(sentence)) continue;
      // 阅读指引的目录行带一串点线（「……及时通知我们..........5.2」），那不是条款正文
      if (/[．.·]{4,}/.test(sentence)) continue;

      const days = /([0-9]{1,3}|[一二三四五六七八九十]{1,3})\s*(小时|日|天)内/.exec(sentence);
      // 「故意或因重大过失未及时通知」讲的是违约后果，不是报案期限，优先度排到最后
      let score = /未及时|故意|致使|难以确定/.test(sentence) ? -4 : 0;
      if (/应当|须|需|请/.test(sentence)) score += 3;
      if (/及时|立即|尽快/.test(sentence)) score += 1;
      if (days) score += 2;
      // 合同条款优先于后面的「理赔服务指南」（指南常写更严的内部时限）
      if (/第[一二三四五六七八九十百零]+条/.test(sentence)) score += 1;

      candidates.push({
        sentence: sentence.trim(),
        days: days ? numberOf(days[1]) : null,
        unit: days && days[2] === "小时" ? "小时" : "日",
        source: { clauseNo: clause.clause_no, page: clause.page_from, quote: sentence.trim() },
        score,
      });
    }
  }

  const best = candidates.sort((a, b) => b.score - a.score || a.source.page - b.source.page)[0];
  if (!best || best.score < 0) return null;
  if (best.days !== null) {
    return { text: `${best.days} ${best.unit}内通知保险公司`, days: best.days, source: best.source };
  }
  return { text: "及时通知（合同没写具体天数，越早越好）", days: null, source: best.source };
}

function hotlineOf(clauses: ClaimClause[]): string | null {
  for (const clause of clauses) {
    const match = /(?:955\d{2}|400[-\s]?\d{3}[-\s]?\d{4})/.exec(clause.text.replace(/\s+/g, ""));
    if (match) return match[0].replace(/\s+/g, "");
  }
  return null;
}

export function buildClaimGuide(clauses: ClaimClause[]): ClaimGuide {
  const claim = clauses.filter(isClaimClause);

  const materials: ClaimMaterial[] = [];
  const seenMaterial = new Set<string>();
  let materialsNote: string | null = null;
  for (const clause of claim) {
    for (const item of splitMaterials(clause)) {
      // 不同页会重复列同一份材料，去掉尾巴标点后取前 16 个字做去重键
      const key = item.text.replace(/\s+/g, "").replace(/[；;。，,、]+$/, "").slice(0, 16);
      if (seenMaterial.has(key)) continue;
      seenMaterial.add(key);
      materials.push(item);
      if (materials.length >= 12) break;
    }
    if (materials.length >= 12) break;
    if (materialsNote) continue;
    const note = /以上证明和资料不完整的[^。]*。/.exec(clause.text.replace(/\s+/g, ""));
    if (note) materialsNote = note[0];
  }

  const timeline: ClaimTimelineItem[] = [];
  const seen = new Set<string>();
  for (const clause of claim) {
    for (const item of timelineOf(clause)) {
      if (seen.has(item.label)) continue;
      seen.add(item.label);
      timeline.push(item);
    }
  }

  return {
    notify: notifyOf(claim),
    materials,
    materialsNote,
    timeline,
    hotline: hotlineOf(clauses),
  };
}

export function hasClaimGuide(guide: ClaimGuide): boolean {
  return Boolean(guide.notify) || guide.materials.length > 0 || guide.timeline.length > 0;
}
