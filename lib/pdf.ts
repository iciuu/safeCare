import path from "node:path";
import { pathToFileURL } from "node:url";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import type { PDFPage } from "pdf-lib";
import type { PdfDocumentProxy, PdfTextItem } from "pdfjs-dist/legacy/build/pdf.js";

/**
 * pdfjs 的 legacy 构建是带 `__esModule` 的 CJS（只有具名导出，没有 default），
 * 直接 import 会被 interop 成 undefined；这里从项目根用 createRequire 取，
 * 既绕开打包器，也能正常工作在 dev 和构建后的 server 里。
 */
type PdfJsModule = {
  getDocument: (src: {
    data: Uint8Array;
    useSystemFonts?: boolean;
    isEvalSupported?: boolean;
  }) => { promise: Promise<PdfDocumentProxy> };
};

let cachedPdfjs: PdfJsModule | null = null;

function loadPdfjs(): PdfJsModule {
  if (!cachedPdfjs) {
    // 用内置模块 API 直接拿 require，避免 Next/Webpack 对 import 与 createRequire 做 interop
    const { createRequire } = process.getBuiltinModule("node:module");
    const nodeRequire = createRequire(pathToFileURL(path.join(process.cwd(), "package.json")));
    cachedPdfjs = nodeRequire("pdfjs-dist/legacy/build/pdf.js") as PdfJsModule;
  }
  return cachedPdfjs;
}

/** 一行文字 + 它的字号（同一行里取最大，标题常比正文大半号） */
export type TextLine = { text: string; size: number };

export type ExtractedPage = {
  page_no: number;
  width: number;
  height: number;
  text: string;
  char_count: number;
  /** 本页正文的常见字号，用来判断哪几行是标题 */
  body_size: number;
  /** 明显大于正文的行：条款标题、章标题多半在这里 */
  headings: { t: string; s: number }[];
};

export type ExtractedPdf = {
  pages: ExtractedPage[];
  pageCount: number;
  charCount: number;
  hasTextLayer: boolean;
};

type Frag = {
  str: string;
  x: number;
  y: number;
  h: number;
};

/** 只保留看起来是正常文字的结果：大量替换字符或控制字符说明解码没对上 */
function looksLikeText(text: string): boolean {
  if (!text.trim()) return false;
  let bad = 0;
  let good = 0;
  for (const ch of text) {
    if (ch === "\uFFFD" || (ch < " " && ch !== "\n" && ch !== "\t")) bad += 1;
    else good += 1;
  }
  return good > bad * 2 && good >= 2;
}

/**
 * 表单域里的文字：华贵这类保单把填写内容画成独立的 Form XObject，
 * 字体声明成 WinAnsi 但字节其实是 GBK，pdfjs 找不到映射就吐空字符串。
 * 这里按 GBK 解一遍，双字节的全角数字/证件号按 UTF-16BE 解。
 */
function decodeFormString(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  const asciiOnly = bytes.every((b) => b >= 0x20 && b < 0x7f);
  if (asciiOnly) {
    // 「男」是 75 37，两个字节看着也像 ASCII；性别这种单字字段按 UTF-16BE 读更准
    if (bytes.length === 2) {
      const code = (bytes[0] << 8) | bytes[1];
      if (code >= 0x4e00 && code <= 0x9fff) return String.fromCharCode(code);
    }
    return Buffer.from(bytes).toString("latin1");
  }
  // 中文姓名/「年交」这类值用的是 UTF-16BE（例：牛广 = 72 5B 5E 7F）
  if (bytes.length % 2 === 0) {
    let text = "";
    for (let i = 0; i < bytes.length; i += 2) text += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    if (looksLikeText(text) && /[\u4e00-\u9fa5a-zA-Z0-9]/.test(text)) return text;
  }
  try {
    const text = new TextDecoder("gbk").decode(bytes);
    if (looksLikeText(text)) return text;
  } catch {
    // 没有 GBK 支持就退回 latin1
  }
  return Buffer.from(bytes).toString("latin1");
}

