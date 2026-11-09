// pdfjs-dist 3.x 只为包根入口提供 d.ts，legacy 构建路径需要自己补声明。
declare module "pdfjs-dist/legacy/build/pdf.js" {
  export interface PdfTextItem {
    str: string;
    transform: number[];
    width: number;
    height: number;
    hasEOL?: boolean;
  }

  export interface PdfTextContent {
    items: PdfTextItem[];
  }

  export interface PdfViewport {
    width: number;
    height: number;
  }

  export interface PdfPageProxy {
    getViewport(params: { scale: number }): PdfViewport;
    getTextContent(): Promise<PdfTextContent>;
    cleanup(): void;
  }

  export interface PdfDocumentProxy {
    numPages: number;
    getPage(pageNumber: number): Promise<PdfPageProxy>;
    destroy(): Promise<void>;
  }

  export interface PdfLoadingTask {
    promise: Promise<PdfDocumentProxy>;
  }

  export function getDocument(src: {
    data: Uint8Array;
    useSystemFonts?: boolean;
    isEvalSupported?: boolean;
  }): PdfLoadingTask;

  const pdfjs: { getDocument: typeof getDocument };
  export default pdfjs;
}
