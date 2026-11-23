import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, promises as fs } from "node:fs";
import path from "node:path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Monitoring entities and search terms stay in a local, git-ignored config.
const projectRoot = process.cwd();
const monitoringConfigPath = path.join(projectRoot, "config", "pr-monitoring.local.json");
const monitoringExamplePath = path.join(projectRoot, "config", "pr-monitoring.example.json");
const monitoringConfig = JSON.parse(readFileSync(
  existsSync(monitoringConfigPath) ? monitoringConfigPath : monitoringExamplePath,
  "utf8",
)) as Record<string, any>;
const primaryCompany = monitoringConfig.primaryCompany ?? {};
const primaryCompanyName = String(primaryCompany.name ?? "Primary Company").trim();
const designatedCompetitors: Array<Record<string, any>> = Array.isArray(monitoringConfig.competitors) ? monitoringConfig.competitors : [];
const comparableBusinesses = monitoringConfig.comparableBusinesses ?? { name: "Comparable businesses", candidateNames: [], businessAreas: [], searchQueries: {} };
const comparableGroupName = String(comparableBusinesses.name ?? "Comparable businesses");
const allMonitoringTargets = [primaryCompany, ...designatedCompetitors, comparableBusinesses];
const competitorFeeds = designatedCompetitors.map((target, index) => ({
  id: index + 1,
  title: String(target.name ?? `Competitor ${index + 1}`),
  query: [target.name, ...(target.aliases ?? [])].filter(Boolean).join(" OR "),
}));

let cachedNews: unknown;
let cachedAt = 0;
const CACHE_MS = 5 * 60 * 1000;
const reportDir = path.join(projectRoot, "reports");
const latestReport = path.join(reportDir, "latest.json");
const archivePath = path.join(reportDir, "pr-history.json");
const pendingBriefsPath = path.join(reportDir, "pending-briefs.json");
const rollingInsightsPath = path.join(reportDir, "rolling-insights.json");
const collectionMetricsPath = path.join(reportDir, "collection-metrics.json");
const searchCacheDir = path.join(reportDir, "search-cache");
const companyCheckpointDir = path.join(reportDir, "company-checkpoints");
const precollectionDir = path.join(reportDir, "precollection");
const searchAuditDir = path.join(reportDir, "search-audit");
const interimAnalysisDir = path.join(reportDir, "interim-analysis");
const companyReportSchema = path.join(projectRoot, "scripts", "competitor-company.schema.json");
const primaryOfficialBlogRss = String(primaryCompany.officialBlogRss ?? "");
const ANALYSIS_PIPELINE_VERSION = "2026-11-06-v2";
const GOOGLE_NEWS_CACHE_TTL_MS = 5 * 60 * 1000;
const COMPANY_CHECKPOINT_TTL_MS = 60 * 60 * 1000;
let analysisRunning = false;
let precollectionRunning = false;
let activeAnalysisJobId: string | null = null;
let testEmailRunning = false;

type AnalysisProgress = {
  phase: "candidate-search" | "article-analysis" | "finalizing";
  totalTargets: number;
  completedTargets: number;
  activeCompanies: string[];
  completedCompanies: string[];
};

type AnalysisJob = {
  id: string;
  period: string;
  kind?: "final" | "interim";
  status: "running" | "completed" | "failed";
  startedAt: string;
  finishedAt?: string;
  progress: AnalysisProgress;
  report?: Record<string, any>;
  error?: string;
};

const analysisJobs = new Map<string, AnalysisJob>();

function briefPeriod(start: string, startTime: string, end: string, endTime: string): string {
  return `${start} ${startTime}~${end} ${endTime}`;
}

function precollectionPath(period: string): string {
  return path.join(precollectionDir, `${stableHash(`${ANALYSIS_PIPELINE_VERSION}|${period}`)}.json`);
}

function searchAuditPath(period: string): string {
  return path.join(searchAuditDir, `${stableHash(`${ANALYSIS_PIPELINE_VERSION}|${period}`)}.json`);
}

