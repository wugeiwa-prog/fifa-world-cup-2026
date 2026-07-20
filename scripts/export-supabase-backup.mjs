import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile, copyFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const BACKUP_ROOT = path.join(ROOT, ".backups");
const SUPABASE_URL = (process.env.SUPABASE_URL || "https://dngazmrtmtdahbrlazcj.supabase.co").replace(/\/$/, "");
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_-bRXY4XdE8-mbyEHVnxvGw_EfCd8RuY";
const TABLES = [
  "wc2026_state",
  "wc2026_users",
  "wc2026_bets",
  "wc2026_daily",
  "wc2026_results",
  "wc2026_odds",
  "wc2026_comments",
  "wc2026_comment_replies",
  "wc2026_sync_meta"
];

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function rel(base, file) {
  return path.relative(base, file).split(path.sep).join("/");
}

function csvCell(value) {
  if (value == null) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(rows) {
  const columns = [...new Set(rows.flatMap(row => Object.keys(row || {})))];
  if (!columns.length) return "\uFEFF";
  return `\uFEFF${columns.join(",")}\r\n${rows.map(row => columns.map(column => csvCell(row[column])).join(",")).join("\r\n")}\r\n`;
}

async function sha256(file) {
  const hash = createHash("sha256");
  hash.update(await readFile(file));
  return hash.digest("hex");
}

async function filesUnder(dir) {
  const output = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) output.push(...await filesUnder(file));
    else output.push(file);
  }
  return output.sort();
}

async function run(command, args, cwd = ROOT) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", windowsHide: true });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
}

async function fetchTable(table) {
  const rows = [];
  const pageSize = 1000;
  for (let start = 0; ; start += pageSize) {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        Range: `${start}-${start + pageSize - 1}`,
        Prefer: "count=exact"
      }
    });
    if (!response.ok) throw new Error(`${table}: HTTP ${response.status} ${await response.text()}`);
    const page = await response.json();
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

function assertNoSecrets(text, label) {
  const forbidden = [
    [/github_pat_[A-Za-z0-9_]+/i, "GitHub token"],
    [/\bghp_[A-Za-z0-9]+/i, "GitHub token"],
    [/\bsb_secret_[A-Za-z0-9_-]+/i, "Supabase secret key"],
    [/"pass(?:word)?_?hash"\s*:/i, "password hash"],
    [/\bservice_role\b/i, "Supabase service role"],
    [/\bfifa2026\b/i, "site access password"]
  ];
  for (const [pattern, name] of forbidden) {
    if (pattern.test(text)) throw new Error(`${label} contains forbidden ${name}`);
  }
}

function normalizedDashboardData(tables, exportedAt) {
  return {
    exportedAt,
    users: tables.wc2026_users.map(row => ({
      name: row.name,
      createdAt: Number(row.created_at) || 0,
      updatedAt: Number(row.updated_at) || 0
    })),
    bets: tables.wc2026_bets.map(row => ({
      id: row.id,
      user: row.user_name,
      mid: row.mid,
      type: row.type,
      pick: row.pick,
      odds: Number(row.odds) || 0,
      stake: Number(row.stake) || 0,
      status: row.status,
      payout: row.payout == null ? 0 : Number(row.payout),
      placedAt: Number(row.placed_at) || 0,
      settledAt: row.settled_at == null ? 0 : Number(row.settled_at),
      updatedAt: Number(row.updated_at) || 0
    })),
    results: Object.fromEntries(tables.wc2026_results.map(row => [row.mid, {
      score: row.score,
      status: row.status,
      source: row.source,
      sourceUrl: row.source_url,
      updatedAt: row.updated_at
    }]))
  };
}

async function buildOfflineDashboard(tables, exportedAt) {
  let html = await readFile(path.join(ROOT, "dashboard.html"), "utf8");
  const embedded = JSON.stringify(normalizedDashboardData(tables, exportedAt)).replaceAll("</script", "<\\/script");
  html = html
    .replace('<script src="remote-sync.js"></script>', '<script>window.__DASHBOARD_OFFLINE__=true;</script>')
    .replace('<script id="archiveData" type="application/json">{}</script>', `<script id="archiveData" type="application/json">${embedded}</script>`)
    .replace('const ACCESS_PASSWORD="fifa2026";', 'const ACCESS_PASSWORD="";')
    .replace(
      'const REMOTE_SYNC={enabled:true,url:"https://dngazmrtmtdahbrlazcj.supabase.co",anonKey:"sb_publishable_-bRXY4XdE8-mbyEHVnxvGw_EfCd8RuY",table:"wc2026_state",rowId:"global"};',
      'const REMOTE_SYNC={enabled:false,url:"",anonKey:"",table:"",rowId:""};'
    );
  assertNoSecrets(html, "dashboard-offline.html");
  return html;
}

