import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const archivePath = path.join(projectRoot, "reports", "pr-history.json");
const baselinePath = path.join(projectRoot, "reports", "journalist-report-template.html");
const htmlPath = process.env.PAPR_JOURNALIST_REPORT_PATH
  ? path.resolve(process.env.PAPR_JOURNALIST_REPORT_PATH)
  : path.resolve(projectRoot, "..", "..", "PR 브리핑", "PR_기자_디렉터리.html");
const localMonitoringConfigPath = path.join(projectRoot, "config", "pr-monitoring.local.json");
const exampleMonitoringConfigPath = path.join(projectRoot, "config", "pr-monitoring.example.json");
const monitoringConfigPath = await fs.access(localMonitoringConfigPath).then(() => localMonitoringConfigPath).catch(() => exampleMonitoringConfigPath);
const monitoringConfig = JSON.parse(readFileSync(monitoringConfigPath, "utf8"));
const primaryCompanyName = String(monitoringConfig.primaryCompany?.name ?? "Primary Company");
const designatedCompetitors = new Set((monitoringConfig.competitors ?? []).map((item) => String(item.name ?? "").trim()).filter(Boolean));
const primaryReporterExclusions = (monitoringConfig.primaryCompany?.reporterExclusionPatterns ?? []).map((pattern) => new RegExp(pattern, "i"));
const startMarker = "<!-- PR_HISTORY_REPORTER_DATA_START -->";
const endMarker = "<!-- PR_HISTORY_REPORTER_DATA_END -->";

function canonicalUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|fromrss|trackingcode|ref|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return raw.replace(/\/$/, "").toLowerCase();
  }
}

function cleanReporter(value) {
  const reporter = String(value ?? "").replace(/[\s\u00a0]+/g, " ").trim().replace(/\s*기자$/, "");
  return !reporter || /확인 불가|미확인|기자 정보 없음/i.test(reporter) ? "" : reporter;
}

function normalizePublisher(value) {
  const publisher = String(value ?? "").trim();
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
}

function html(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function publishedDateKst(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const localDate = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (/Asia\/Seoul|\bKST\b/i.test(raw) || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) return localDate?.[1] ?? "";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return localDate?.[1] ?? "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

function currentKst() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).format(new Date());
}

function mergeRecord(map, candidate) {
  const key = canonicalUrl(candidate.url);
  if (!key) return;
  const previous = map.get(key) ?? {};
  const next = { ...previous };
  for (const [field, value] of Object.entries(candidate)) {
    if (value === undefined || value === null || String(value).trim() === "") continue;
    if (field === "reporter") {
      if (cleanReporter(value) && !cleanReporter(next.reporter)) next.reporter = cleanReporter(value);
    } else if (!next[field]) {
      next[field] = value;
    }
  }
  next.url = candidate.url || previous.url;
  next._key = key;
  map.set(key, next);
}

function historyReporterArticles(history) {
  const articleMetadata = new Map();
  const reporterKey = (article) => {
    const url = String(article.url ?? "").trim().replace(/\/$/, "").toLowerCase();
    return url || `${String(article.publisher ?? "").trim().toLowerCase()}|${String(article.title ?? "").trim().toLowerCase()}|${String(article.publishedAt ?? "").trim()}`;
  };

  for (const run of history) {
    for (const article of run.articles ?? []) {
      mergeRecord(articleMetadata, article);
      for (const link of article.coverageLinks ?? []) {
        mergeRecord(articleMetadata, {
          ...article,
          ...link,
          company: article.company,
          collectionGroup: article.collectionGroup,
          source_type: article.source_type,
          sourceCategory: article.sourceCategory,
        });
      }
    }
  }

  // Match the reporter rows used by the accumulated PR history page: use raw
  // reporter mentions when present, otherwise fall back to each saved article.
  const mentions = history.flatMap((run) => Array.isArray(run.reporterMentions) && run.reporterMentions.length
    ? run.reporterMentions
    : (run.articles ?? []));
  const unique = new Map();
  for (const mention of mentions) {
    const key = reporterKey(mention);
    const metadata = articleMetadata.get(canonicalUrl(mention.url)) ?? {};
    const article = { ...metadata, ...mention };
    for (const field of ["company", "collectionGroup", "source_type", "sourceCategory", "topicKey", "keywords", "publishedAt"]) {
      if (article[field] === undefined || article[field] === null || article[field] === "") article[field] = metadata[field];
    }
    article._key = key;
    const previous = unique.get(key);
    const reporter = cleanReporter(article.reporter);
    const previousReporter = cleanReporter(previous?.reporter);
    if (!previous || (!previousReporter && reporter)) unique.set(key, article);
  }
  return [...unique.values()];
}

