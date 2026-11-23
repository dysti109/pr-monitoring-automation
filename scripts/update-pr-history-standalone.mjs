import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templatePath = path.join(projectRoot, "history.html");
const bundledPath = path.join(projectRoot, "PR_누적_히스토리_독립형.html");
const sharedPath = process.env.PAPR_PR_HISTORY_STANDALONE_PATH
  ? path.resolve(process.env.PAPR_PR_HISTORY_STANDALONE_PATH)
  : path.resolve(projectRoot, "..", "..", "PR 브리핑", "PR_누적_히스토리.html");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchInsights(port, timeoutMs = 2500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/competitor-insights`, { signal: controller.signal });
    if (!response.ok) throw new Error(`인사이트 API 응답 ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!port) throw new Error("임시 PR 히스토리 서버 포트를 확보하지 못했어.");
  return port;
}

async function loadInsights() {
  try {
    return { data: await fetchInsights(1430), temporaryServer: null };
  } catch {
    const port = await reservePort();
    const vitePath = path.join(projectRoot, "node_modules", "vite", "bin", "vite.js");
    let stderr = "";
    const temporaryServer = spawn(process.execPath, [vitePath, "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
      cwd: projectRoot,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    temporaryServer.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-3000); });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (temporaryServer.exitCode !== null) {
        throw new Error(`PR 히스토리 갱신용 임시 서버가 시작되지 않았어. ${stderr.trim()}`);
      }
      try {
        return { data: await fetchInsights(port, 1200), temporaryServer };
      } catch {
        await delay(400);
      }
    }
    temporaryServer.kill();
    throw new Error(`PR 히스토리 데이터에 연결하지 못했어. ${stderr.trim()}`);
  }
}

function buildStandalone(template, data) {
  let html = template;
  const header = '<header><a href="/">기사 목록</a><h1>PR 누적 히스토리</h1></header>';
  if (!html.includes(header)) throw new Error("PR 히스토리 상단 구조를 찾지 못했어.");
  html = html.replace(header, '<header><a href="#content">PR 히스토리</a><h1>PR 누적 히스토리</h1></header>');

  const fetchStart = html.lastIndexOf("      fetch('/api/competitor-insights')");
  if (fetchStart < 0) throw new Error("PR 히스토리 데이터 로더를 찾지 못했어.");
  const fetchEnd = html.indexOf("\n", fetchStart);
  if (fetchEnd < 0) throw new Error("PR 히스토리 데이터 로더 끝을 찾지 못했어.");
  const inlineLoader = `      const embeddedData = document.getElementById('pr-history-data');\n      if (embeddedData) {\n        try { render(JSON.parse(embeddedData.textContent)); }\n        catch (error) { content.textContent = '저장된 PR 히스토리 데이터를 읽지 못했습니다.'; }\n      } else {\n${html.slice(fetchStart, fetchEnd)}\n      }`;
  html = `${html.slice(0, fetchStart)}${inlineLoader}${html.slice(fetchEnd)}`;

  const scriptMarker = "    <script>\n      const content = document.querySelector('#content');";
  if (!html.includes(scriptMarker)) throw new Error("PR 히스토리 스크립트 시작 위치를 찾지 못했어.");
  const serialized = JSON.stringify(data).replace(/</g, "\\u003c");
  html = html.replace(scriptMarker, `    <script type="application/json" id="pr-history-data">${serialized}</script>\n${scriptMarker}`);
  return html;
}

async function writeAtomically(filePath, contents) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, contents, "utf8");
  await fs.rename(tempPath, filePath);
}

export async function updatePrHistoryStandalone() {
  const { data, temporaryServer } = await loadInsights();
  try {
    const template = await fs.readFile(templatePath, "utf8");
    const html = buildStandalone(template, data);
    await Promise.all([writeAtomically(bundledPath, html), writeAtomically(sharedPath, html)]);
    return {
      updated: true,
      files: [bundledPath, sharedPath],
      asOf: data.asOf,
      archivedRuns: data.archivedRuns,
      issues: data.issueCount,
      articles: data.rawContentCount ?? data.uniqueArticleCount,
    };
  } finally {
    if (temporaryServer && temporaryServer.exitCode === null) {
      temporaryServer.kill();
      await Promise.race([
        new Promise((resolve) => temporaryServer.once("exit", resolve)),
        delay(2000),
      ]);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await updatePrHistoryStandalone()));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