async function validateArchive(zipFile, verifyDir, expectedCounts) {
  await mkdir(verifyDir, { recursive: true });
  await run("tar.exe", ["-xf", zipFile, "-C", verifyDir]);

  const checksumText = await readFile(path.join(verifyDir, "SHA256SUMS.txt"), "utf8");
  for (const line of checksumText.trim().split(/\r?\n/)) {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    if (!match) throw new Error(`Invalid checksum line: ${line}`);
    const file = path.join(verifyDir, ...match[2].split("/"));
    const actual = await sha256(file);
    if (actual !== match[1]) throw new Error(`Checksum mismatch: ${match[2]}`);
  }

  for (const table of TABLES) {
    const rows = JSON.parse(await readFile(path.join(verifyDir, "json", `${table}.json`), "utf8"));
    if (rows.length !== expectedCounts[table]) {
      throw new Error(`${table}: expected ${expectedCounts[table]} rows, got ${rows.length}`);
    }
  }

  const offline = await readFile(path.join(verifyDir, "dashboard-offline.html"), "utf8");
  const match = offline.match(/<script id="archiveData" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) throw new Error("Offline dashboard embedded data is missing");
  const data = JSON.parse(match[1]);
  if (data.users.length !== expectedCounts.wc2026_users || data.bets.length !== expectedCounts.wc2026_bets || Object.keys(data.results).length !== expectedCounts.wc2026_results) {
    throw new Error("Offline dashboard row counts do not match the archive");
  }
}

async function main() {
  const id = stamp();
  const stageDir = path.resolve(BACKUP_ROOT, `.working-${id}`);
  const verifyDir = path.resolve(BACKUP_ROOT, `.verify-${id}`);
  const zipFile = path.resolve(BACKUP_ROOT, `supabase-final-${id}.zip`);
  if (!stageDir.startsWith(`${path.resolve(BACKUP_ROOT)}${path.sep}`) || !verifyDir.startsWith(`${path.resolve(BACKUP_ROOT)}${path.sep}`)) {
    throw new Error("Unsafe backup working path");
  }

  await mkdir(path.join(stageDir, "json"), { recursive: true });
  await mkdir(path.join(stageDir, "csv"), { recursive: true });
  const exportedAt = new Date().toISOString();
  const tables = {};

  console.log("Reading 9 Supabase tables...");
  for (const table of TABLES) {
    tables[table] = await fetchTable(table);
    console.log(`  ${table}: ${tables[table].length}`);
    const json = `${JSON.stringify(tables[table], null, 2)}\n`;
    assertNoSecrets(json, table);
    await writeFile(path.join(stageDir, "json", `${table}.json`), json);
    await writeFile(path.join(stageDir, "csv", `${table}.csv`), toCsv(tables[table]));
  }

  await copyFile(path.join(ROOT, "BACKEND_SYNC.sql"), path.join(stageDir, "BACKEND_SYNC.sql"));
  await writeFile(path.join(stageDir, "dashboard-offline.html"), await buildOfflineDashboard(tables, exportedAt));

  const counts = Object.fromEntries(TABLES.map(table => [table, tables[table].length]));
  const manifest = {
    archive: "2026 FIFA World Cup final local archive",
    exportedAt,
    source: SUPABASE_URL,
    tableCount: TABLES.length,
    totalRows: Object.values(counts).reduce((sum, count) => sum + count, 0),
    counts,
    expectedFinalSummary: {
      users: 22,
      bets: 939,
      results: 104,
      won: 242,
      lost: 697,
      totalStake: 55093,
      totalPayout: 47351
    }
  };
  await writeFile(path.join(stageDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const restore = [
    "2026 世界杯竞猜最终归档",
    "",
    `导出时间：${exportedAt}`,
    "",
    "快速查看",
    "1. 双击 dashboard-offline.html。页面无需联网即可使用。",
    "2. JSON 是完整原始数据，CSV 便于使用表格软件查看。",
    "",
    "完整性验证",
    "在本目录执行：certutil -hashfile dashboard-offline.html SHA256",
    "完整文件校验值见 SHA256SUMS.txt。",
    "",
    "恢复 Supabase",
    "1. 新建 Supabase 项目。",
    "2. 在 SQL Editor 执行 BACKEND_SYNC.sql 建表。",
    "3. 使用 JSON 文件按表名导入；先导入 users/results，再导入 bets/daily，最后导入其余表。",
    "4. 导入后按 manifest.json 核对各表行数。",
    "",
    "保管建议",
    "另复制一份 ZIP 到项目目录之外，并保留两份可正常解压的副本。",
    ""
  ].join("\r\n");
  await writeFile(path.join(stageDir, "README.txt"), restore);

  const files = await filesUnder(stageDir);
  for (const file of files) assertNoSecrets(await readFile(file, "utf8"), rel(stageDir, file));
  const checksums = [];
  for (const file of files) checksums.push(`${await sha256(file)}  ${rel(stageDir, file)}`);
  await writeFile(path.join(stageDir, "SHA256SUMS.txt"), `${checksums.join("\n")}\n`);

  console.log("Creating ZIP...");
  await mkdir(BACKUP_ROOT, { recursive: true });
  await run("tar.exe", ["-a", "-cf", zipFile, "-C", stageDir, "."]);
  console.log("Re-extracting and validating ZIP...");
  await validateArchive(zipFile, verifyDir, counts);

  const zipSize = (await stat(zipFile)).size;
  await rm(stageDir, { recursive: true, force: true });
  await rm(verifyDir, { recursive: true, force: true });
  console.log(`Archive verified: ${zipFile}`);
  console.log(`ZIP size: ${zipSize.toLocaleString("en-US")} bytes`);
  console.log("Keep a second copy outside this project folder before Supabase is disabled.");
}

main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