function isPrimaryPress(article) {
  const company = String(article.company ?? "").trim();
  const publisher = String(article.publisher ?? "").trim();
  const category = String(article.sourceCategory ?? "").trim();
  if (!(company === primaryCompanyName || article.collectionGroup === "A")) return false;
  if (article.source_type === "official_blog" || /official\s+blog|공식\s*블로그/i.test(publisher)) return false;
  if (category && !/언론|기사/.test(category)) return false;
  return true;
}

function groupReporters(articles, type) {
  const groups = new Map();
  for (const article of articles) {
    const company = String(article.company ?? "").trim();
    const competitor = designatedCompetitors.has(company)
      && (article.collectionGroup === "B" || !article.collectionGroup);
    if (type === "competitor" && !competitor) continue;
    if (type === "primary" && !isPrimaryPress(article)) continue;
    const reporter = cleanReporter(article.reporter);
    if (!reporter) continue;
    if (type === "primary" && primaryReporterExclusions.some((pattern) => pattern.test(reporter))) continue;

    const group = groups.get(reporter) ?? {
      reporter, articles: new Map(), outlets: new Map(), contacts: new Set(), companies: new Set(), topics: new Map(),
    };
    if (group.articles.has(article._key)) continue;
    group.articles.set(article._key, article);
    const outlet = normalizePublisher(article.publisher);
    if (outlet) group.outlets.set(outlet, (group.outlets.get(outlet) ?? 0) + 1);
    if (company) group.companies.add(company);
    const contact = String(article.reporterContact ?? "").trim().replace(/^mailto:/i, "");
    if (contact) group.contacts.add(contact);
    for (const topic of new Set([
      article.topicKey,
      ...(Array.isArray(article.keywords) ? article.keywords : []),
    ].map((item) => String(item ?? "").replace(/^#+/, "").replace(/[_-]+/g, " ").trim())
      .filter((item) => item && item.length <= 36 && !/[.!?。]$/.test(item)).slice(0, 5))) {
      group.topics.set(topic, (group.topics.get(topic) ?? 0) + 1);
    }
    groups.set(reporter, group);
  }
  return [...groups.values()].sort((a, b) => b.articles.size - a.articles.size || a.reporter.localeCompare(b.reporter, "ko"));
}

function sortedOutlets(group, limit = 3) {
  return [...group.outlets.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ko"))
    .slice(0, limit);
}

function contactHtml(contacts) {
  const contact = [...contacts].sort()[0];
  if (!contact) return "공개 연락처 확인 불가";
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) {
    return `<a href="mailto:${html(contact)}">${html(contact)}</a>`;
  }
  if (/^https?:\/\//i.test(contact)) return `<a href="${html(contact)}" target="_blank" rel="noreferrer">기자 정보</a>`;
  return html(contact);
}

function articleLink(article) {
  const title = String(article.title ?? "기사 제목 확인 불가").trim() || "기사 제목 확인 불가";
  return /^https?:\/\//i.test(String(article.url ?? ""))
    ? `<a href="${html(article.url)}" target="_blank" rel="noreferrer">${html(title)}</a>`
    : html(title);
}

function recentArticles(group, limit = 2) {
  return [...group.articles.values()]
    .sort((a, b) => publishedDateKst(b.publishedAt).localeCompare(publishedDateKst(a.publishedAt)))
    .slice(0, limit);
}

function reporterCards(groups, type, startRank = 1) {
  return groups.map((group, index) => {
    const outlets = sortedOutlets(group, 1);
    const primaryOutlet = outlets[0]
      ? `${html(outlets[0][0])}<span class="outlet-count">${outlets[0][1]}건</span>`
      : "매체 확인 불가";
    const companies = type === "competitor" || type === "all"
      ? [...group.companies].sort((a, b) => a.localeCompare(b, "ko")).map((name) => `<span class="mini-tag">${html(name)}</span>`).join("")
      : "";
    const topics = [...group.topics.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ko"))
      .slice(0, 2)
      .map(([topic]) => `<span class="mini-tag">${html(topic)}</span>`).join("");
    const examples = recentArticles(group).map((article) => `<li>${articleLink(article)}<span>${html(publishedDateKst(article.publishedAt))}</span></li>`).join("");
    const extra = `<details class="reporter-extra"><summary>연락처·최근 기사</summary><div class="extra-body"><p><strong>공개 연락처</strong><br>${contactHtml(group.contacts)}</p>${topics ? `<p><strong>누적 보도 소재</strong><br>${topics}</p>` : ""}<div><strong>최근 기사</strong><ul>${examples || "<li>기사 정보 없음</li>"}</ul></div></div></details>`;
    return `<article class="reporter-card"><div class="reporter-card-head"><span class="rank-badge">${startRank + index}</span><span class="article-count">${group.articles.size}<small>건</small></span></div><h4>${html(group.reporter)}<small>기자</small></h4><div class="reporter-meta"><span class="meta-label">주요 매체</span><span class="primary-outlet">${primaryOutlet}</span></div>${companies ? `<div class="company-tags">${companies}</div>` : ""}${extra}</article>`;
  }).join("\n");
}

function dateRange(articles) {
  const dates = articles.map((article) => publishedDateKst(article.publishedAt)).filter(Boolean).sort();
  return dates.length ? `${dates[0]}~${dates.at(-1)}` : "추가 보도 없음";
}

function renderUpdateSection(allGroups, qualifyingArticleCount, primaryGroups, primaryArticleCount, range, updatedAt) {
  const topCards = reporterCards(allGroups.slice(0, 6), "all");
  const remainingCards = reporterCards(allGroups.slice(6), "all", 7);
  const remainingCount = Math.max(0, allGroups.length - 6);
  const primaryCards = reporterCards(primaryGroups, "primary");
  const reporterContent = allGroups.length
    ? `<div class="reporter-grid">${topCards}</div>${remainingCards ? `<details class="directory more-reporters"><summary>그 외 5건 이상 기자 보기 <span>${remainingCount}명</span></summary><div class="reporter-grid compact-grid">${remainingCards}</div></details>` : ""}`
    : '<p class="empty-state">현재 전체 보관 기록에서 기사 5건 이상인 기자를 찾지 못했어.</p>';
  return `${startMarker}
  <section class="history-section" id="pr-history-reporter-data">
    <div class="section-head"><div><span class="eyebrow">PR HISTORY · REPORTER DATA</span><h2>주요 기자 히스토리</h2><p class="sub">기업 구분 없이 전체 보관 기사 중 5건 이상 확인된 기자를 누적해.</p></div><span class="updated-pill">갱신 ${html(updatedAt)}</span></div>
    <div class="stats">
      <div class="stat"><b>${allGroups.length}명</b><span>5건 이상 기자</span></div>
      <div class="stat"><b>${qualifyingArticleCount}건</b><span>해당 기자의 누적 기사</span></div>
      <div class="stat"><b>${primaryGroups.length}명</b><span>${html(primaryCompanyName)} 보도 기자 · 제한 없음</span></div>
      <div class="stat stat-range"><b>${html(range)}</b><span>기사 발행일 범위</span></div>
    </div>
    <p class="data-note">발행일 범위는 누적 기사 기준이며, 마지막 PR 분석의 수집 종료일과 다를 수 있어.</p>
    <div class="reporter-panels">
      <div class="reporter-panel all-reporters-panel"><div class="panel-head"><div><span class="eyebrow">ALL COMPANIES · 5+ ARTICLES</span><h3>주요 기자</h3></div><span class="panel-total">${allGroups.length}명</span></div><p class="panel-note">전체 기업 기사 중 5건 이상 확인된 기자야. 연락처와 최근 기사는 각 항목을 펼쳐 확인할 수 있어.</p>${reporterContent}</div>
      <div class="reporter-panel all-reporters-panel primary-reporter-panel" id="primary-reporter-section"><div class="panel-head"><div><span class="eyebrow">PRIMARY · PRESS COVERAGE</span><h3>${html(primaryCompanyName)} 보도 기자</h3></div><span class="panel-total">${primaryGroups.length}명 · ${primaryArticleCount}건</span></div><p class="panel-note">주 대상의 외부 언론 보도는 기사 수 제한 없이 표시해.</p>${primaryGroups.length ? `<div class="reporter-grid primary-grid">${primaryCards}</div>` : '<p class="empty-state">기자명이 확인된 주 대상 외부 보도가 없어.</p>'}</div>
    </div>
    <p class="data-note">원본: PR 누적 히스토리 전체 보관 기록 · 같은 기사 URL은 한 번만 집계 · 테스트 발송 제외</p>
  </section>
${endMarker}`;
}

export async function updateCompetitorJournalistReport() {
  const [historyText, baselineHtml] = await Promise.all([
    fs.readFile(archivePath, "utf8"),
    fs.readFile(baselinePath, "utf8"),
  ]);
  const history = JSON.parse(historyText);
  if (!Array.isArray(history)) throw new Error("PR 히스토리 형식이 올바르지 않아.");
  const historyArticles = historyReporterArticles(history);
  const allReporterGroups = groupReporters(historyArticles, "all");
  const allGroups = allReporterGroups.filter((group) => group.articles.size >= 5);
  const qualifyingArticleCount = allGroups.reduce((sum, group) => sum + group.articles.size, 0);
  const primaryGroups = groupReporters(historyArticles, "primary");
  const primaryArticleCount = primaryGroups.reduce((sum, group) => sum + group.articles.size, 0);
  const range = dateRange(historyArticles);
  const updatedAt = currentKst();
  const block = renderUpdateSection(allGroups, qualifyingArticleCount, primaryGroups, primaryArticleCount, range, updatedAt);
  let output = baselineHtml;
  if (output.includes(startMarker) && output.includes(endMarker)) {
    const start = output.indexOf(startMarker);
    const end = output.indexOf(endMarker, start) + endMarker.length;
    output = output.slice(0, start) + block + output.slice(end);
  } else {
    const footer = output.indexOf('  <p class="foot">');
    if (footer < 0) throw new Error("기존 기자 보고서의 마지막 위치를 찾지 못했어.");
    output = output.slice(0, footer) + block + "\n  " + output.slice(footer);
  }
  const tempPath = `${htmlPath}.tmp`;
  await fs.writeFile(tempPath, output, "utf8");
  await fs.rename(tempPath, htmlPath);
  return {
    updated: true,
    path: htmlPath,
    updatedAt,
    qualifyingReporters: allGroups.length,
    qualifyingArticles: qualifyingArticleCount,
    allReporters: allReporterGroups.length,
    primaryReporters: primaryGroups.length,
    primaryArticles: primaryArticleCount,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await updateCompetitorJournalistReport()));
}
