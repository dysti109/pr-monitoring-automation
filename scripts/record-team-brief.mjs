import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { updateCompetitorJournalistReport } from "./update-competitor-journalist-report.mjs";
import { updatePrHistoryStandalone } from "./update-pr-history-standalone.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportDir = path.join(projectRoot, "reports");
const latestPath = path.join(reportDir, "latest.json");
const archivePath = path.join(reportDir, "pr-history.json");
const pendingPath = path.join(reportDir, "pending-briefs.json");

function kstDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

const report = await readJson(latestPath, null);
if (!report || !Array.isArray(report.articles) || !report.period) {
  throw new Error("팀 발송용 최신 PR 보고서를 찾지 못했습니다.");
}

const archive = await readJson(archivePath, []);
if (!Array.isArray(archive)) throw new Error("PR 히스토리 형식이 올바르지 않습니다.");
const today = kstDate();
const record = {
  ...report,
  teamSentDateKst: today,
  teamSentAt: new Date().toISOString(),
  historySource: "team-email",
};

// 같은 기간의 분석/테스트 기록이 이미 있으면 팀 발송본으로 대체합니다.
// 같은 날 다른 기간의 팀 발송본이 있어도 한 건만 유지해 중복 누적을 막습니다.
let index = archive.findIndex((entry) => entry.teamSentDateKst === today);
if (index < 0) index = archive.findIndex((entry) => entry.period === report.period);
if (index >= 0) archive[index] = record;
else archive.push(record);

const retained = archive
  .sort((a, b) => String(a.generatedAt ?? a.teamSentAt ?? "").localeCompare(String(b.generatedAt ?? b.teamSentAt ?? "")))
  .slice(-180);
await fs.writeFile(archivePath, `${JSON.stringify(retained, null, 2)}\n`, "utf8");

const pending = await readJson(pendingPath, []);
if (Array.isArray(pending)) {
  const remaining = pending.filter((entry) => entry.period !== report.period).slice(-180);
  await fs.writeFile(pendingPath, `${JSON.stringify(remaining, null, 2)}\n`, "utf8");
}

let journalistReportUpdate = { updated: false };
try {
  journalistReportUpdate = await updateCompetitorJournalistReport();
} catch (error) {
  // Email delivery and PR archive recording have already succeeded. Do not make
  // the mail sender appear to have failed and invite an accidental resend.
  journalistReportUpdate = {
    updated: false,
    warning: error instanceof Error ? error.message : String(error),
  };
}

let prHistoryHtmlUpdate = { updated: false };
try {
  prHistoryHtmlUpdate = await updatePrHistoryStandalone();
} catch (error) {
  // Keep successful mail delivery and archive recording successful if a
  // standalone HTML copy cannot be refreshed.
  prHistoryHtmlUpdate = {
    updated: false,
    warning: error instanceof Error ? error.message : String(error),
  };
}

console.log(JSON.stringify({
  recorded: true,
  period: report.period,
  teamSentDateKst: today,
  archivedRuns: retained.length,
  journalistReportUpdate,
  prHistoryHtmlUpdate,
}));
