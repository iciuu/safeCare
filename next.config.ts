import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdfjs 的 legacy 构建必须在运行时由 Node 加载，不能被 webpack 打包
  serverExternalPackages: ["pdfjs-dist"],
};

export default nextConfig;
