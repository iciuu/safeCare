import path from "node:path";
import { pathToFileURL } from "node:url";
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

export type ExtractedPage = {
  page_no: number;
  width: number;
  height: number;
  text: string;
  char_count: number;
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

/**
 * 把 pdfjs 的 text item 还原成行：同一基线的碎片按 x 排序拼接。
 * 中文 PDF 常把每个字拆成一个 item，所以拼接时不能补空格。
 */
function itemsToText(items: PdfTextItem[]): string {
  const frags: Frag[] = [];

  for (const item of items) {
    if (!item.str) continue;
    frags.push({
      str: item.str,
      x: item.transform[4] ?? 0,
      y: item.transform[5] ?? 0,
      h: Math.abs(item.height || item.transform[3] || 10),
    });
  }

  if (frags.length === 0) return "";

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
    .map((line) =>
      line
        .sort((a, b) => a.x - b.x)
        .map((f) => f.str)
        .join("")
        .replace(/[ \t]+$/g, ""),
    )
    .join("\n");
}

export async function extractPdf(bytes: Uint8Array): Promise<ExtractedPdf> {
  // pdfjs 可能会转移（detach）传入的 buffer，这里必须复制，原件仍要写盘
  const task = loadPdfjs().getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    isEvalSupported: false,
  });

  const doc = await task.promise;
  const pages: ExtractedPage[] = [];

  try {
    for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
      const page = await doc.getPage(pageNo);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const text = itemsToText(content.items);

      pages.push({
        page_no: pageNo,
        width: viewport.width,
        height: viewport.height,
        text,
        char_count: text.replace(/\s/g, "").length,
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
