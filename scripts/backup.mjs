/**
 * 本机备份：把 SQLite 库和 PDF 原件复制到 backups/<时间戳>/。
 * 库开了 WAL，所以 -wal / -shm 也一起拷，恢复时放在同一目录即可。
 *
 *   npm run backup
 */

import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const dataDir = path.join(process.cwd(), "data");
const dbFile = path.join(dataDir, "safecare.db");

if (!existsSync(dbFile)) {
  console.error("还没找到 data/safecare.db，先上传一份保单再备份。");
  process.exit(1);
}

const stamp = new Date()
  .toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" })
  .replace(/[: ]/g, "-")
  .replace(/-?$/, "");
const target = path.join(process.cwd(), "backups", stamp);
mkdirSync(target, { recursive: true });

let copied = 0;
for (const name of ["safecare.db", "safecare.db-wal", "safecare.db-shm"]) {
  const source = path.join(dataDir, name);
  if (existsSync(source)) {
    cpSync(source, path.join(target, name));
    copied += 1;
  }
}

const uploads = path.join(dataDir, "uploads");
if (existsSync(uploads)) {
  cpSync(uploads, path.join(target, "uploads"), { recursive: true });
  copied += readdirSync(uploads).length;
}

const mb = (size /* bytes */) => `${(size / 1024 / 1024).toFixed(1)} MB`;
const size = statSync(path.join(target, existsSync(path.join(target, "safecare.db")) ? "safecare.db" : ".")).size;

console.log(`已备份 ${copied} 个文件到 ${target}（库 ${mb(size)}）`);
console.log("恢复：把 safecare.db* 和 uploads/ 拷回 data/ 后重启 npm run dev。");