function interimAnalysisPath(start: string, end: string, startTime = "10:00", endTime = "10:00"): string {
  const window = briefPeriod(start, startTime, end, endTime);
  return path.join(interimAnalysisDir, `${stableHash(`${ANALYSIS_PIPELINE_VERSION}|${window}`)}.json`);
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonAtomically(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

async function appendCollectionMetric(entry: Record<string, any>): Promise<void> {
  const prior = await readJsonFile<Record<string, any>[]>(collectionMetricsPath) ?? [];
  prior.push(entry);
  await writeJsonAtomically(collectionMetricsPath, prior.slice(-365));
}

async function pruneExpiredJsonFiles(directory: string, maxAgeMs: number): Promise<void> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const cutoff = Date.now() - maxAgeMs;
    await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map(async (entry) => {
      const file = path.join(directory, entry.name);
      const stat = await fs.stat(file).catch(() => null);
      if (stat && stat.mtimeMs < cutoff) await fs.unlink(file).catch(() => {});
    }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function codexExecutable(): string {
  if (process.env.CODEX_EXE) return process.env.CODEX_EXE;
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin", "codex.exe");
  }
  return "codex";
}

async function readLatestReport() {
  try {
    return JSON.parse(await fs.readFile(latestReport, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

type StoredBrief = {
  period: string;
  generatedAt?: string;
  rawArticleCount?: number;
  articles?: Array<Record<string, any>>;
  reporterMentions?: Array<Record<string, any>>;
};

async function readBriefArchive(): Promise<StoredBrief[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(archivePath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readPendingBriefs(): Promise<StoredBrief[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(pendingBriefsPath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function articleKey(article: Record<string, any>): string {
  const url = String(article.url ?? "").trim().toLowerCase().replace(/\/$/, "");
  if (url) return `url:${url}`;
  // An issue identifies a topic, not an individual article. When no URL is
  // available, keep distinct outlet/title/date records distinct while still
  // deduplicating the same article across overlapping report runs.
  const company = String(article.company ?? "").trim().toLowerCase();
  const publisher = String(article.publisher ?? "").trim().toLowerCase();
  const title = String(article.title ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const publishedAt = String(article.publishedAt ?? "").trim().toLowerCase();
  if (publisher || title || publishedAt) return `article:${company}|${publisher}|${title}|${publishedAt}`;
  return `issue:${company}|${String(article.issueKey ?? article.topicKey ?? "").trim().toLowerCase()}`;
}

function issueKey(article: Record<string, any>): string {
  return `${String(article.company ?? "").trim().toLowerCase()}|${String(article.issueKey ?? article.topicKey ?? article.title ?? "").trim().toLowerCase()}`;
}

function representativeArticleScore(article: Record<string, any>): number[] {
  const accessRank: Record<string, number> = {
    "원문 전체 확인": 4,
    "공식 자료 확인": 3,
    "일부 본문 확인": 2,
    "제목·공개 정보만 확인": 1,
  };
  const reliabilityRank: Record<string, number> = { "높음": 3, "중간": 2, "낮음": 1, "확인 필요": 0 };
  const publishedAt = articlePublishedAt(article);
  return [
    article.isPrimarySource === true ? 1 : 0,
    accessRank[String(article.contentAccess ?? "")] ?? 0,
    reliabilityRank[String(article.sourceReliability ?? "")] ?? 0,
    /^https?:\/\//i.test(String(article.url ?? "")) ? 1 : 0,
    publishedAt === null ? 0 : -publishedAt,
  ];
}

function isBetterRepresentativeArticle(candidate: Record<string, any>, current: Record<string, any>): boolean {
  const candidateScore = representativeArticleScore(candidate);
  const currentScore = representativeArticleScore(current);
  for (let index = 0; index < candidateScore.length; index += 1) {
    if (candidateScore[index] !== currentScore[index]) return candidateScore[index] > currentScore[index];
  }
  return false;
}

function isPrimaryOfficialBlogArticle(article: Record<string, any>): boolean {
  if (String(article.company ?? "").trim() !== primaryCompanyName) return false;
  const publisher = String(article.publisher ?? "");
  const channel = String(article.channel ?? "");
  const sourceCategory = String(article.sourceCategory ?? "");
  const url = String(article.url ?? "");
  const blogSource = String(article.source_type ?? "") === "official_blog"
    || sourceCategory === "블로그" || /블로그|\bblog\b/i.test(`${publisher} ${channel}`);
  const ownedNames = [primaryCompanyName, ...(primaryCompany.aliases ?? [])].filter(Boolean).map((value: unknown) => String(value).toLowerCase());
  const sourceText = `${publisher} ${channel}`.toLowerCase();
  const ownedByName = ownedNames.some((name) => name && sourceText.includes(name));
  const ownedByConfiguredUrl = (primaryCompany.officialBlogUrlPatterns ?? []).some((pattern: unknown) => {
    try { return new RegExp(String(pattern), "i").test(url); } catch { return false; }
  });
  return blogSource && (/자사|공식/i.test(`${publisher} ${channel}`) || ownedByName || ownedByConfiguredUrl);
}

function isPrimaryOwnedContentArticle(article: Record<string, any>): boolean {
  return String(article.company ?? "").trim() === primaryCompanyName
    && (isPrimaryOfficialBlogArticle(article) || String(article.subjectRelation ?? "").trim() === "자사 공식 발신");
}

function collectionPeriodSummary(runs: StoredBrief[]): string {
  const periods = runs.map((run) => String(run.period ?? "").trim()).filter(Boolean);
  if (!periods.length) return "누적 기사 수집 기간 정보 없음";
  const bounds = periods.map((period) => period.split("~").map((part) => part.trim())).filter((parts) => parts.length === 2);
  const parseKst = (value: string) => {
    const match = value.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})$/);
    return match ? Date.parse(`${match[1]}T${match[2]}:00+09:00`) : Number.NaN;
  };
  let hasGap = false;
  let hasOverlap = false;
  for (let index = 1; index < bounds.length; index += 1) {
    const previousEnd = parseKst(bounds[index - 1][1]);
    const nextStart = parseKst(bounds[index][0]);
    if (!Number.isNaN(previousEnd) && !Number.isNaN(nextStart)) {
      if (nextStart > previousEnd) hasGap = true;
      if (nextStart < previousEnd) hasOverlap = true;
    }
  }
  const start = bounds[0]?.[0] ?? "기간 확인 불가";
  const end = bounds.at(-1)?.[1] ?? "기간 확인 불가";
  const caveat = [hasGap ? "중간 공백 있음" : "", hasOverlap ? "일부 기간 겹침" : ""].filter(Boolean).join("·");
  return `${start}~${end} · 저장 보고서 ${periods.length}회분${caveat ? ` (${caveat})` : ""}`;
}

function articlePublishedAt(article: Record<string, any>): number | null {
  let value = String(article.publishedAt ?? "").trim();
  if (!value) return null;
  const hasSeoulSuffix = /(?:\s|\[)(?:Asia\/Seoul|KST)\]?\s*$/i.test(value);
  value = value.replace(/(?:\s|\[)(?:Asia\/Seoul|KST)\]?\s*$/i, "").replace(/\s+(?:UTC|GMT)$/i, "Z");
  const hasExplicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  if (!hasExplicitZone && (/^\d{4}-\d{2}-\d{2}[T ]/.test(value) || hasSeoulSuffix)) value = `${value.replace(" ", "T")}${hasSeoulSuffix ? "+09:00" : "+09:00"}`;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function eventTerms(article: Record<string, any>): Set<string> {
  const company = String(article.company ?? "").toLowerCase().replace(/\s+/g, "");
  const source = [article.issueKey, article.topicKey, article.title, ...(article.keywords ?? [])]
    .filter(Boolean).join(" ").toLowerCase().replace(/[^0-9a-z가-힣]+/g, " ");
  const canonical = source
    .replace(/업무 협약|업무협약|파트너십|제휴|맞손|손잡(?:고|은|았다|는다)?|mou|협력/g, " 협력 ")
    .replace(/기업공개|상장 추진|ipo/g, " 상장 ")
    .replace(/도입 구축/g, " 도입 ");
  const stopWords = new Set([
    ...allMonitoringTargets.flatMap((target) => [target.name, ...(target.aliases ?? []), ...(target.brands ?? [])]),
    "관련", "통해", "위해", "대한", "대해", "발표", "공개", "추진", "강화", "확대", "제공", "사업", "서비스", "기업", "시장", "기반", "계획", "진행", "신규", "최초", "국내", "글로벌",
  ].map((value) => String(value ?? "").trim()).filter(Boolean));
  return new Set(canonical.split(/\s+/).map((term) => term.replace(/(에서|으로|에게|부터|까지|보다|와|과|은|는|이|가|을|를|의|에|로|도|만|와|과)$/u, ""))
    .filter((term) => term.length >= 2 && !stopWords.has(term) && term.replace(/\s+/g, "") !== company));
}

function sameNewsIssue(left: Record<string, any>, right: Record<string, any>): boolean {
  if (String(left.company ?? "").trim().toLowerCase() !== String(right.company ?? "").trim().toLowerCase()) return false;
  const leftSource = left.source_type === "official_blog" ? "official_blog" : "other";
  const rightSource = right.source_type === "official_blog" ? "official_blog" : "other";
  if (leftSource !== rightSource) return false;
  const leftTime = articlePublishedAt(left);
  const rightTime = articlePublishedAt(right);
  if (leftTime === null || rightTime === null || Math.abs(leftTime - rightTime) > 72 * 60 * 60 * 1000) return false;
  const normalizeKey = (value: unknown) => String(value ?? "").toLowerCase().replace(/[^0-9a-z가-힣]+/g, " ").trim();
  const exactIssueKey = normalizeKey(left.issueKey);
  if (exactIssueKey && exactIssueKey === normalizeKey(right.issueKey)) return true;
  const leftTerms = eventTerms(left);
  const rightTerms = eventTerms(right);
  const overlap = [...leftTerms].filter((term) => rightTerms.has(term)).length;
  const smallest = Math.min(leftTerms.size, rightTerms.size);
  return overlap >= 2 || (overlap >= 1 && smallest > 0 && overlap / smallest >= 0.75);
}

function isWithinPublicationWindow(article: Record<string, any>, start: string, startTime: string, end: string, endTime: string): boolean {
  const publishedAt = articlePublishedAt(article);
  if (publishedAt === null) return false;
  const startAt = Date.parse(`${start}T${startTime}:00+09:00`);
  const endAt = Date.parse(`${end}T${endTime}:00+09:00`);
  return publishedAt > startAt && publishedAt <= endAt;
}

function decodeXmlText(value: string): string {
  const cdata = value.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  const source = (cdata ? cdata[1] : value).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  return source
    .replace(/&#x([\da-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")
    .trim();
}

function xmlTagValue(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "i"));
  return match ? decodeXmlText(match[1]) : "";
}

type PrimaryBlogEntry = { title: string; url: string; publishedAt: string; excerpt: string };
type PrimaryBlogFeed = { ok: boolean; totalEntries: number; eligibleEntries: PrimaryBlogEntry[]; missingDateCount: number; error?: string };

type GoogleNewsCandidate = {
  title: string;
  publisher: string;
  url: string;
  publishedAt: string;
  snippet: string;
  query: string;
};

type GoogleNewsSearchResult = {
  queries: string[];
  queryCounts: Array<{ query: string; count: number }>;
  candidates: GoogleNewsCandidate[];
  errors: string[];
  cacheHit?: boolean;
};

function googleNewsQueries(target: { company: string }, searchPass?: number): string[] {
  const settings = allMonitoringTargets.find((item) => String(item.name ?? "") === target.company);
  const passKey = !searchPass || searchPass === 1 ? "base" : `pass${searchPass}`;
  const queries = settings?.searchQueries?.[passKey];
  return Array.isArray(queries) ? queries.map((query: unknown) => String(query).trim()).filter(Boolean) : [];
}

function dateOffset(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function parseGoogleNewsCandidates(xml: string, query: string): GoogleNewsCandidate[] {
  const items = (xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? []).slice(0, 40);
  return items.flatMap((item) => {
    const title = xmlTagValue(item, "title");
    const url = xmlTagValue(item, "link");
    const published = Date.parse(xmlTagValue(item, "pubDate"));
    if (!title || !url || Number.isNaN(published)) return [];
    return [{
      title,
      publisher: xmlTagValue(item, "source") || "매체 확인 필요",
      url,
      publishedAt: new Date(published).toISOString(),
      snippet: xmlTagValue(item, "description").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 320),
      query,
    }];
  });
}

async function loadGoogleNewsCandidates(
  target: { company: string },
  start: string,
  end: string,
  forceRefresh = false,
  searchPass?: number,
): Promise<GoogleNewsSearchResult> {
  const queries = googleNewsQueries(target, searchPass);
  const cacheKey = stableHash(JSON.stringify({ version: ANALYSIS_PIPELINE_VERSION, target: target.company, searchPass: searchPass ?? 0, queries, start, end }));
  const cacheFile = path.join(searchCacheDir, `google-news-${cacheKey}.json`);
  if (!forceRefresh) {
    const cached = await readJsonFile<{ cachedAt: string; result: GoogleNewsSearchResult }>(cacheFile);
    const age = cached ? Date.now() - Date.parse(cached.cachedAt) : Number.POSITIVE_INFINITY;
    const ttl = cached?.result.errors.length ? Math.min(GOOGLE_NEWS_CACHE_TTL_MS, 30_000) : GOOGLE_NEWS_CACHE_TTL_MS;
    if (cached && Number.isFinite(age) && age >= 0 && age < ttl) return { ...cached.result, cacheHit: true };
  }
  const results = await Promise.all(queries.map(async (query) => {
    // Expand the date-only RSS filter by one day at both ends. Google News
    // timestamps are discovery hints; exact period inclusion is checked on the
    // original publisher page by Codex before an article enters the report.
    const dateQuery = `${query} after:${dateOffset(start, -1)} before:${dateOffset(end, 1)}`;
    const params = new URLSearchParams({ q: dateQuery, hl: "ko", gl: "KR", ceid: "KR:ko" });
    try {
      const response = await fetch(`https://news.google.com/rss/search?${params}`, {
        headers: { "User-Agent": "PAPR-primary-PR-Monitor/1.0", Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.5" },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { query, candidates: parseGoogleNewsCandidates(await response.text(), query), error: "" };
    } catch (error) {
      return { query, candidates: [] as GoogleNewsCandidate[], error: error instanceof Error ? error.message : String(error) };
    }
  }));
  const unique = new Map<string, GoogleNewsCandidate>();
  for (const result of results) {
    for (const candidate of result.candidates) {
      const key = candidate.url.toLowerCase().replace(/\/$/, "");
      if (!unique.has(key)) unique.set(key, candidate);
    }
  }
  const result = {
    queries,
    queryCounts: results.map((result) => ({ query: result.query, count: result.candidates.length })),
    candidates: [...unique.values()].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)),
    errors: results.filter((result) => result.error).map((result) => `${result.query}: ${result.error}`),
    cacheHit: false,
  };
  await writeJsonAtomically(cacheFile, { cachedAt: new Date().toISOString(), result }).catch(() => {});
  return result;
}

type CompanyCheckpoint = {
  version: string;
  period: string;
  company: string;
  completedAt: string;
  result: Record<string, any>;
};

function companyCheckpointPath(period: string, company: string): string {
  const key = stableHash(`${ANALYSIS_PIPELINE_VERSION}|${period}|${company}`);
  return path.join(companyCheckpointDir, `${key}.json`);
}

async function readCompanyCheckpoint(period: string, company: string): Promise<Record<string, any> | null> {
  const checkpoint = await readJsonFile<CompanyCheckpoint>(companyCheckpointPath(period, company));
  if (!checkpoint || checkpoint.version !== ANALYSIS_PIPELINE_VERSION || checkpoint.period !== period || checkpoint.company !== company) return null;
  const age = Date.now() - Date.parse(checkpoint.completedAt);
  if (!Number.isFinite(age) || age < 0 || age > COMPANY_CHECKPOINT_TTL_MS || checkpoint.result?.searched !== true) return null;
  return checkpoint.result;
}

async function loadPrimaryOfficialBlog(start: string, startTime: string, end: string, endTime: string): Promise<PrimaryBlogFeed> {
  if (!primaryOfficialBlogRss) {
    return { ok: false, totalEntries: 0, eligibleEntries: [], missingDateCount: 0, error: "공식 블로그 RSS가 로컬 설정에 입력되지 않았습니다." };
  }
  try {
    const response = await fetch(primaryOfficialBlogRss, {
      headers: {
        "User-Agent": "PAPR-primary-PR-Monitor/1.0",
        Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.5",
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`RSS HTTP ${response.status}`);
    const xml = await response.text();
    const items = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi)].map((match) => match[1]);
    const missingDateCount = items.filter((item) => !Date.parse(xmlTagValue(item, "pubDate"))).length;
    const eligibleEntries = items.flatMap((item) => {
      const title = xmlTagValue(item, "title");
      const url = xmlTagValue(item, "link");
      const timestamp = Date.parse(xmlTagValue(item, "pubDate"));
      if (!title || !url || Number.isNaN(timestamp)) return [];
      const entry = {
        title,
        url,
        publishedAt: new Date(timestamp).toISOString(),
        excerpt: xmlTagValue(item, "description").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 2400),
      };
      return isWithinPublicationWindow(entry, start, startTime, end, endTime) ? [entry] : [];
    });
    return { ok: true, totalEntries: items.length, eligibleEntries, missingDateCount };
  } catch (error) {
    return {
      ok: false,
      totalEntries: 0,
      eligibleEntries: [],
      missingDateCount: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function precollectBriefCandidates(period: string, start: string, startTime: string, end: string, endTime: string, searchPass = 1): Promise<Record<string, any>> {
  const companies = allMonitoringTargets.map((target) => String(target.name ?? "").trim()).filter(Boolean);
  const [blogFeed, ...googleResults] = await Promise.all([
    loadPrimaryOfficialBlog(start, startTime, end, endTime),
    ...companies.map((company) => loadGoogleNewsCandidates({ company }, start, end, true, searchPass)),
  ]);
  const previous = await readJsonFile<Record<string, any>>(precollectionPath(period));
  const priorByCompany = new Map<string, GoogleNewsSearchResult>(Object.entries(previous?.googleNewsByCompany ?? {}));
  const googleNewsByCompany: Record<string, GoogleNewsSearchResult> = {};
  const deltas: Record<string, number> = {};
  for (let index = 0; index < companies.length; index += 1) {
    const company = companies[index];
    const fresh = googleResults[index];
    const prior = priorByCompany.get(company);
    const candidates = new Map<string, GoogleNewsCandidate>();
    for (const candidate of [...(prior?.candidates ?? []), ...fresh.candidates]) {
      const key = candidate.url.trim().toLowerCase().replace(/\/$/, "");
      if (key && !candidates.has(key)) candidates.set(key, candidate);
    }
    deltas[company] = [...candidates.keys()].filter((key) => !new Set((prior?.candidates ?? []).map((item) => item.url.trim().toLowerCase().replace(/\/$/, ""))).has(key)).length;
    googleNewsByCompany[company] = {
      queries: [...new Set([...(prior?.queries ?? []), ...fresh.queries])],
      queryCounts: fresh.queryCounts,
      candidates: [...candidates.values()].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)),
      errors: [...new Set([...(prior?.errors ?? []), ...fresh.errors])],
      cacheHit: false,
    };
  }
  const savedPrimaryBlogFeed = previous?.primaryBlogFeed;
  const priorBlog = Array.isArray(savedPrimaryBlogFeed?.eligibleEntries) ? savedPrimaryBlogFeed.eligibleEntries : [];
  const blogByUrl = new Map<string, PrimaryBlogEntry>();
  for (const entry of [...priorBlog, ...blogFeed.eligibleEntries]) {
    const key = entry.url.trim().toLowerCase().replace(/\/$/, "");
    if (key) blogByUrl.set(key, entry);
  }
  const capturedAt = new Date().toISOString();
  const passRecord = {
    pass: searchPass,
    capturedAt,
    candidateCounts: Object.fromEntries(companies.map((company) => [company, googleNewsByCompany[company].candidates.length])),
    newCandidateCounts: { ...deltas },
    queriesByCompany: Object.fromEntries(companies.map((company, index) => [company, googleResults[index].queries])),
  };
  const searchPasses = [
    ...(Array.isArray(previous?.searchPasses) ? previous.searchPasses.filter((item: Record<string, any>) => Number(item.pass) !== searchPass) : []),
    passRecord,
  ].sort((a, b) => a.pass - b.pass);
  const snapshot = {
    version: ANALYSIS_PIPELINE_VERSION,
    period,
    capturedAt,
    searchPasses,
    googleNewsByCompany,
    primaryBlogFeed: { ...blogFeed, eligibleEntries: [...blogByUrl.values()] },
    newCandidateCounts: deltas,
  };
  await fs.mkdir(precollectionDir, { recursive: true });
  await writeJsonAtomically(precollectionPath(period), snapshot);
  return snapshot;
}

function mergeSamePeriodArticles(current: Array<Record<string, any>>, previous: Array<Record<string, any>>): Array<Record<string, any>> {
  // Reruns can assign a different issueKey to the same source article. Deduplicate
  // by canonical article URL, not issue/topic, so distinct articles remain distinct.
  const merged = new Map(current.map((article) => [articleKey(article), { ...article }]));
  for (const prior of previous) {
    const key = articleKey(prior);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, prior);
      continue;
    }
    const links = [...(existing.coverageLinks ?? []), ...(prior.coverageLinks ?? [])];
    if (prior.url && prior.url !== existing.url && prior.publisher) {
      links.push({ publisher: prior.publisher, url: prior.url, title: prior.title ?? "" });
    }
    const uniqueLinks = links.filter((link, index) => link.url && /^https?:\/\//i.test(String(link.url))
      && String(link.url) !== String(existing.url)
      && links.findIndex((candidate) => candidate.url === link.url) === index);
    const outlets = [...new Set([
      ...(existing.coverageOutlets ?? []), ...(prior.coverageOutlets ?? []),
      ...uniqueLinks.map((link) => String(link.publisher ?? "")).filter(Boolean),
    ])];
    merged.set(key, {
      ...existing,
      coverageLinks: uniqueLinks,
      coverageOutlets: outlets,
      coverageCount: Math.max(Number(existing.coverageCount ?? 1), Number(prior.coverageCount ?? 1), uniqueLinks.length + 1),
      additionalFacts: [...new Set([...(existing.additionalFacts ?? []), ...(prior.additionalFacts ?? [])].filter(Boolean))],
    });
  }
  return [...merged.values()];
}

function rollingInsights(history: StoredBrief[], asOf: string, includeAllRetained = false) {
  const cutoff = Date.parse(asOf) - 28 * 24 * 60 * 60 * 1000;
  const recentRuns = includeAllRetained ? history : history.filter((run) => {
    const stamp = Date.parse(String(run.generatedAt ?? ""));
    return Number.isNaN(stamp) || stamp >= cutoff;
  });
  const uniqueArticles = new Map<string, Record<string, any>>();
  for (const run of recentRuns) {
    for (const article of run.articles ?? []) {
      const key = articleKey(article);
      if (!uniqueArticles.has(key)) uniqueArticles.set(key, article);
    }
  }
  const issueMap = new Map<string, { article: Record<string, any>; coverageCount: number; outlets: Set<string>; dates: Set<string> }>();
  for (const article of uniqueArticles.values()) {
    const key = issueKey(article);
    const current = issueMap.get(key) ?? { article, coverageCount: 0, outlets: new Set<string>(), dates: new Set<string>() };
    // Count each distinct article; coverageCount preserves additional known
    // outlets bundled with a representative article.
    current.coverageCount += Math.max(1, Number(article.coverageCount ?? 1));
    const publisher = String(article.publisher ?? "").trim();
    if (publisher) current.outlets.add(publisher);
    for (const outlet of article.coverageOutlets ?? []) if (String(outlet).trim()) current.outlets.add(String(outlet).trim());
    const day = String(article.publishedAt ?? "").slice(0, 10);
    if (day) current.dates.add(day);
    if (isBetterRepresentativeArticle(article, current.article)) current.article = article;
    issueMap.set(key, current);
  }

  const companyMap = new Map<string, { issueCount: number; exposureCount: number; highSignal: boolean }>();
  for (const item of issueMap.values()) {
    const company = String(item.article.company ?? "").trim();
    if (!company) continue;
    const current = companyMap.get(company) ?? { issueCount: 0, exposureCount: 0, highSignal: false };
    current.issueCount += 1;
    current.exposureCount += item.coverageCount;
    current.highSignal = current.highSignal || item.article.importance === "높음" || item.article.threat === "높음";
    companyMap.set(company, current);
  }
  const mediaMap = new Map<string, number>();
  // Overlapping saved runs must not inflate rankings: count distinct source
  // articles (by articleKey) once, while still including bundled coverage outlets.
  for (const article of uniqueArticles.values()) {
    const articleOutlets = new Set<string>();
    const publisher = String(article.publisher ?? "").trim();
    if (publisher) articleOutlets.add(publisher);
    for (const outlet of article.coverageOutlets ?? []) {
      const name = String(outlet).trim();
      if (name) articleOutlets.add(name);
    }
    for (const name of articleOutlets) mediaMap.set(name, (mediaMap.get(name) ?? 0) + 1);
  }
  const normalizeReporterPublisher = (value: string) => {
    const publisher = value.trim();
    if (/디지털투데이|digitaltoday/i.test(publisher)) return "디지털투데이";
    if (/한스경제/.test(publisher)) return "한스경제";
    if (/전자신문|etnews/i.test(publisher)) return "전자신문";
    if (/테크월드|techworld/i.test(publisher)) return "테크월드";
    if (/매일경제|mk\.co\.kr/i.test(publisher)) return "매일경제";
    if (/연합뉴스|yna\.co\.kr/i.test(publisher)) return "연합뉴스";
    if (/뉴시스|newsis/i.test(publisher)) return "뉴시스";
    if (/이투데이|etoday\.co\.kr/i.test(publisher)) return "이투데이";
    if (/zdnet|지디넷/i.test(publisher)) return "ZDNet Korea";
    return publisher.replace(/\s+/g, " ");
  };
  const reporterMap = new Map<string, { count: number; contacts: Map<string, { value: string; url: string; publisher: string; title: string }>; publishers: Map<string, number> }>();
  // 기자는 동일 이슈로 묶기 전 원문 행에서 집계하고, 기사에 공개된 기자 직통 업무 연락처만 출처 URL과 함께 보관합니다.
  const reporterMentions = recentRuns.flatMap((run) => run.reporterMentions?.length
    ? run.reporterMentions
    : (run.articles ?? []).map((article) => ({
      reporter: article.reporter,
      reporterContact: article.reporterContact,
      url: article.url,
      publisher: article.publisher,
      title: article.title,
    })));
  const uniqueReporterMentions = new Map<string, Record<string, any>>();
  for (const article of reporterMentions) {
    const url = String(article.url ?? "").trim().replace(/\/$/, "").toLowerCase();
    const key = url || `${String(article.publisher ?? "").trim().toLowerCase()}|${String(article.title ?? "").trim().toLowerCase()}|${String(article.publishedAt ?? "").trim()}`;
    const previous = uniqueReporterMentions.get(key);
    const reporter = String(article.reporter ?? "").trim();
    const previousReporter = String(previous?.reporter ?? "").trim();
    if (!previous || ((!previousReporter || /확인 불가|미확인/.test(previousReporter)) && reporter && !/확인 불가|미확인/.test(reporter))) {
      uniqueReporterMentions.set(key, article);
    }
  }
  for (const article of uniqueReporterMentions.values()) {
    const publisher = String(article.publisher ?? "").trim();
    const reporter = String(article.reporter ?? "").trim();
    if (!reporter || /확인 불가|미확인/.test(reporter)) continue;
    const current = reporterMap.get(reporter) ?? { count: 0, contacts: new Map(), publishers: new Map() };
    current.count += 1;
    const normalizedPublisher = normalizeReporterPublisher(publisher);
    if (normalizedPublisher) current.publishers.set(normalizedPublisher, (current.publishers.get(normalizedPublisher) ?? 0) + 1);
    const contact = String(article.reporterContact ?? "").trim();
    const url = String(article.url ?? "").trim();
    if (contact && /^https?:\/\//i.test(url)) {
      current.contacts.set(contact.toLowerCase(), {
        value: contact,
        url,
        publisher,
        title: String(article.title ?? ""),
      });
    }
    reporterMap.set(reporter, current);
  }
  const sortCounts = (map: Map<string, number>) => [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ko"));
  const companies = [...companyMap.entries()]
    .map(([name, value]) => ({ name, ...value }))
    .sort((a, b) => b.exposureCount - a.exposureCount || b.issueCount - a.issueCount);
  const repeatedTopicGroups = new Map<string, { company: string; topicKey: string; article: Record<string, any>; coverageCount: number; outlets: Set<string>; dates: Set<string>; sourceArticles: Map<string, { title: string; publisher: string; url: string; publishedAt: string }> }>();
  for (const item of issueMap.values()) {
    const company = String(item.article.company ?? "").trim();
    const topicKeyText = [item.article.topicKey, item.article.issueKey].filter(Boolean).join(" ").toLowerCase();
    const topicText = [topicKeyText, item.article.keyMessage, item.article.summary, item.article.uniqueInformation, ...(item.article.keywords ?? [])]
      .filter(Boolean).join(" ").toLowerCase();
    let familyKey = String(item.article.topicKey ?? item.article.issueKey ?? item.article.title ?? "").trim().toLowerCase();
    let familyLabel = String(item.article.topicKey ?? item.article.issueKey ?? item.article.title ?? "관련 소재").trim();
    // 같은 이슈가 서로 다른 키로 저장된 경우, 기업별 핵심 소재군으로 합쳐 표시합니다.
    const topicLabel = String(item.article.topicKey ?? "").toLowerCase();
    const issueLabel = String(item.article.issueKey ?? "").toLowerCase();
    const ipoPattern = /\bipo\b|기업공개|상장|수요예측|공모주|기업가치/;
    const infrastructurePattern = /(?:클라우드|인프라|고속도로|\bpmdc\b|infrastructure)/i;
    if (ipoPattern.test(topicLabel)) {
      familyKey = "ipo-listing";
      familyLabel = "IPO·상장 추진";
    } else if (infrastructurePattern.test(topicLabel) && /\bai\b/i.test(topicText)) {
      familyKey = "ai-education-infrastructure";
      familyLabel = "AI 교육·클라우드 인프라 전략";
    } else if (ipoPattern.test(issueLabel)) {
      familyKey = "ipo-listing";
      familyLabel = "IPO·상장 추진";
    } else if (/(?:workday|워크데이)/i.test(topicText) && /(?:\bhr\b|채용|인사|recruit)/i.test(topicText)) {
      familyKey = "workday-global-hr";
      familyLabel = "워크데이 글로벌 HR·채용 제휴";
    } else if (/\bai\b/i.test(topicText) && infrastructurePattern.test(topicText)) {
      familyKey = "ai-education-infrastructure";
      familyLabel = "AI 교육·클라우드 인프라 전략";
    }
    const groupKey = `${company.toLowerCase()}|${familyKey}`;
    const current = repeatedTopicGroups.get(groupKey) ?? {
      company,
      topicKey: familyLabel,
      article: item.article,
      coverageCount: 0,
      outlets: new Set<string>(),
      dates: new Set<string>(),
      sourceArticles: new Map(),
    };
    current.coverageCount += item.coverageCount;
    for (const outlet of item.outlets) current.outlets.add(outlet);
    for (const date of item.dates) current.dates.add(date);
    const addSourceArticle = (source: Record<string, any>) => {
      const title = String(source.title ?? "").trim();
      const publisher = String(source.publisher ?? "").trim();
      const url = String(source.url ?? "").trim();
      if (!title && !publisher) return;
      const sourceKey = url.toLowerCase() || `${publisher.toLowerCase()}|${title.toLowerCase()}`;
      const existing = current.sourceArticles.get(sourceKey);
      if (!existing || (!existing.publisher && publisher) || (!existing.title && title)) {
        current.sourceArticles.set(sourceKey, {
          title: title || "기사 제목 확인 불가",
          publisher: publisher || "매체 확인 불가",
          url,
          publishedAt: String(source.publishedAt ?? ""),
        });
      }
    };
    addSourceArticle(item.article);
    for (const link of item.article.coverageLinks ?? []) addSourceArticle(link);
    if (isBetterRepresentativeArticle(item.article, current.article)) current.article = item.article;
    repeatedTopicGroups.set(groupKey, current);
  }
  const repeatedIssues = [...repeatedTopicGroups.values()]
    .filter((item) => item.company !== primaryCompanyName && (item.coverageCount > 1 || item.dates.size > 1))
    .map((item) => ({
      company: item.company,
      collectionGroup: item.article.collectionGroup ?? (item.company === primaryCompanyName ? "A" : designatedCompetitors.some((target) => String(target.name ?? "") === item.company) ? "B" : "C"),
      topicKey: item.topicKey,
      description: String(item.article.keyMessage ?? item.article.summary ?? item.article.uniqueInformation ?? "")
        .replace(/\s+/g, " ").trim(),
      coverageCount: item.coverageCount,
      representativeTitle: String(item.article.title ?? ""),
      representativePublisher: String(item.article.publisher ?? ""),
      representativeUrl: String(item.article.url ?? ""),
      representativePublishedAt: String(item.article.publishedAt ?? ""),
      dates: [...item.dates].sort(),
      outlets: [...item.outlets].sort(),
      sourceArticles: [...item.sourceArticles.values()]
        .sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0) || a.publisher.localeCompare(b.publisher, "ko") || a.title.localeCompare(b.title, "ko")),
      unmatchedArticleCount: Math.max(0, item.coverageCount - item.sourceArticles.size),
    }))
    .sort((a, b) => b.coverageCount - a.coverageCount || a.company.localeCompare(b.company, "ko"));
  const trackedCompanies = new Set(designatedCompetitors.map((target) => String(target.name ?? "").toLowerCase()));
  const excludedFromCandidates = new Set((comparableBusinesses.excludedCandidates ?? []).map((name: unknown) => String(name).toLowerCase()));
  const candidates = companies
    .filter((item) => item.name !== primaryCompanyName && !trackedCompanies.has(item.name.toLowerCase()) && !excludedFromCandidates.has(item.name.toLowerCase()) && (item.issueCount >= 2 || item.highSignal))
    .slice(0, 4)
    .map((item) => {
      const candidateIssues = [...issueMap.values()].filter((issue) => String(issue.article.company ?? "").trim() === item.name);
      const materialCounts = new Map<string, number>();
      for (const issue of candidateIssues) {
        const article = issue.article;
        const topic = String(article.topicKey ?? "").trim().replace(/[_-]+/g, " ");
        const readableTopic = /[가-힣]/.test(topic) && topic.length <= 36 && !/(?:다|요|죠|습니다)[.!?。]*$/.test(topic);
        const keywords = Array.isArray(article.keywords)
          ? article.keywords.map((keyword: unknown) => String(keyword ?? "").replace(/^#+/, "").trim()).filter((keyword: string) => keyword && keyword !== item.name && keyword.length <= 24)
          : [];
        const labels = readableTopic ? [topic] : keywords.slice(0, 4);
        for (const label of labels) materialCounts.set(label, (materialCounts.get(label) ?? 0) + Math.max(1, Number(issue.coverageCount ?? 1)));
      }
      const mainTopics = [...materialCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ko"))
        .slice(0, 2)
        .map(([label]) => label);
      return {
        ...item,
        mainTopics,
        reason: item.highSignal ? "중요도·위협도 높은 이슈 포함" : `${includeAllRetained ? "보관 누적기간" : "최근 4주"} 2개 이상 이슈 노출`,
        sourceArticles: [...uniqueArticles.values()]
          .filter((article) => String(article.company ?? "").trim() === item.name && /^https?:\/\//i.test(String(article.url ?? "")))
          .sort((a, b) => (articlePublishedAt(b) ?? 0) - (articlePublishedAt(a) ?? 0))
          .slice(0, 3)
          .map((article) => ({ title: String(article.title ?? ""), publisher: String(article.publisher ?? ""), url: String(article.url ?? "") })),
      };
    });
  const highSignalItems = [...issueMap.values()]
    .filter((item) => item.article.importance === "높음" || item.article.threat === "높음")
    .sort((a, b) => {
      const aScore = (a.article.threat === "높음" ? 2 : 0) + (a.article.importance === "높음" ? 1 : 0);
      const bScore = (b.article.threat === "높음" ? 2 : 0) + (b.article.importance === "높음" ? 1 : 0);
      return bScore - aScore || b.coverageCount - a.coverageCount;
    });
  const primaryArticles = [...uniqueArticles.values()].filter((article) => String(article.company ?? "").trim() === primaryCompanyName);
  const primaryOwnedArticles = primaryArticles.filter(isPrimaryOwnedContentArticle);
  const primaryPressArticles = primaryArticles.filter((article) => !isPrimaryOwnedContentArticle(article));
  const primaryToneCounts = new Map<string, number>();
  const primaryRelationCounts = new Map<string, number>();
  const primaryTopicCounts = new Map<string, number>();
  const primaryTopicArticles = new Map<string, Record<string, any>[]>();
  const primaryNewsTopicGroups = new Map<string, { count: number; articles: Record<string, any>[] }>();
  const primaryBlogTopicGroups = new Map<string, { count: number; articles: Record<string, any>[] }>();
  // 출처 유형과 무관하게 주 대상 관련 콘텐츠 전체를 평판 지표에 반영합니다.
  // 자사 공식 콘텐츠도 우호·중립·비판 여부를 별도로 판단합니다.
  for (const article of primaryArticles) {
    const tone = String(article.tone ?? "판단 보류");
    const relation = String(article.subjectRelation ?? "분류 확인 필요");
    const exposureCount = Math.max(1, Number(article.coverageCount ?? 1));
    primaryToneCounts.set(tone, (primaryToneCounts.get(tone) ?? 0) + exposureCount);
    primaryRelationCounts.set(relation, (primaryRelationCounts.get(relation) ?? 0) + exposureCount);
  }
  const normalizePrimaryTopic = (article: Record<string, any>): string => {
    const rawTopic = String(article.topicKey ?? article.issueKey ?? "기타").trim();
    const articleContext = [
      rawTopic,
      article.issueKey,
      article.title,
      article.keyMessage,
      ...(Array.isArray(article.keywords) ? article.keywords : []),
    ].map((value) => String(value ?? "")).join(" ").toLowerCase();
    return rawTopic;
  };
  const isPrimaryBlogArticle = (article: Record<string, any>): boolean =>
    /블로그|\bblog\b|카페|커뮤니티/i.test(`${article.publisher ?? ""} ${article.channel ?? ""} ${article.sourceCategory ?? ""}`)
      || /(?:blog\.naver\.com|tistory\.com|brunch\.co\.kr|cafe\.naver\.com)/i.test(String(article.url ?? ""));
  for (const article of primaryArticles) {
    const topic = normalizePrimaryTopic(article);
    const exposureCount = Math.max(1, Number(article.coverageCount ?? 1));
    primaryTopicCounts.set(topic, (primaryTopicCounts.get(topic) ?? 0) + exposureCount);
    const sources = primaryTopicArticles.get(topic) ?? [];
    sources.push(article);
    primaryTopicArticles.set(topic, sources);
    const categoryGroups = isPrimaryBlogArticle(article) ? primaryBlogTopicGroups : primaryNewsTopicGroups;
    const categoryGroup = categoryGroups.get(topic) ?? { count: 0, articles: [] };
    categoryGroup.count += exposureCount;
    categoryGroup.articles.push(article);
    categoryGroups.set(topic, categoryGroup);
  }
  const summarizeprimaryTopicGroups = (groups: Map<string, { count: number; articles: Record<string, any>[] }>) =>
    [...groups.entries()].map(([name, group]) => {
      const validArticles = group.articles.filter((article) => /^https?:\/\//i.test(String(article.url ?? "")));
      const representative = validArticles.reduce<Record<string, any> | null>(
        (best, article) => !best || isBetterRepresentativeArticle(article, best) ? article : best,
        null,
      );
      return {
        name,
        count: group.count,
        representativeArticle: representative ? {
          title: String(representative.title ?? "원문 보기"),
          publisher: String(representative.publisher ?? ""),
          url: String(representative.url ?? ""),
        } : null,
        sourceArticles: validArticles.slice(0, 3).map((article) => ({
          title: String(article.title ?? ""),
          publisher: String(article.publisher ?? ""),
          url: String(article.url ?? ""),
        })),
      };
    }).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ko")).slice(0, 5);
  const primaryRiskSignals = primaryArticles
    .filter((article) => article.reputationRisk === "높음" || article.tone === "비판")
    .sort((a, b) => (a.reputationRisk === "높음" ? -1 : 0) - (b.reputationRisk === "높음" ? -1 : 0))
    .slice(0, 8)
    .map((article) => ({
      title: String(article.title ?? ""),
      publisher: String(article.publisher ?? ""),
      publishedAt: String(article.publishedAt ?? ""),
      url: String(article.url ?? ""),
      tone: String(article.tone ?? "판단 보류"),
      reputationRisk: String(article.reputationRisk ?? "낮음"),
      reason: String(article.reputationRiskReason ?? article.toneReason ?? article.threatReason ?? article.importanceReason ?? "원문에서 구체적 근거를 확인하세요."),
    }));
  const primaryExternalContentCount = primaryPressArticles.reduce((sum, article) => sum + Math.max(1, Number(article.coverageCount ?? 1)), 0);
  const primaryOwnedContentCount = primaryOwnedArticles.reduce((sum, article) => sum + Math.max(1, Number(article.coverageCount ?? 1)), 0);
  const primaryNewsContentCount = primaryArticles.filter((article) => !isPrimaryBlogArticle(article)).reduce((sum, article) => sum + Math.max(1, Number(article.coverageCount ?? 1)), 0);
  const primaryBlogContentCount = primaryArticles.filter(isPrimaryBlogArticle).reduce((sum, article) => sum + Math.max(1, Number(article.coverageCount ?? 1)), 0);
  const primaryReputation = {
    contentCount: primaryArticles.reduce((sum, article) => sum + Math.max(1, Number(article.coverageCount ?? 1)), 0),
    externalContentCount: primaryExternalContentCount,
    ownedContentCount: primaryOwnedContentCount,
    newsContentCount: primaryNewsContentCount,
    blogContentCount: primaryBlogContentCount,
    toneCounts: Object.fromEntries(primaryToneCounts),
    relationCounts: Object.fromEntries(primaryRelationCounts),
    highRiskCount: primaryArticles.filter((article) => article.reputationRisk === "높음").reduce((sum, article) => sum + Math.max(1, Number(article.coverageCount ?? 1)), 0),
    attentionCount: primaryArticles.filter((article) => article.reputationRisk === "높음" || article.tone === "비판").reduce((sum, article) => sum + Math.max(1, Number(article.coverageCount ?? 1)), 0),
    topics: [...primaryTopicCounts.entries()].map(([name, count]) => {
      const sourceArticles = (primaryTopicArticles.get(name) ?? [])
        .filter((article) => /^https?:\/\//i.test(String(article.url ?? "")));
      const representative = sourceArticles.reduce<Record<string, any> | null>(
        (best, article) => !best || isBetterRepresentativeArticle(article, best) ? article : best,
        null,
      );
      return {
        name,
        count,
        representativeArticle: representative ? {
          title: String(representative.title ?? "원문 보기"),
          publisher: String(representative.publisher ?? ""),
          url: String(representative.url ?? ""),
        } : null,
        sourceArticles: sourceArticles
          .sort((a, b) => (articlePublishedAt(b) ?? 0) - (articlePublishedAt(a) ?? 0))
          .slice(0, 3)
          .map((article) => ({ title: String(article.title ?? ""), publisher: String(article.publisher ?? ""), url: String(article.url ?? "") })),
      };
    }).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ko")).slice(0, 6),
    newsTopics: summarizeprimaryTopicGroups(primaryNewsTopicGroups),
    blogTopics: summarizeprimaryTopicGroups(primaryBlogTopicGroups),
    articleEntries: primaryArticles
      .sort((a, b) => (articlePublishedAt(b) ?? 0) - (articlePublishedAt(a) ?? 0))
      .map((article) => {
        const url = String(article.url ?? "").trim();
        const reporterKey = url.replace(/\/$/, "").toLowerCase();
        const reporterInfo = uniqueReporterMentions.get(reporterKey);
        const blog = isPrimaryBlogArticle(article);
        const officialBlog = isPrimaryOfficialBlogArticle(article);
        const sourceLabel = officialBlog ? "자사 블로그 글"
          : blog ? "온라인 게시글"
            : String(article.sourceCategory ?? "").includes("공시") || String(article.publisher ?? "").includes("DART") ? "공시·기관"
              : "언론 보도";
        return {
          topic: normalizePrimaryTopic(article),
          title: String(article.title ?? "제목 확인 불가"),
          publisher: String(article.publisher ?? "매체 확인 불가"),
          reporter: String(article.reporter ?? reporterInfo?.reporter ?? "").trim(),
          publishedAt: String(article.publishedAt ?? ""),
          url,
          sourceLabel,
          coverageCount: Math.max(1, Number(article.coverageCount ?? 1)),
          contentSummary: String(article.keyMessage ?? article.summary ?? article.uniqueInformation ?? article.additionalFacts?.[0] ?? ""),
          coverageLinks: (article.coverageLinks ?? []).map((link: Record<string, any>) => ({
            publisher: String(link.publisher ?? ""),
            title: String(link.title ?? ""),
            url: String(link.url ?? ""),
          })),
          tone: String(article.tone ?? "판단 보류"),
          reputationRisk: String(article.reputationRisk ?? "판단 보류"),
          reputationReason: String(article.reputationRiskReason ?? article.toneReason ?? ""),
        };
      }),
    riskSignals: primaryRiskSignals,
  };
  const insights: Array<{ type: string; title: string; detail: string; priority: string }> = [];
  if (primaryArticles.length) {
    const criticalCount = primaryReputation.attentionCount;
    const tones = ["우호", "중립", "비판", "판단 보류"].map((tone) => `${tone} ${primaryToneCounts.get(tone) ?? 0}`).join(" · ");
    insights.push({
      type: "primary-reputation",
      title: primaryCompanyName + " 대외 평판 신호",
      detail: `${includeAllRetained ? "누적" : "최근 28일"} ${primaryCompanyName} 및 브랜드 콘텐츠 ${primaryReputation.contentCount}건(공식 ${primaryOwnedContentCount}건 · 외부 ${primaryExternalContentCount}건). 전체 콘텐츠 평판: ${tones}. 평판 주의 신호 ${criticalCount}건${criticalCount ? ` — ${primaryRiskSignals[0]?.title ?? "원문 확인 필요"}` : ""}.`,
      priority: criticalCount ? "높음" : "보통",
    });
  } else {
    insights.push({
      type: "primary-reputation",
      title: primaryCompanyName + " 평판 신호 축적 중",
      detail: `${includeAllRetained ? "누적" : "최근 28일"} 데이터에서 주 대상 및 브랜드 관련 콘텐츠를 확인하지 못했습니다. 이는 부정 이슈가 없다는 뜻이 아니라, 현재 저장된 자료만으로 평판을 판단하기 어렵다는 의미입니다.`,
      priority: "보통",
    });
  }
  const topCompany = companies[0];
  if (topCompany) {
    insights.push({
      type: "exposure",
      title: "경쟁사 참고 노출",
      detail: `${topCompany.name}이(가) 누적 ${topCompany.exposureCount}회 노출되어 가장 큰 경쟁 신호로 확인됩니다. 주요 소재는 ${topCompany.issueCount}개입니다.`,
      priority: topCompany.highSignal ? "높음" : "보통",
    });
  }
  if (highSignalItems[0]) {
    const item = highSignalItems[0];
    insights.push({
      type: "threat",
      title: "경쟁사 참고 신호",
      detail: `${item.article.company}의 '${item.article.topicKey ?? item.article.issueKey ?? item.article.title}' 이슈가 중요도·위협도 높음으로 분류되었습니다. ${item.article.threatReason ?? "경쟁 제품·고객 접점 확대 여부를 확인하세요."}`,
      priority: "높음",
    });
  }
  if (repeatedIssues[0]) {
    const item = repeatedIssues[0];
    insights.push({
      type: "repeat",
      title: "경쟁사 반복 보도 소재",
      detail: `${item.company}의 '${item.topicKey}'이(가) ${item.coverageCount}개 채널에 반복 보도되었습니다. 확산된 매체: ${(item.outlets ?? []).slice(0, 4).join(", ")}.`,
      priority: "보통",
    });
  }
  const minimumRankArticles = 2;
  const maximumRankEntries = 10;
  const rankedMedia = sortCounts(mediaMap).filter((item) => item.count >= minimumRankArticles).slice(0, maximumRankEntries);
  const reporters = [...reporterMap.entries()]
    .map(([name, value]) => ({
      name,
      count: value.count,
      publishers: [...value.publishers.entries()]
        .map(([publisher, count]) => ({ name: publisher, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ko")),
      contacts: [...value.contacts.values()].filter((contact) =>
        !name.includes("강중민") || (
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(contact.value ?? "").trim())
          && String(contact.value ?? "").trim() !== "확인 불가"
        ),
      ),
    }))
    .filter((item) => item.count >= minimumRankArticles)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ko"))
    .slice(0, maximumRankEntries);
  const topMedia = rankedMedia[0];
  const topReporter = reporters[0];
  if (topMedia || topReporter) {
    insights.push({
      type: "media",
      title: "관심 매체·기자",
      detail: `${topMedia ? `${topMedia.name} ${topMedia.count}건` : ""}${topMedia && topReporter ? " · " : ""}${topReporter ? `${topReporter.name} 기자 ${topReporter.count}건` : ""}으로 가장 자주 등장했습니다. 다음 브리핑에서 후속 보도를 우선 확인하세요.`,
      priority: "보통",
    });
  }
  return {
    windowDays: includeAllRetained ? null : 28,
    windowLabel: includeAllRetained ? "전체 보관 누적기간" : "최근 28일",
    primaryCompanyName,
    archiveLimit: 180,
    asOf,
    archivedRuns: recentRuns.length,
    collectionPeriodSummary: collectionPeriodSummary(recentRuns),
    uniqueArticleCount: uniqueArticles.size,
    issueCount: issueMap.size,
    primaryReputation,
    candidates,
    companies: companies.slice(0, 20),
    media: rankedMedia,
    reporters,
    repeatedIssues: repeatedIssues.slice(0, 20),
    insights,
  };
}

async function generateCompetitorBrief(options: {
  start?: string;
  startTime?: string;
  end?: string;
  endTime?: string;
  primaryOnly?: boolean;
  resume?: boolean;
  refresh?: boolean;
  interim?: boolean;
  interimWindowEndTime?: string;
  onProgress?: (progress: AnalysisProgress) => void;
} = {}) {
  if (analysisRunning) throw new Error("분석이 이미 실행 중입니다.");
  analysisRunning = true;
  const metricStartedAt = new Date().toISOString();
  const metricStartedMs = Date.now();
  try {
    await fs.mkdir(reportDir, { recursive: true });
    await Promise.all([
      pruneExpiredJsonFiles(searchCacheDir, 7 * 24 * 60 * 60 * 1000),
      pruneExpiredJsonFiles(companyCheckpointDir, 24 * 60 * 60 * 1000),
    ]);
  } catch (error) {
    analysisRunning = false;
    throw error;
  }
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const todayValue = new Date(`${today}T00:00:00Z`);
  const reportEndValue = new Date(todayValue);
  const reportStartValue = new Date(todayValue);
  reportStartValue.setUTCDate(reportStartValue.getUTCDate() - (todayValue.getUTCDay() === 1 ? 3 : 1));
  const primaryOnly = options.primaryOnly ?? process.env.PAPR_PRIMARY_ONLY === "1";
  const reportStart = options.start ?? process.env.PAPR_REPORT_START ?? reportStartValue.toISOString().slice(0, 10);
  const reportStartTime = options.startTime ?? process.env.PAPR_REPORT_START_TIME ?? "10:00";
  const reportEnd = options.end ?? process.env.PAPR_REPORT_END ?? reportEndValue.toISOString().slice(0, 10);
  const reportEndTime = options.endTime ?? process.env.PAPR_REPORT_END_TIME ?? (process.env.PAPR_CUTOFF_NOW === "1"
    ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date())
    : "10:00");
  const period = reportStart + " " + reportStartTime + "~" + reportEnd + " " + reportEndTime;
  const reusableInterim = options.interim ? null : await readJsonFile<Record<string, any>>(interimAnalysisPath(reportStart, reportEnd, reportStartTime, reportEndTime));
  const groupingV2 = process.env.PAPR_GROUPING_V2 === "1" || today >= "2026-09-19";
  const companies = designatedCompetitors.map((target) => String(target.name ?? "").trim()).filter(Boolean);
  const primaryAliases = [primaryCompanyName, ...(primaryCompany.aliases ?? []), ...(primaryCompany.brands ?? [])]
    .map((value: unknown) => String(value ?? "").trim()).filter(Boolean);
  const primaryBusinessAreas = (primaryCompany.businessAreas ?? []).map((value: unknown) => String(value));
  const primaryTarget = {
    group: "A",
    company: primaryCompanyName,
    instruction: "주 대상 '" + primaryCompanyName + "' 및 설정된 브랜드·서비스 관련 콘텐츠를 수집하세요. 검색 이름: "
      + (primaryAliases.join(", ") || primaryCompanyName) + ". 사업 영역: "
      + (primaryBusinessAreas.join(", ") || "설정된 사업 분야")
      + ". 설정 파일의 제품·서비스·과정·표기 변형 검색어를 각각 사용하고 원문에서 관련성을 확인하세요. 자사 공식 콘텐츠와 제3자 언론 보도·공식기관 자료를 포함하고, 비공식 출처는 설정에서 허용된 경우에만 포함하세요. 동명이인·동명 제품과 단순 언급은 제외하세요. 주 대상 공식 블로그에는 source_type='official_blog', 그 외에는 'other'를 지정하세요. 공식 블로그 상세 분석은 생략하고 톤은 우호, 중요도·위협도는 판단 보류, 평판 위험도는 해당 없음으로 기록하세요. 그 외 콘텐츠의 중요도, 위협도, 평판 톤·위험도는 각각 근거와 함께 평가하세요. 사실·주장·추정을 구분하고 articles의 company에는 '" + primaryCompanyName + "'을 사용하세요.",
  };
  const competitorTargets = designatedCompetitors.map((target) => {
    const name = String(target.name ?? "").trim();
    const names = [name, ...(target.aliases ?? [])].filter(Boolean).join(", ");
    return {
      group: "B",
      company: name,
      instruction: "지정 모니터링 대상 '" + name + "'(" + names + ")의 사업·제품·서비스·고객·실적·제휴 등과 직접 관련된 제3자 언론 보도와 언론사 보도자료를 수집하세요. 기사에서 실제 주체로 다뤄지는지 확인하고 단순 나열·우연한 언급은 제외하세요. 기업 자체 뉴스룸·블로그·행사·모집 등 홍보 게시물은 수집하지 말고 사실 확인용으로만 이용하세요. 공시·보도자료를 다룬 제3자 언론 기사는 기준에 맞으면 포함하고 원출처 성격을 표시하세요.",
    };
  });
  const comparableTarget = {
    group: "C",
    company: comparableGroupName,
    instruction: "지정 대상 외에 주 대상의 사업 영역(" + (primaryBusinessAreas.join(", ") || "설정된 사업 분야")
      + ")과 실제로 겹치는 기업을 찾아 제3자 언론 보도를 수집하세요. 발견 기업과 사업 중첩 근거를 note에 기록하세요. 기업 자체 홍보 게시물·비공식 글과 단순 업계 언급은 제외하세요. 보도자료 전재·자료 제공 여부는 구분하세요.",
  };
  const targets = primaryOnly ? [primaryTarget] : [primaryTarget, ...competitorTargets, comparableTarget];
  // Use the company's public Naver Blog RSS and Google News RSS as additional
  // discovery sources. Google News results are candidates only; original pages
  // remain the authority for inclusion and exact publication timestamps.
  const checkpointResults = await Promise.all(targets.map(async (target) =>
    options.resume && !options.refresh ? readCompanyCheckpoint(period, target.company) : null));
  const pendingIndexes = targets.flatMap((_, index) => checkpointResults[index] ? [] : [index]);
  const pendingTargets = pendingIndexes.map((index) => targets[index]);
  const completedCompanies = new Set(targets.flatMap((target, index) => checkpointResults[index] ? [target.company] : []));
  const activeCompanies = new Set<string>();
  const emitProgress = (phase: AnalysisProgress["phase"], completedTargets: number) => {
    try {
      options.onProgress?.({
        phase,
        totalTargets: targets.length,
        completedTargets,
        activeCompanies: [...activeCompanies],
        completedCompanies: [...completedCompanies],
      });
    } catch {
      // Progress reporting must never interrupt an analysis.
    }
  };
  emitProgress("candidate-search", 0);
  const precollectionEndTime = options.interimWindowEndTime ?? reportEndTime;
  const precollection = await readJsonFile<Record<string, any>>(precollectionPath(briefPeriod(reportStart, reportStartTime, reportEnd, precollectionEndTime)));
  const currentBlogFeed = await loadPrimaryOfficialBlog(reportStart, reportStartTime, reportEnd, reportEndTime);
  const blogEntries = new Map<string, PrimaryBlogEntry>();
  const savedPrimaryBlogFeed = precollection?.primaryBlogFeed;
  for (const entry of [...(savedPrimaryBlogFeed?.eligibleEntries ?? []), ...currentBlogFeed.eligibleEntries]) {
    const key = String(entry.url ?? "").trim().toLowerCase().replace(/\/$/, "");
    if (key) blogEntries.set(key, entry);
  }
  const primaryBlogFeed: PrimaryBlogFeed = {
    ...currentBlogFeed,
    eligibleEntries: [...blogEntries.values()],
    totalEntries: Math.max(currentBlogFeed.totalEntries, Number(savedPrimaryBlogFeed?.totalEntries ?? 0)),
  };
  let candidateSearchesCompleted = 0;
  const freshGoogleNewsByCompany = new Map(await Promise.all(pendingTargets.map(async (target) => {
    const result = await loadGoogleNewsCandidates(target, reportStart, reportEnd, options.refresh === true || Boolean(precollection));
    candidateSearchesCompleted += 1;
    emitProgress("candidate-search", candidateSearchesCompleted);
    return [target.company, result] as const;
  })));
  const googleNewsByCompany = new Map<string, GoogleNewsSearchResult>();
  for (const target of pendingTargets) {
    const fresh = freshGoogleNewsByCompany.get(target.company)!;
    const earlier = precollection?.googleNewsByCompany?.[target.company] as GoogleNewsSearchResult | undefined;
    const candidates = new Map<string, GoogleNewsCandidate>();
    for (const candidate of [...(earlier?.candidates ?? []), ...fresh.candidates]) {
      const key = candidate.url.trim().toLowerCase().replace(/\/$/, "");
      if (key && !candidates.has(key)) candidates.set(key, candidate);
    }
    googleNewsByCompany.set(target.company, {
      queries: [...new Set([...(earlier?.queries ?? []), ...fresh.queries])],
      queryCounts: fresh.queryCounts,
      candidates: [...candidates.values()].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)),
      errors: [...new Set([...(earlier?.errors ?? []), ...fresh.errors])],
      cacheHit: fresh.cacheHit,
    });
  }
  emitProgress("article-analysis", completedCompanies.size);

  const runCompany = async (target: { group: string; company: string; instruction: string }, index: number) => {
    const tempReport = path.join(reportDir, `brief-${Date.now()}-${index}.tmp.json`);
    const googleNewsResult = googleNewsByCompany.get(target.company)!;
    const googleNewsFileName = `google-news-candidates-${Date.now()}-${index}.tmp.json`;
    const googleNewsFile = path.join(reportDir, googleNewsFileName);
    await fs.writeFile(googleNewsFile, JSON.stringify(googleNewsResult), "utf8");
    const primaryBlogContext = target.group !== "A" ? "" : primaryBlogFeed.ok
      ? "\n[공식 블로그 RSS 확인 결과]\nRSS URL: " + primaryOfficialBlogRss + "\n피드 " + primaryBlogFeed.totalEntries + "건 중 기간 내 " + primaryBlogFeed.eligibleEntries.length + "건을 확인했다. 각 원문에서 게시 주체·관련성·발행 시각을 확인하고, 접근이 막히면 확인 범위를 표시한다.\n" + JSON.stringify(primaryBlogFeed.eligibleEntries)
      : "\n[공식 블로그 RSS 확인 실패]\n오류: " + String(primaryBlogFeed.error ?? "확인 불가") + ". 실패를 성공으로 간주하지 말고 가능한 다른 검색을 이어간 뒤 한계를 기록한다.";
    const precollectionPassContext = JSON.stringify(precollection?.searchPasses ?? []);
    const googleNewsContext = "\n[Google News RSS 후보]\n사전 검색 회차: " + precollectionPassContext
      + "\n검색어별 후보 수: " + (googleNewsResult.queryCounts.map((item) => item.query + "=" + item.count + "건").join(" · ") || "없음")
      + "\n검색 오류: " + (googleNewsResult.errors.join(" · ") || "없음")
      + "\n후보 파일: " + path.posix.join("reports", googleNewsFileName)
      + ". RSS 결과는 발견 단서다. 원 매체 원문에서 대상 관련성·발행 날짜와 시각·매체를 확인하고, 접근할 수 없거나 오류가 있으면 수집 완료나 0건으로 단정하지 않는다.";
    const prompt = [
      "오늘은 " + today + ", 시간대는 Asia/Seoul이다. " + target.instruction,
      "모든 기사에 collectionGroup을 하나만 기록한다. 기본 그룹은 " + target.group + "이며 중복 해당 시 A > B > C 우선순위를 적용한다.",
      "수집 기간은 " + reportStart + " " + reportStartTime + " 초과부터 " + reportEnd + " " + reportEndTime + " 이하까지다. 원문 발행 시각을 확인한다.",
      "공통 제외 기준: 광고, 일상 인사·부고, 동명이인·동명 제품, 기간 밖 자료, 단순 이름 언급. 검색 후보만으로 적격 여부를 확정하지 않는다.",
      "Google News RSS는 후보 발견용으로 사용하고 원문을 검증한다. 네이버 뉴스와 접근 가능한 일반 웹 검색으로 교차 확인한다. 접근 차단·검색 오류는 coverage.note에 남긴다.",
      "같은 URL은 한 번만 포함한다. 같은 사건의 다른 매체 기사는 보존하고 하나의 이슈로 묶는다. issueKey는 동일 사건에, topicKey는 같은 기업의 공통 소재에 일관되게 부여한다.",
      "대표 기사는 매체 신뢰도, 원문 확인 수준, 독립 취재·최초 보도 여부를 비교해 선택한다. 기자명·공개된 업무 연락처만 기록하고 확인되지 않으면 추정하지 않는다.",
      "중요도는 모니터링 대상 조직이 주목할 사업 의사결정 가치, 위협도는 주 대상에 미칠 구체적 불리함을 따로 평가한다. 주 대상 콘텐츠는 평판 톤·위험도를 원문 근거로 별도 평가한다. 사실·주장·추정을 구분한다.",
      "공식 블로그 RSS의 자사 발행 글은 제목·발행처·발행일·URL만 기록하고 상세 분석은 비운다. 톤은 설정된 기준에 따라 기록한다.",
      primaryBlogContext,
      googleNewsContext,
      "JSON Schema에 맞는 JSON만 출력한다. 최상위 company 값은 '" + target.company + "'로 쓴다.",
    ].filter(Boolean).join("\n\n");
    const naverSearchDirective = [
      "[사전 수집 결과와 최종 교차검색]",
      "사전 회차 기록(" + precollectionPassContext + ")을 확인한다. 09:05·09:25·09:50 세 회차는 회사·브랜드, 제품·서비스·고객·계약어, 표기 변형·롱테일 검색으로 후보를 누적한다.",
      "세 회차가 완료됐으면 같은 Google News RSS 검색을 불필요하게 반복하지 말고 후보 원문 검증, 네이버 뉴스·접근 가능한 웹 검색의 독립 교차 확인, 마감 직전 신규 후보 확인에 집중한다. 실패한 회차가 있으면 해당 회차를 보완한다.",
      "A 그룹은 설정된 공식 블로그와 허용된 온라인 출처를 확인한다. B/C 그룹은 제3자 언론 보도를 수집한다.",
      "서로 다른 기사 URL은 보존하고 같은 사건의 콘텐츠만 이슈 단위로 묶는다. 기사 수와 이슈 수를 구분한다.",
      "coverage.note에 실제 검색 범위·회차별 후보 수와 오류·원문/시각 확인 한계·중복 제거와 제외 사유를 적는다. 접근할 수 없는 출처를 확인한 것처럼 쓰지 않는다.",
    ].join("\n");
    const priorInterimArticles = (reusableInterim?.report?.articles ?? []).filter((article: Record<string, any>) =>
      target.group === "A" ? article.company === primaryCompanyName
        : target.group === "B" ? article.company === target.company
          : article.company !== primaryCompanyName && !companies.includes(article.company));
    const priorInterimCoverage = reusableInterim?.report?.coverage?.find((item: Record<string, any>) => item.company === target.company);
    const incrementalReuseDirective = priorInterimArticles.length
      ? "\n\n[중간 분석 재사용]\n이미 분석된 " + priorInterimArticles.length + "건은 다시 분석하지 않고 최종 결과에 그대로 보존한다. 기간 전체를 다시 확인해 신규 적격 콘텐츠만 원문과 발행 시각을 검증해 반환한다. 중간 목록에 없는 기사만 articles에 넣는다. 이전 기록: "
        + JSON.stringify(priorInterimArticles.map((article: Record<string, any>) => ({ company: article.company, title: article.title, publisher: article.publisher, url: article.url, publishedAt: article.publishedAt, issueKey: article.issueKey, keyMessage: article.keyMessage })))
        + "\n이전 조사 메모(이번 검색 사실로 간주하지 않음): " + String(priorInterimCoverage?.note ?? "").slice(0, 1200)
      : "";
    const finalPrompt = prompt + incrementalReuseDirective + "\n\n" + naverSearchDirective
      + "\n\n[출처·표시 원칙]\n주 대상 콘텐츠의 메일 분류는 '언론보도'와 '온라인 게시글'로 나눈다. 공식기관·공공기관·대학·고객기관의 직접 게시물과 공시는 공식기관 게시물로 구분 표시하고, 언론사가 취재한 기사는 언론보도로 표시한다. 온라인 게시글에는 자사 공식 블로그를 포함한다. 공개 블로그·커뮤니티·SNS의 개인 의견은 확인된 사실과 구분한다."
      + "\n\n[평가 원칙]\n주 대상이 실제 제품·서비스를 출시했거나 사업을 수주·선정한 사실이 원문에 확인되면 우호 톤을 적용한다. 예정·검토·참여나 제삼자가 주체인 경우에는 자동 적용하지 않는다. 중요도와 위협도, 평판 위험도는 각기 별도 근거로 판정하고 우호 톤만으로 위험도를 자동 결정하지 않는다.";
    const effectivePrompt = finalPrompt;
    const execute = async () => {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(codexExecutable(), [
          "exec", "--ephemeral", "--skip-git-repo-check", "--model", "gpt-5.6-luna", "--sandbox", "read-only",
          "--output-schema", companyReportSchema, "--output-last-message", tempReport,
          effectivePrompt,
        ], {
          cwd: projectRoot,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, CODEX_HOME: process.env.CODEX_HOME ?? path.join(process.env.USERPROFILE ?? "", ".codex") },
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => { stderr += String(chunk); });
        child.on("error", reject);
        child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr || `Codex 종료 코드 ${code}`)));
      });
      return JSON.parse(await fs.readFile(tempReport, "utf8"));
    };
    try {
      let result: Record<string, any>;
      try {
        result = await execute();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/selected model is at capacity|model.*capacity/i.test(message)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 15000));
        result = await execute();
      }
      if (result.searched === true) {
        await writeJsonAtomically(companyCheckpointPath(period, target.company), {
          version: ANALYSIS_PIPELINE_VERSION,
          period,
          company: target.company,
          completedAt: new Date().toISOString(),
          result,
        }).catch(() => {});
      }
      return result;
    } finally {
      await fs.unlink(tempReport).catch(() => {});
      await fs.unlink(googleNewsFile).catch(() => {});
    }
  };

  try {
    // Avoid exhausting model capacity by launching every company analysis at once.
    const settled: PromiseSettledResult<any>[] = new Array(targets.length);
    checkpointResults.forEach((result, index) => {
      if (result) settled[index] = { status: "fulfilled", value: result };
    });
    let nextPendingTarget = 0;
    const worker = async () => {
      while (nextPendingTarget < pendingIndexes.length) {
        const index = pendingIndexes[nextPendingTarget++];
        const target = targets[index];
        activeCompanies.add(target.company);
        emitProgress("article-analysis", completedCompanies.size);
        try {
          settled[index] = { status: "fulfilled", value: await runCompany(target, index) };
          completedCompanies.add(target.company);
        } catch (reason) {
          settled[index] = { status: "rejected", reason };
        } finally {
          activeCompanies.delete(target.company);
          emitProgress("article-analysis", completedCompanies.size);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, pendingIndexes.length) }, () => worker()));
    const failures = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    const creditFailure = failures.some((result) => String(result.reason).toLowerCase().includes("out of credits"));
    if (creditFailure) {
      throw new Error("Codex 작업공간 크레딧이 소진되어 분석을 완료하지 못했습니다. 기존 보고서는 유지하며 메일을 발송하지 않습니다.");
    }
    if (failures.length) {
      const failedCompanies = settled.flatMap((result, index) => result.status === "rejected" ? [targets[index].company] : []);
      throw new Error(`일부 대상 분석이 실패해 불완전한 보고서는 저장·발송하지 않습니다. 실패 대상: ${failedCompanies.join(", ")}`);
    }
    const freshCompanyReports = settled.map((result, index) => result.status === "fulfilled"
      ? result.value
      : { company: targets[index].company, searched: false, note: `분석 실패: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`, articles: [] });
    const companyReports = reusableInterim
      ? freshCompanyReports.map((freshReport, index) => {
        const target = targets[index];
        const priorArticles = (reusableInterim.report?.articles ?? []).filter((article: Record<string, any>) =>
          target.group === "A" ? article.company === primaryCompanyName
            : companies.includes(target.company) ? article.company === target.company
              : article.company !== primaryCompanyName && !companies.includes(article.company));
        const mergedArticles = new Map<string, Record<string, any>>();
        for (const article of priorArticles) {
          const key = String(article.url ?? "").trim().toLowerCase().replace(/\/$/, "") || `${article.company}|${article.title}`;
          if (key) mergedArticles.set(key, article);
        }
        for (const article of freshReport.articles ?? []) {
          const key = String(article.url ?? "").trim().toLowerCase().replace(/\/$/, "") || `${article.company}|${article.title}`;
          if (key && !mergedArticles.has(key)) mergedArticles.set(key, article);
        }
        const priorCoverage = reusableInterim.report?.coverage?.find((item: Record<string, any>) => item.company === target.company);
        return {
          ...freshReport,
          articles: [...mergedArticles.values()],
          note: priorArticles.length
            ? `중간 분석 ${priorArticles.length}건 보존 후 최종 재검색 결과를 병합. 중간 범위 메모: ${String(priorCoverage?.note ?? "").slice(0, 500)} / 최종 확인: ${String(freshReport.note ?? "")}`
            : freshReport.note,
        };
      })
      : freshCompanyReports;
    const unsearchedCompanies = companyReports.filter((item) => item.searched !== true).map((item) => String(item.company));
    if (unsearchedCompanies.length) {
      throw new Error(`조사 완료로 확인되지 않은 대상이 있어 불완전한 보고서는 저장·발송하지 않습니다: ${unsearchedCompanies.join(", ")}`);
    }
    emitProgress("finalizing", targets.length);
    const designatedCompanyNames = new Set(companies.map((company) => company.trim().toLocaleLowerCase("ko-KR")));
    const found = companyReports.flatMap((item) => item.articles ?? []).map((article: Record<string, any>) => {
      const companyName = String(article.company ?? "").trim().toLocaleLowerCase("ko-KR");
      const collectionGroup = companyName === primaryCompanyName
        ? "A"
        : designatedCompanyNames.has(companyName) ? "B" : "C";
      return { ...article, collectionGroup };
    });
    const history = await readBriefArchive();
    const pendingHistory = await readPendingBriefs();
    const sourceHistory = [...history, ...pendingHistory];
    const replacementIndex = pendingHistory.findIndex((item) => item.period === period);
    const seen = new Set<string>();
    const rawArticles = found.filter((article: Record<string, any>) => isWithinPublicationWindow(article, reportStart, reportStartTime, reportEnd, reportEndTime)).filter((article: Record<string, any>) => {
      if (article.company === primaryCompanyName) return true;
      const identity = `${String(article.publisher ?? "")} ${String(article.title ?? "")} ${String(article.url ?? "")}`;
      return !/DART|IR 페이지|전자공시|금융감독원/i.test(identity);
    }).filter((article: { url?: string; title?: string }) => {
      const key = `${article.url ?? ""}|${article.title ?? ""}`.toLowerCase();
      if (seen.has(key)) return false; seen.add(key); return true;
    }).map((article: Record<string, any>) => {
      const articleUrl = String(article.url ?? "").trim().replace(/\/$/, "").toLowerCase();
      const isOfficialPrimaryBlog = article.company === primaryCompanyName
        && primaryBlogFeed.eligibleEntries.some((entry) => entry.url.trim().replace(/\/$/, "").toLowerCase() === articleUrl);
      if (isOfficialPrimaryBlog) {
        return {
          ...article,
          source_type: "official_blog",
          publisher: primaryCompanyName + " 공식 블로그",
          sourceCategory: "블로그",
          sourceReliability: "높음",
          channel: "자사 공식 블로그",
          subjectRelation: "자사 공식 발신",
          isPrimarySource: true,
          contentAccess: "일부 본문 확인",
          tone: "우호",
          toneReason: "주 대상의 공식 블로그 글은 기준에 따라 우호로 고정한다.",
          reputationRisk: "해당 없음",
          reputationRiskReason: "자사 공식 블로그는 설정된 평판 위험도 처리 기준을 적용한다.",
        };
      }
      return {
        ...article,
        source_type: article.company === primaryCompanyName && isPrimaryOfficialBlogArticle(article) ? "official_blog" : "other",
        sourceCategory: article.sourceCategory ?? "언론 보도",
        sourceReliability: article.sourceReliability ?? "중간",
      };
    });
    const primaryReport = companyReports.find((item) => item.company === primaryCompanyName);
    if (primaryReport) {
      const feedUrls = new Set(primaryBlogFeed.eligibleEntries.map((entry) => entry.url.trim().replace(/\/$/, "").toLowerCase()));
      const analyzedFeedCount = rawArticles.filter((article: Record<string, any>) => feedUrls.has(String(article.url ?? "").trim().replace(/\/$/, "").toLowerCase())).length;
      const feedAudit = primaryBlogFeed.ok
        ? `공식 네이버 블로그 RSS 확인 성공: 피드 ${primaryBlogFeed.totalEntries}건, 수집 기간 내 ${primaryBlogFeed.eligibleEntries.length}건을 전달했고 ${analyzedFeedCount}건을 분석 결과에 포함했습니다${primaryBlogFeed.missingDateCount ? `; 발행일 확인 불가 ${primaryBlogFeed.missingDateCount}건` : ""}.`
        : `공식 네이버 블로그 RSS 확인 실패(${primaryBlogFeed.error}); 일반 웹 검색 결과만 반영했으며 공식 블로그 전체 확인은 보장되지 않습니다.`;
      primaryReport.note = `${String(primaryReport.note ?? "").trim()} ${feedAudit}`.trim();
    }
    // Carry articles from earlier test/report runs covering this window forward.
    // This prevents a broader rerun from dropping items that were already verified.
    const previousRows = sourceHistory.flatMap((savedReport) => savedReport.articles ?? []).flatMap((article) => {
      if (!isWithinPublicationWindow(article, reportStart, reportStartTime, reportEnd, reportEndTime)) return [];
      const { coverageCount, coverageOutlets, coverageLinks, additionalFacts, ...base } = article;
      const rows: Array<Record<string, any>> = [{ ...base, coverageCount: 1, coverageOutlets: [], coverageLinks: [], additionalFacts: [] }];
      const links = Array.isArray(coverageLinks) ? coverageLinks : [];
      for (const link of links) rows.push({
        ...base,
        publisher: String(link.publisher ?? ""),
        title: String(link.title ?? base.title ?? "추가 보도"),
        url: String(link.url ?? ""),
        coverageCount: 1,
        coverageOutlets: [],
        coverageLinks: [],
        additionalFacts: [],
      });
      const knownOutlets = new Set([String(base.publisher ?? ""), ...links.map((link: Record<string, any>) => String(link.publisher ?? ""))].filter(Boolean));
      for (const outlet of Array.isArray(coverageOutlets) ? coverageOutlets : []) {
        const name = String(outlet ?? "").trim();
        if (name && !knownOutlets.has(name)) {
          knownOutlets.add(name);
          rows.push({ ...base, publisher: name, title: `${String(base.title ?? "이전 추가 보도")} · ${name}`, url: "", coverageCount: 1, coverageOutlets: [], coverageLinks: [], additionalFacts: [] });
        }
      }
      while (rows.length < Math.max(1, Number(coverageCount ?? 1))) {
        rows.push({ ...base, publisher: "출처 확인 필요", title: `${String(base.title ?? "이전 추가 보도")} · 추가 노출`, url: "", coverageCount: 1, coverageOutlets: [], coverageLinks: [], additionalFacts: [] });
      }
      return rows;
    });
    const sourceArticles = mergeSamePeriodArticles(rawArticles, previousRows).filter((article) => {
      if (article.company === primaryCompanyName) return true;
      const identity = `${String(article.publisher ?? "")} ${String(article.title ?? "")} ${String(article.url ?? "")}`;
      return !/DART|IR 페이지|전자공시|금융감독원/i.test(identity);
    }).map((article) => {
      const officialBlog = isPrimaryOfficialBlogArticle(article);
      return {
        ...article,
        source_type: officialBlog ? "official_blog" : (article.source_type ?? "other"),
        ...(officialBlog ? {
          tone: "우호",
          toneReason: "주 대상의 공식 블로그 글은 기준에 따라 우호로 고정한다.",
          reputationRisk: "해당 없음",
          reputationRiskReason: "자사 공식 블로그는 설정된 평판 위험도 처리 기준을 적용한다.",
        } : {}),
      };
    });
    const issueGroups: Array<Array<Record<string, any>>> = [];
    for (const article of sourceArticles) {
      const matchingGroups = issueGroups.filter((group) => group.some((member) => sameNewsIssue(member, article)));
      if (!matchingGroups.length) issueGroups.push([article]);
      else {
        const primaryGroup = matchingGroups[0];
        primaryGroup.push(article);
        for (const additionalGroup of matchingGroups.slice(1)) {
          primaryGroup.push(...additionalGroup);
          issueGroups.splice(issueGroups.indexOf(additionalGroup), 1);
        }
      }
    }
    // Outlet-level baseline is the primary representative-article criterion.
    // This is a conservative operational tiering for PR selection, not a claim
    // that every story from a given outlet has identical reliability.
    const canonicalPublisher = (value: unknown) => {
      const publisher = String(value ?? "").trim().toLowerCase();
      if (/뉴시스/.test(publisher)) return "뉴시스";
      if (/디지털투데이|digitaltoday/.test(publisher)) return "디지털투데이";
      if (/zdnet|지디넷/.test(publisher)) return "zdnet korea";
      if (/연합뉴스/.test(publisher)) return "연합뉴스";
      if (/파이낸셜뉴스/.test(publisher)) return "파이낸셜뉴스";
      if (/머니투데이/.test(publisher) && !/더벨/.test(publisher)) return "머니투데이";
      if (/더벨/.test(publisher)) return "더벨";
      return publisher;
    };
    const outletReliabilityTier: Record<string, number> = {
      "연합뉴스": 3, "뉴시스": 3, "한국경제": 3, "매일경제": 3, "전자신문": 3,
      "파이낸셜뉴스": 3, "이데일리": 3, "머니투데이": 3, "조선일보": 3,
      "조선비즈": 3, "세계일보": 3, "헤럴드경제": 3, "뉴스핌": 3,
      "매일일보": 3, "아주경제": 3, "이투데이": 3, "국제뉴스": 3,
      "매일신문": 3, "에너지경제신문": 3, "mtn 머니투데이방송": 3, "서울경제tv": 3,
      "zdnet korea": 2, "디지털투데이": 2, "블로터": 2, "더벨": 2,
      "테크월드": 2, "ai타임스": 2, "bi korea": 2, "바이라인네트워크": 2,
      "플래텀": 2, "벤처스퀘어": 2, "에이빙(aving)": 2, "대학저널": 2,
      "한국대학신문": 2, "한국교육신문": 2, "메디컬투데이": 2, "비즈트리뷴": 2,
      "한스경제": 2, "메트로신문": 2, "베타뉴스": 2, "쿠키뉴스": 2,
      "폴리뉴스": 2, "프라임경제": 2, "스트레이트뉴스": 2, "비욘드포스트": 2,
      "비건뉴스": 1, "뉴스티앤티": 1, "뉴스투데이": 1, "뉴스로": 1,
      "시대일보": 1, "피앤피뉴스": 1, "청년개발자신문(데브타임즈)": 1,
      "고시위크": 1, "스타트업엔": 1, "핀포인트뉴스": 1, "이코노미톡뉴스": 1,
      "이코노미스트": 1, "e동아": 1, "경제일보": 1, "on the media": 1,
    };
    const outletScore = (article: Record<string, any>) =>
      outletReliabilityTier[canonicalPublisher(article.publisher)] ?? 1;
    const articleReliabilityScore = (article: Record<string, any>) => {
      const reliabilityScore: Record<string, number> = { "높음": 3, "중간": 2, "낮음": 1, "확인 필요": 0 };
      return reliabilityScore[article.sourceReliability] ?? 0;
    };
    const priorityScore = (value: unknown) => ({ "높음": 3, "중간": 2, "낮음": 1, "판단 보류": 0 }[String(value)] ?? 0);
    let articles = issueGroups.map((group) => {
      const ranked = [...group].sort((a, b) => outletScore(b) - outletScore(a)
        || articleReliabilityScore(b) - articleReliabilityScore(a)
        || Number(Boolean(b.isPrimarySource)) - Number(Boolean(a.isPrimarySource))
        || (articlePublishedAt(a) ?? Number.MAX_SAFE_INTEGER) - (articlePublishedAt(b) ?? Number.MAX_SAFE_INTEGER));
      const representative = ranked[0];
      const highestImportance = [...group].sort((a, b) => priorityScore(b.importance) - priorityScore(a.importance))[0];
      const highestThreat = [...group].sort((a, b) => priorityScore(b.threat) - priorityScore(a.threat))[0];
      const coverageLinks = ranked.slice(1).map((item) => {
        const publisher = String(item.publisher ?? "").trim();
        const url = String(item.url ?? "").trim();
        return { publisher: publisher || "출처 확인 필요", url, title: String(item.title ?? "") };
      }).filter((item, index, items) => items.findIndex((candidate) => candidate.url && candidate.url === item.url || !candidate.url && !item.url && candidate.publisher === item.publisher && candidate.title === item.title) === index);
      const coverageOutlets = [...new Set(coverageLinks.map((item) => item.publisher).filter(Boolean))];
      const additionalFacts = [...new Set(ranked.slice(1).map((item) => String(item.uniqueInformation ?? "").trim()).filter(Boolean))];
      return {
        ...representative,
        topicKey: representative.topicKey || representative.issueKey || representative.title,
        ...(groupingV2 ? {
          importance: highestImportance.importance,
          importanceReason: highestImportance.importanceReason,
          threat: highestThreat.threat,
          threatReason: highestThreat.threatReason,
        } : {}),
        coverageCount: coverageLinks.length + 1,
        coverageOutlets,
        coverageLinks,
        additionalFacts,
      };
    }).sort((a, b) => groupingV2
      ? priorityScore(b.importance) - priorityScore(a.importance) || priorityScore(b.threat) - priorityScore(a.threat)
      : 0);
    const rawArticleCount = articles.reduce((total, article) => total + Math.max(1, Number(article.coverageCount ?? 1)), 0);
    const issueCount = articles.length;
    const groupCounts = (group: string) => {
      const rows = articles.filter((article: Record<string, any>) => article.collectionGroup === group);
      return { issues: rows.length, articles: rows.reduce((sum, article) => sum + Math.max(1, Number(article.coverageCount ?? 1)), 0) };
    };
    const groupA = groupCounts("A");
    const groupB = groupCounts("B");
    const groupC = groupCounts("C");
    for (const article of articles) {
      if (Math.max(1, Number(article.coverageCount ?? 1)) !== (article.coverageLinks?.length ?? 0) + 1) {
        throw new Error(`메일 검증 실패: '${article.title}'의 동일 이슈 기사 수와 추가 노출 수가 맞지 않습니다.`);
      }
    }
    for (let left = 0; left < articles.length; left += 1) {
      for (let right = left + 1; right < articles.length; right += 1) {
        if (sameNewsIssue(articles[left], articles[right])) throw new Error(`메일 검증 실패: 같은 이슈 카드가 중복되었습니다 (${articles[left].company}).`);
      }
    }
    const coverage = companyReports.map((item) => ({
      company: item.company,
      searched: item.searched,
      findingCount: item.company === comparableGroupName
        ? articles.filter((article: { company: string }) => article.company !== primaryCompanyName && !companies.includes(article.company)).length
        : articles.filter((article: { company: string }) => article.company === item.company).length,
      articleCount: item.company === comparableGroupName
        ? articles.filter((article: { company: string }) => article.company !== primaryCompanyName && !companies.includes(article.company)).reduce((sum: number, article: Record<string, any>) => sum + Math.max(1, Number(article.coverageCount ?? 1)), 0)
        : articles.filter((article: { company: string }) => article.company === item.company).reduce((sum: number, article: Record<string, any>) => sum + Math.max(1, Number(article.coverageCount ?? 1)), 0),
      note: item.note,
    }));
    const summaryAnchor = articles.find((article: Record<string, any>) => article.company === primaryCompanyName && !isPrimaryOfficialBlogArticle(article) && article.importance === "높음")
      ?? articles.find((article: Record<string, any>) => article.company === primaryCompanyName && !isPrimaryOfficialBlogArticle(article))
      ?? articles.find((article: Record<string, any>) => article.importance === "높음" || article.threat === "높음");
    const summaryCore = String(summaryAnchor?.keyMessage ?? summaryAnchor?.title ?? "주요 평판 위험 신호 없음").replace(/\s+/g, " ").slice(0, 86);
    const shortSummary = "이슈 " + issueCount + "개(콘텐츠 " + rawArticleCount + "건) · " + primaryCompanyName + "·브랜드 " + groupA.issues + "개 이슈(콘텐츠 " + groupA.articles + "건) · 지정 대상 " + groupB.issues + "개 이슈(콘텐츠 " + groupB.articles + "건) · 유사기업 " + groupC.issues + "개 이슈(콘텐츠 " + groupC.articles + "건). 핵심: " + summaryCore;
    let report = {
      period,
      executiveSummary: shortSummary,
      coverage,
      rawArticleCount,
      issueCount,
      formatVersion: groupingV2 ? 2 : 1,
      reporterMentions: rawArticles.map((article: Record<string, any>) => ({
        reporter: String(article.reporter ?? ""),
        reporterContact: String(article.reporterContact ?? "").trim(),
        url: String(article.url ?? ""),
        publisher: String(article.publisher ?? ""),
        title: String(article.title ?? ""),
      })),
      articles,
    };
    report.generatedAt = new Date().toISOString();
    if (!options.interim) {
      const priorSamePeriod = replacementIndex >= 0
        ? pendingHistory[replacementIndex]
        : history.find((item) => item.period === period);
      if (priorSamePeriod && Number(report.rawArticleCount ?? 0) === 0 && Number(priorSamePeriod.rawArticleCount ?? 0) > 0) {
        report = {
          ...priorSamePeriod,
          generatedAt: report.generatedAt,
          executiveSummary: report.executiveSummary,
        };
      }
      if (replacementIndex >= 0) pendingHistory[replacementIndex] = report;
      else pendingHistory.push(report);
      const retainedPending = pendingHistory
        .sort((a, b) => String(a.generatedAt ?? "").localeCompare(String(b.generatedAt ?? "")))
        .slice(-180);
      report.rollingInsights = rollingInsights(history, report.generatedAt);
      await fs.writeFile(pendingBriefsPath, `${JSON.stringify(retainedPending, null, 2)}\n`, "utf8");
      await fs.writeFile(rollingInsightsPath, `${JSON.stringify(report.rollingInsights, null, 2)}\n`, "utf8");
      const successfulReport = path.join(reportDir, "last-success.json");
      await fs.writeFile(latestReport, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      await fs.writeFile(successfulReport, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
    const googleResults = [...googleNewsByCompany.values()];
    const naverLimitedTargets = coverage.filter((item) => /네이버/i.test(String(item.note ?? ""))
      && /robots|차단|접근 제한|접근 불가|접근 오류|검증하지 못|확인하지 못|접근할 수 없/i.test(String(item.note ?? ""))).map((item) => item.company);
    const timestampVerifiedCount = rawArticles.filter((article: Record<string, any>) => articlePublishedAt(article) !== null).length;
    const searchAudit = {
      version: 1,
      period,
      generatedAt: report.generatedAt,
      precollection: precollection ? {
        capturedAt: precollection.capturedAt,
        candidateCounts: Object.fromEntries(Object.entries(precollection.googleNewsByCompany ?? {}).map(([company, result]: [string, any]) => [company, result.candidates?.length ?? 0])),
        newCandidateCounts: precollection.newCandidateCounts ?? {},
      } : null,
      interimReuse: reusableInterim ? {
        asOfPeriod: reusableInterim.asOfPeriod,
        completedAt: reusableInterim.completedAt,
        preservedArticleCount: reusableInterim.report?.articles?.length ?? 0,
      } : null,
      sources: coverage.map((item) => {
        const current = freshGoogleNewsByCompany.get(item.company);
        const merged = googleNewsByCompany.get(item.company);
        const earlier = precollection?.googleNewsByCompany?.[item.company];
        const earlierUrls = new Set((earlier?.candidates ?? []).map((candidate: GoogleNewsCandidate) => candidate.url.trim().toLowerCase().replace(/\/$/, "")));
        return {
          company: item.company,
          googleNews: {
            queried: Boolean(current),
            queries: current?.queries ?? [],
            queryCandidateCounts: current?.queryCounts ?? [],
            freshCandidateCount: current?.candidates.length ?? 0,
            precollectedCandidateCount: earlier?.candidates?.length ?? 0,
            mergedUniqueCandidateCount: merged?.candidates.length ?? 0,
            newlySurfacedAtCutoffCount: (current?.candidates ?? []).filter((candidate) => !earlierUrls.has(candidate.url.trim().toLowerCase().replace(/\/$/, ""))).length,
            errors: current?.errors ?? [],
          },
          naver: {
            status: /네이버/i.test(String(item.note ?? ""))
              ? (naverLimitedTargets.includes(item.company) ? "reported_limited" : "model_reported_search")
              : "not_reported",
          },
          analysisCoverageNote: item.note,
        };
      }),
      interpretation: "Google News counts are RSS candidate telemetry. Naver search status and query details are model-reported coverage notes, not independently instrumented telemetry.",
    };
    const auditFile = searchAuditPath(period);
    await fs.mkdir(searchAuditDir, { recursive: true });
    const priorAudit = await readJsonFile<Record<string, any>>(auditFile);
    const auditRuns = [...(Array.isArray(priorAudit?.runs) ? priorAudit.runs : []), searchAudit].slice(-30);
    await writeJsonAtomically(auditFile, { version: 1, period, runs: auditRuns }).catch(() => {});
    await appendCollectionMetric({
      runId: stableHash(metricStartedAt + "|" + period + "|" + report.generatedAt),
      status: options.interim ? "interim" : "completed",
      period,
      reusedInterimArticles: reusableInterim?.report?.articles?.length ?? 0,
      startedAt: metricStartedAt,
      finishedAt: report.generatedAt,
      durationSeconds: Math.max(0, Math.round((Date.now() - metricStartedMs) / 1000)),
      targetsPlanned: targets.length,
      targetsSearched: companyReports.filter((item) => item.searched === true).length,
      resumedTargets: Math.max(0, completedCompanies.size - pendingTargets.length),
      googleNews: {
        targetsQueried: googleResults.length,
        cacheHitTargets: googleResults.filter((item) => item.cacheHit).length,
        queryCount: googleResults.reduce((sum, item) => sum + item.queries.length, 0),
        candidateCount: googleResults.reduce((sum, item) => sum + item.candidates.length, 0),
        errorCount: googleResults.reduce((sum, item) => sum + item.errors.length, 0),
      },
      naver: {
        targetsWithRecordedSearch: coverage.filter((item) => /네이버/i.test(String(item.note ?? ""))).length,
        targetsWithAccessLimit: naverLimitedTargets.length,
        limitedTargets: naverLimitedTargets,
      },
      timestampValidation: {
        articleRecords: rawArticles.length,
        verifiedRecords: timestampVerifiedCount,
        verifiedRate: rawArticles.length ? Number((timestampVerifiedCount / rawArticles.length).toFixed(4)) : null,
      },
      result: { issues: report.issueCount, contents: report.rawArticleCount },
      searchAuditFile: path.relative(projectRoot, auditFile).replace(/\\/g, "/"),
      reviewEvents: [],
    }).catch(() => {});
    return report;
  } finally {
    analysisRunning = false;
  }
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

// Google News escapes the HTML inside <description> as XML entities, so the
// entities must be decoded *before* the tags can be stripped, and a second
// decode turns the inner `&amp;` into readable text.
function xmlText(value: string | undefined): string {
  if (!value) return "";
  const raw = value.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1");
  return decodeEntities(decodeEntities(raw).replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function itemField(item: string, name: string): string {
  const match = item.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return xmlText(match?.[1]);
}

function parseNewsFeed(xml: string, feed: (typeof competitorFeeds)[number]) {
  const items = xml.match(/<item>[\s\S]*?<\/item>/gi) ?? [];
  return items.slice(0, 20).flatMap((item, index) => {
    const rawTitle = itemField(item, "title");
    const url = itemField(item, "link");
    if (!rawTitle || !url) return [];
    const source = itemField(item, "source");
    // Google News appends " - <source>" to every headline; the source already
    // appears in the author column, so keep the headline itself.
    const title =
      source && rawTitle.endsWith(` - ${source}`)
        ? rawTitle.slice(0, -(source.length + 3)).trim()
        : rawTitle;
    // The description is just the linked headline plus the source name, which
    // would duplicate the title in the list — only keep it when it says more.
    const description = itemField(item, "description");
    const snippet =
      description && !description.startsWith(rawTitle) && !description.startsWith(title)
        ? description.slice(0, 360)
        : null;
    const published = Date.parse(itemField(item, "pubDate"));
    return [{
      id: feed.id * 1_000 + index,
      feedId: feed.id,
      feedTitle: feed.title,
      sourceType: "rss",
      title,
      author: source || "Google News",
      snippet,
      imageUrl: null,
      url,
      publishedAt: Number.isNaN(published) ? null : new Date(published).toISOString(),
      isRead: false,
      isStarred: false,
      readLater: false,
    }];
  });
}

async function loadCompetitorNews(force = false) {
  if (!force && cachedNews && Date.now() - cachedAt < CACHE_MS) return cachedNews;

  const results = await Promise.all(
    competitorFeeds.map(async (feed) => {
      const params = new URLSearchParams({
        q: feed.query,
        hl: "ko",
        gl: "KR",
        ceid: "KR:ko",
      });
      const response = await fetch(`https://news.google.com/rss/search?${params}`, {
        headers: { "User-Agent": "Papr-local-preview/0.15" },
      });
      if (!response.ok) throw new Error(`${feed.title} news request failed: ${response.status}`);
      return parseNewsFeed(await response.text(), feed);
    }),
  );

  const feeds = competitorFeeds.map((feed) => ({
    id: feed.id,
    feedUrl: `https://news.google.com/rss/search?q=${encodeURIComponent(feed.query)}&hl=ko&gl=KR&ceid=KR:ko`,
    siteUrl: "https://news.google.com/",
    title: feed.title,
    description: `${feed.title} 관련 Google News RSS 미리보기`,
    faviconUrl: null,
    folderId: null,
    sourceType: "rss",
    lastFetchedAt: new Date().toISOString(),
    fetchError: null,
    unreadCount: results[feed.id - 1].length,
    refreshIntervalMin: null,
    autoTranslate: false,
    openMode: null,
  }));
  const articles = results.flat().sort((a, b) =>
    (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""),
  );
  cachedNews = { feeds, articles, refreshedAt: new Date().toISOString() };
  cachedAt = Date.now();
  return cachedNews;
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    react(),
    {
      name: "competitor-news-preview",
      configureServer(server) {
        server.middlewares.use("/api/send-test-email", async (req, res) => {
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end(JSON.stringify({ error: "POST 요청만 허용됩니다." }));
            return;
          }
          const host = req.headers.host ?? "";
          const origin = req.headers.origin;
          let localSameOrigin = false;
          try {
            const parsedOrigin = new URL(origin ?? "");
            localSameOrigin = parsedOrigin.host === host
              && (parsedOrigin.hostname === "127.0.0.1" || parsedOrigin.hostname === "localhost");
          } catch {}
          if (!localSameOrigin) {
            res.statusCode = 403;
            res.end(JSON.stringify({ error: "이 로컬 페이지에서만 테스트 발송을 요청할 수 있습니다." }));
            return;
          }
          if (process.platform !== "win32") {
            res.statusCode = 501;
            res.end(JSON.stringify({ error: "Windows 메일 발송 환경에서만 사용할 수 있습니다." }));
            return;
          }
          if (testEmailRunning) {
            res.statusCode = 409;
            res.end(JSON.stringify({ error: "테스트 메일 발송이 이미 진행 중입니다." }));
            return;
          }
          if (!(await readLatestReport())) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: "발송할 분석 보고서가 없습니다." }));
            return;
          }

          testEmailRunning = true;
          const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
          const senderScript = path.join(projectRoot, "scripts", "send-brief-email.ps1");
          const child = spawn(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", senderScript, "-Test"], {
            cwd: projectRoot,
            windowsHide: true,
            env: { ...process.env, PAPR_PRIMARY_ONLY: "" },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "";
          let stderr = "";
          let responseSent = false;
          child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
          child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
          const timeout = setTimeout(() => child.kill(), 120_000);
          child.on("error", (error) => {
            clearTimeout(timeout);
            testEmailRunning = false;
            responseSent = true;
            res.statusCode = 500;
            res.end(JSON.stringify({ error: `테스트 발송 프로세스를 시작하지 못했습니다: ${error.message}` }));
          });
          child.on("close", (code) => {
            clearTimeout(timeout);
            testEmailRunning = false;
            if (responseSent) return;
            if (code === 0) {
              res.statusCode = 200;
              responseSent = true;
              res.end(JSON.stringify({ sent: true, test: true, output: stdout.trim() }));
            } else {
              res.statusCode = 500;
              responseSent = true;
              res.end(JSON.stringify({ error: (stderr || stdout || `메일 발송 실패 (exit ${code})`).trim() }));
            }
          });
        });
        server.middlewares.use("/api/send-team-email", async (req, res) => {
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end(JSON.stringify({ error: "POST 요청만 허용됩니다." }));
            return;
          }
          const host = req.headers.host ?? "";
          let localSameOrigin = false;
          try {
            const parsedOrigin = new URL(req.headers.origin ?? "");
            localSameOrigin = parsedOrigin.host === host
              && (parsedOrigin.hostname === "127.0.0.1" || parsedOrigin.hostname === "localhost");
          } catch {}
          if (!localSameOrigin) {
            res.statusCode = 403;
            res.end(JSON.stringify({ error: "이 로컬 페이지에서만 팀 메일 발송을 요청할 수 있습니다." }));
            return;
          }
          if (process.platform !== "win32") {
            res.statusCode = 501;
            res.end(JSON.stringify({ error: "Windows 메일 발송 환경에서만 사용할 수 있습니다." }));
            return;
          }
          if (testEmailRunning) {
            res.statusCode = 409;
            res.end(JSON.stringify({ error: "메일 발송이 이미 진행 중입니다." }));
            return;
          }
          const report = await readLatestReport();
          if (!report) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: "발송할 분석 보고서가 없습니다." }));
            return;
          }

          testEmailRunning = true;
          const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
          const senderScript = path.join(projectRoot, "scripts", "send-brief-email.ps1");
          const child = spawn(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", senderScript], {
            cwd: projectRoot,
            windowsHide: true,
            env: { ...process.env, PAPR_PRIMARY_ONLY: "" },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "";
          let stderr = "";
          let responseSent = false;
          child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
          child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
          const timeout = setTimeout(() => child.kill(), 120_000);
          child.on("error", (error) => {
            clearTimeout(timeout);
            testEmailRunning = false;
            responseSent = true;
            res.statusCode = 500;
            res.end(JSON.stringify({ error: `팀 메일 발송 프로세스를 시작하지 못했습니다: ${error.message}` }));
          });
          child.on("close", (code) => {
            clearTimeout(timeout);
            testEmailRunning = false;
            if (responseSent) return;
            if (code === 0) {
              responseSent = true;
              res.statusCode = 200;
              res.end(JSON.stringify({ sent: true, test: false, period: report.period, output: stdout.trim() }));
            } else {
              responseSent = true;
              res.statusCode = 500;
              res.end(JSON.stringify({ error: (stderr || stdout || `메일 발송 실패 (exit ${code})`).trim() }));
            }
          });
        });
        server.middlewares.use("/api/competitor-brief", async (req, res) => {
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          try {
            const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
            if (requestUrl.searchParams.get("capabilities") === "1") {
              res.statusCode = 200;
              res.end(JSON.stringify({ supportsDateWindow: true, supportsprimaryOnly: true, supportsAsyncJobs: true, supportsResume: true, supportsSearchCache: true, supportsPrecollection: true, supportsActiveJobAdoption: true, supportsSearchAudit: true }));
              return;
            }
            if (req.method !== "POST" && requestUrl.searchParams.get("active") === "1") {
              const job = activeAnalysisJobId ? analysisJobs.get(activeAnalysisJobId) : null;
              res.statusCode = 200;
              res.end(JSON.stringify(job?.status === "running"
                ? { id: job.id, jobId: job.id, status: job.status, period: job.period, startedAt: job.startedAt, progress: job.progress }
                : { status: "idle" }));
              return;
            }
            const requestedJobId = requestUrl.searchParams.get("jobId");
            if (req.method !== "POST" && requestedJobId) {
              const job = analysisJobs.get(requestedJobId);
              res.statusCode = job ? 200 : 404;
              res.end(JSON.stringify(job ?? { error: "분석 작업을 찾을 수 없습니다. 서버가 재시작됐거나 작업 기록이 만료됐습니다." }));
              return;
            }
            if (req.method === "POST") {
              if (requestUrl.searchParams.get("precollect") === "1") {
                if (analysisRunning || precollectionRunning || Boolean(activeAnalysisJobId && analysisJobs.get(activeAnalysisJobId)?.status === "running")) {
                  res.statusCode = 409;
                  const active = activeAnalysisJobId ? analysisJobs.get(activeAnalysisJobId) : null;
                  res.end(JSON.stringify({ error: "다른 PR 작업이 실행 중입니다.", activeJob: active?.status === "running" ? { jobId: active.id, period: active.period, progress: active.progress } : null }));
                  return;
                }
                const start = requestUrl.searchParams.get("start");
                const end = requestUrl.searchParams.get("end");
                const startTime = requestUrl.searchParams.get("startTime") ?? "10:00";
                const endTime = requestUrl.searchParams.get("endTime") ?? "10:00";
                const searchPass = Number(requestUrl.searchParams.get("pass") ?? "1");
                if (!start || !end) {
                  res.statusCode = 400;
                  res.end(JSON.stringify({ error: "사전 수집에는 start와 end 날짜가 필요합니다." }));
                  return;
                }
                if (![1, 2, 3].includes(searchPass)) {
                  res.statusCode = 400;
                  res.end(JSON.stringify({ error: "사전 검색 회차는 1, 2, 3 중 하나여야 합니다." }));
                  return;
                }
                precollectionRunning = true;
                try {
                  const period = briefPeriod(start, startTime, end, endTime);
                  const snapshot = await precollectBriefCandidates(period, start, startTime, end, endTime, searchPass);
                  res.statusCode = 200;
                  res.end(JSON.stringify({ status: "completed", period, searchPass, searchPasses: snapshot.searchPasses, capturedAt: snapshot.capturedAt, candidateCounts: Object.fromEntries(Object.entries(snapshot.googleNewsByCompany).map(([company, result]: [string, any]) => [company, result.candidates?.length ?? 0])), newCandidateCounts: snapshot.newCandidateCounts, blogCandidates: snapshot.primaryBlogFeed.eligibleEntries.length, searchOnly: true }));
                } finally {
                  precollectionRunning = false;
                }
                return;
              }
              const options = {
                start: requestUrl.searchParams.get("start") ?? undefined,
                startTime: requestUrl.searchParams.get("startTime") ?? undefined,
                end: requestUrl.searchParams.get("end") ?? undefined,
                endTime: requestUrl.searchParams.get("endTime") ?? undefined,
                primaryOnly: requestUrl.searchParams.get("primaryOnly") === "1" ? true : undefined,
                resume: requestUrl.searchParams.get("resume") === "1",
                refresh: requestUrl.searchParams.get("refresh") === "1",
                interim: requestUrl.searchParams.get("interim") === "1",
                interimWindowEndTime: requestUrl.searchParams.get("interimWindowEndTime") ?? undefined,
              };
              if (requestUrl.searchParams.get("async") === "1") {
                const requestedPeriod = options.start && options.end
                  ? briefPeriod(options.start, options.startTime ?? "10:00", options.end, options.endTime ?? "10:00")
                  : "기본 수집 기간";
                if (precollectionRunning) {
                  res.statusCode = 409;
                  res.end(JSON.stringify({ error: "사전 후보 수집이 끝난 뒤 분석을 시작할 수 있습니다.", retryAfterSeconds: 5 }));
                  return;
                }
                if (analysisRunning || Boolean(activeAnalysisJobId && analysisJobs.get(activeAnalysisJobId)?.status === "running")) {
                  const active = activeAnalysisJobId ? analysisJobs.get(activeAnalysisJobId) : null;
                  res.statusCode = active?.status === "running" && active.period === requestedPeriod ? 202 : 409;
                  res.end(JSON.stringify({ error: "분석이 이미 실행 중입니다.", jobId: active?.id, status: active?.status ?? "running", period: active?.period, attached: active?.status === "running" && active.period === requestedPeriod, progress: active?.progress }));
                  return;
                }
                const now = new Date().toISOString();
                const jobId = `brief-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                const job: AnalysisJob = {
                  id: jobId,
                  period: requestedPeriod,
                  kind: options.interim ? "interim" : "final",
                  status: "running",
                  startedAt: now,
                  progress: { phase: "candidate-search", totalTargets: 0, completedTargets: 0, activeCompanies: [], completedCompanies: [] },
                };
                analysisJobs.set(jobId, job);
                activeAnalysisJobId = jobId;
                for (const [id, previous] of analysisJobs) {
                  if (previous.status !== "running" && Date.now() - Date.parse(previous.finishedAt ?? previous.startedAt) > 2 * 60 * 60 * 1000) analysisJobs.delete(id);
                }
                const task = generateCompetitorBrief({
                  ...options,
                  onProgress: (progress) => { job.progress = progress; },
                }).then((report) => {
                  if (options.interim && options.start && options.end) {
                    const interimWindowEndTime = options.interimWindowEndTime ?? options.endTime ?? "10:00";
                    const file = interimAnalysisPath(options.start, options.end, options.startTime ?? "10:00", interimWindowEndTime);
                    return fs.mkdir(interimAnalysisDir, { recursive: true })
                      .then(() => writeJsonAtomically(file, {
                        version: ANALYSIS_PIPELINE_VERSION,
                        window: briefPeriod(options.start!, options.startTime ?? "10:00", options.end!, interimWindowEndTime),
                        asOfPeriod: report.period,
                        completedAt: new Date().toISOString(),
                        report,
                      }))
                      .then(() => report);
                  }
                  return report;
                }).then((report) => {
                  job.status = "completed";
                  job.report = report;
                  job.finishedAt = new Date().toISOString();
                  if (activeAnalysisJobId === jobId) activeAnalysisJobId = null;
                }).catch(async (error) => {
                  job.status = "failed";
                  job.error = error instanceof Error ? error.message : String(error);
                  job.finishedAt = new Date().toISOString();
                  await appendCollectionMetric({
                    runId: job.id,
                    status: "failed",
                    period: requestedPeriod,
                    startedAt: job.startedAt,
                    finishedAt: job.finishedAt,
                    durationSeconds: Math.max(0, Math.round((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000)),
                    targetsPlanned: job.progress.totalTargets,
                    targetsSearched: job.progress.completedTargets,
                    failure: job.error,
                    reviewEvents: [],
                  }).catch(() => {});
                  if (activeAnalysisJobId === jobId) activeAnalysisJobId = null;
                });
                void task;
                res.statusCode = 202;
                res.end(JSON.stringify({ jobId, status: job.status, progress: job.progress }));
                return;
              }
              if (precollectionRunning || Boolean(activeAnalysisJobId && analysisJobs.get(activeAnalysisJobId)?.status === "running")) {
                res.statusCode = 409;
                res.end(JSON.stringify({ error: "사전 후보 수집이 끝난 뒤 분석을 시작할 수 있습니다." }));
                return;
              }
              const data = await generateCompetitorBrief(options);
              res.statusCode = 200;
              res.end(JSON.stringify(data));
              return;
            }
            const data = await readLatestReport();
            res.statusCode = data ? 200 : 404;
            res.end(JSON.stringify(data ?? { error: "아직 생성된 분석이 없습니다." }));
          } catch (error) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
          }
        });
        server.middlewares.use("/api/competitor-insights", async (_req, res) => {
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          try {
            const data = rollingInsights(await readBriefArchive(), new Date().toISOString(), true);
            res.statusCode = 200;
            res.end(JSON.stringify(data));
          } catch (error) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
          }
        });
        server.middlewares.use("/api/competitor-news", async (req, res) => {
          try {
            const data = await loadCompetitorNews(req.url?.includes("refresh=1"));
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify(data));
          } catch (error) {
            res.statusCode = 502;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ error: String(error) }));
          }
        });
      },
    },
  ],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(projectRoot, "index.html"),
        history: path.resolve(projectRoot, "history.html"),
        weekly: path.resolve(projectRoot, "weekly-analysis.html"),
      },
    },
  },
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: Number(process.env.PAPR_SERVER_PORT ?? 1430),
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: Number(process.env.PAPR_HMR_PORT ?? 1431),
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
