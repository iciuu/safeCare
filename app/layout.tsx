import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "safeCare · 家庭保单速查",
  description: "把保险合同拆成可溯源的结构化保障条款",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
