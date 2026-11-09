// 生成一份用于验证解析链路的多页示例 PDF（ASCII 文本，仅用于冒烟测试）
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";

const outputDir = path.join(process.cwd(), "data", "sample");
const outputFile = path.join(outputDir, "sample-policy.pdf");

const PAGE_CONTENT = [
  [
    "MEDICAL EXPENSE INSURANCE - SAMPLE DOCUMENT",
    "Policy No. SC-2026-0001    Insured: SAMPLE / A",
    "",
    "Article 1  Coverage",
    "1.1  General inpatient medical expenses: annual limit CNY 3,000,000.",
    "1.2  Critical illness inpatient: shared limit with 1.1.",
    "",
    "Article 2  Deductible",
    "2.1  Annual deductible CNY 10,000, accumulated per policy year.",
  ],
  [
    "Article 3  Reimbursement Ratio",
    "3.1  Settled through social insurance: 100% of eligible expenses.",
    "3.2  Not settled through social insurance: 60% of eligible expenses.",
    "",
    "Article 4  Waiting Period",
    "4.1  Waiting period is 30 days from the effective date.",
  ],
  [
    "Article 5  Exclusions",
    "5.1  Pre-existing conditions known before inception.",
    "5.2  Treatment during the waiting period.",
    "5.3  Cosmetic surgery, dental care and vision correction.",
    "",
    "Article 6  Renewal",
    "6.1  Guaranteed renewable for 6 years; premium may be adjusted.",
  ],
];

const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);

for (const lines of PAGE_CONTENT) {
  const page = pdf.addPage([595, 842]);
  let cursorY = 780;
  for (const line of lines) {
    page.drawText(line, { x: 60, y: cursorY, size: 11, font });
    cursorY -= 22;
  }
  page.drawText("-- page footer --", { x: 60, y: 60, size: 8, font });
}

await mkdir(outputDir, { recursive: true });
await writeFile(outputFile, await pdf.save());
console.log(`wrote ${outputFile} (${PAGE_CONTENT.length} pages)`);