function unescapeLiteral(raw: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== "\\") {
      out.push(ch.charCodeAt(0) & 0xff);
      continue;
    }
    const next = raw[++i];
    if (next === undefined) break;
    if (next === "n") out.push(10);
    else if (next === "r") out.push(13);
    else if (next === "t") out.push(9);
    else if (next === "b") out.push(8);
    else if (next === "f") out.push(12);
    else if (next >= "0" && next <= "7") {
      let oct = next;
      while (oct.length < 3 && raw[i + 1] >= "0" && raw[i + 1] <= "7") oct += raw[++i];
      out.push(parseInt(oct, 8) & 0xff);
    } else out.push(next.charCodeAt(0) & 0xff);
  }
  return Uint8Array.from(out);
}

/** 扫页面的 `q/Q` 与 `cm`，每遇到一次 `Do` 就把对象名和当时的平移坐标交给回调 */
function scanContentStream(
  stream: string,
  visit: (name: string, x: number, y: number) => { text: string; dx: number; dy: number } | null,
): Frag[] {
  const frags: Frag[] = [];
  // 图形状态只关心平移：这份 PDF 只用到 `1 0 0 1 x y cm`，但也接受完整矩阵
  const stack: number[][] = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const mul = (m: number[], n: number[]) => [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
  const tokenRe = /\bq\b|\bQ\b|([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+cm|\/([A-Za-z0-9_+-]+)\s+Do/g;

  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(stream))) {
    const token = match[0];
    if (token === "q") {
      stack.push([...ctm]);
      continue;
    }
    if (token === "Q") {
      ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
      continue;
    }
    if (match[7]) {
      const found = visit(match[7], ctm[4], ctm[5]);
      if (found && looksLikeText(found.text)) {
        frags.push({ str: found.text, x: ctm[4] + found.dx, y: ctm[5] + found.dy, h: 10 });
      }
      continue;
    }
    ctm = mul(
      [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])],
      ctm,
    );
  }

  return frags;
}

/** 读出一个 Form XObject 里的文字及其内部偏移 */
function formXObjectText(stream: string): { text: string; dx: number; dy: number } | null {
  let tm: number[] = [1, 0, 0, 1, 0, 0];
  const parts: string[] = [];
  const re = /([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+Tm|\(((?:[^()\\]|\\.)*)\)\s*Tj|<([0-9A-Fa-f\s]+)>\s*Tj/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stream))) {
    if (match[1]) {
      tm = [1, 0, 0, 1, Number(match[5]), Number(match[6])];
      continue;
    }
    const bytes = match[8]
      ? Uint8Array.from(Buffer.from(match[8].replace(/\s+/g, ""), "hex"))
      : unescapeLiteral(match[7] ?? "");
    parts.push(decodeFormString(bytes));
  }
  const text = parts.join("").replace(/\s+/g, " ").trim();
  return text ? { text, dx: tm[4], dy: tm[5] } : null;
}

/**
 * 有些保单（华贵、部分经代出单）把「保险单」页的填写值做成了 Form XObject，
 * pdfjs 的文本层里只剩标签。这里补一条通道：先扫页面的 `Do`，再读对应 XObject 的文字，
 * 位置用 `cm` 的平移加上对象内部的 `Tm` 还原，这样和标签落在同一行。
 */
async function recoverFormText(pdf: PDFDocument, pageIndex: number): Promise<Frag[]> {
  const page: PDFPage = pdf.getPage(pageIndex);
  const resources = page.node.Resources();
  const xobjects = resources ? resources.lookup(PDFName.of("XObject"), PDFDict) : null;
  if (!xobjects) return [];

  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => pdf.context.lookup(ref)) : [contents];
  let stream = "";
  for (const entry of streams) {
    if (entry instanceof PDFRawStream) {
      try {
        stream += Buffer.from(decodePDFRawStream(entry).decode()).toString("latin1");
      } catch {
        // DCT 之类解不开的流跳过，页面文字仍走 pdfjs
      }
    }
  }
  if (!stream.trim()) return [];

  const cache = new Map<string, { text: string; dx: number; dy: number } | null>();
  return scanContentStream(stream, (name) => {
    if (!cache.has(name)) {
      const ref = xobjects.get(PDFName.of(name));
      const obj = ref ? pdf.context.lookup(ref) : null;
      let parsed: { text: string; dx: number; dy: number } | null = null;
      if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of("Subtype"))?.toString() === "/Form") {
        try {
          parsed = formXObjectText(Buffer.from(decodePDFRawStream(obj).decode()).toString("latin1"));
        } catch {
          parsed = null;
        }
      }
      cache.set(name, parsed);
    }
    return cache.get(name) ?? null;
  });
}

/**
 * 把 pdfjs 的 text item 还原成行：同一基线的碎片按 x 排序拼接。
 * 中文 PDF 常把每个字拆成一个 item，所以拼接时不能补空格。
 */
function layoutLines(items: PdfTextItem[], extra: Frag[] = []): TextLine[] {
  const frags: Frag[] = [...extra];

  for (const item of items) {
    if (!item.str) continue;
    frags.push({
      str: item.str,
      x: item.transform[4] ?? 0,
      y: item.transform[5] ?? 0,
      h: Math.abs(item.height || item.transform[3] || 10),
    });
  }

  if (frags.length === 0) return [];

  frags.sort((a, b) => b.y - a.y || a.x - b.x);

  const lines: Frag[][] = [];
  for (const frag of frags) {
    const line = lines[lines.length - 1];
    const tolerance = Math.max(2, frag.h * 0.4);
    if (line && Math.abs(line[0].y - frag.y) <= tolerance) {
      line.push(frag);
    } else {
      lines.push([frag]);
    }
  }

  return lines
    .map((line) => {
      const sorted = line.sort((a, b) => a.x - b.x);
      return {
        text: sorted
          .map((f) => f.str)
          .join("")
          .replace(/[ \t]+$/g, ""),
        size: Math.max(...sorted.map((f) => f.h)),
      };
    })
    .filter((line) => line.text.trim().length > 0);
}

/** 字符加权的中位字号：一页里正文占绝大多数，页眉页脚砍不掉也不影响 */
function bodySizeOf(lines: TextLine[]): number {
  const buckets = new Map<number, number>();
  for (const line of lines) {
    const key = Math.round(line.size * 10) / 10;
    buckets.set(key, (buckets.get(key) ?? 0) + line.text.length);
  }
  const total = [...buckets.values()].reduce((sum, n) => sum + n, 0);
  if (total === 0) return 0;
  let seen = 0;
  for (const [size, chars] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    seen += chars;
    if (seen >= total / 2) return size;
  }
  return lines[0]?.size ?? 0;
}

/**
 * 标题行：字号至少比正文大 12%，且不是整段正文（一行超过 40 字基本是正文折行）。
 * 这不是用来「猜」的，只是给切分器一个额外的证据，认不出标题时仍然不切。
 */
function headingLinesOf(lines: TextLine[], bodySize: number): { t: string; s: number }[] {
  if (!bodySize) return [];
  return lines
    .filter((line) => line.size >= bodySize * 1.12 + 0.2 && line.text.trim().length <= 40)
    .map((line) => ({ t: line.text.trim(), s: Math.round(line.size * 10) / 10 }));
}

export async function extractPdf(bytes: Uint8Array): Promise<ExtractedPdf> {
  // pdfjs 可能会转移（detach）传入的 buffer，这里必须复制，原件仍要写盘
  const task = loadPdfjs().getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    isEvalSupported: false,
  });

  const doc = await task.promise;
  // pdf-lib 只用来取表单 XObject 里的文字，pdfjs 读不到那层
  const structure = await PDFDocument.load(new Uint8Array(bytes), { updateMetadata: false }).catch(() => null);
  const pages: ExtractedPage[] = [];

  try {
    for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
      const page = await doc.getPage(pageNo);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const formFrags = structure ? await recoverFormText(structure, pageNo - 1).catch(() => []) : [];
      const lines = layoutLines(content.items, formFrags);
      const text = lines.map((line) => line.text).join("\n");
      const bodySize = bodySizeOf(lines);

      pages.push({
        page_no: pageNo,
        width: viewport.width,
        height: viewport.height,
        text,
        char_count: text.replace(/\s/g, "").length,
        body_size: bodySize,
        headings: headingLinesOf(lines, bodySize),
      });

      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }

  const charCount = pages.reduce((sum, page) => sum + page.char_count, 0);

  return {
    pages,
    pageCount: pages.length,
    charCount,
    hasTextLayer: charCount > 0,
  };
}
