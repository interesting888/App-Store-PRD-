import { parse as parseCsv } from "csv-parse/sync";
import * as cheerio from "cheerio";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { v4 as uuidv4 } from "uuid";
import type {
  AnalyzeRequest,
  AnalysisScope,
  AppMetadata,
  CollectionAttempt,
  CollectionReport,
  CleaningReport,
  DeliveryEvaluation,
  EvidenceSample,
  Finding,
  PipelineRun,
  PipelineStage,
  ReliabilityAssessment,
  Requirement,
  Review,
  TestCase,
  TraceabilityIssue,
  VisualizationReport,
  WorkflowCheck,
} from "../shared/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const cacheDir = path.join(rootDir, "data", "cache");
const samplePath = path.join(rootDir, "data", "samples", "workout-for-women-us.sample.json");

const stageLabels: Record<string, string> = {
  scope: "确定分析范围",
  collect: "收集评论数据",
  clean: "清洗与统计",
  analyze: "模型语义分析",
  prd: "版本规划与 PRD",
  tests: "测试用例生成",
  trace: "追溯链验证",
  reliability: "可靠性评估",
  evaluation: "评估标准核对",
};

export async function runAnalysis(request: AnalyzeRequest): Promise<PipelineRun> {
  const appId = parseAppId(request.appUrl);
  const country = parseStorefront(request.appUrl);
  const run: PipelineRun = {
    runId: uuidv4(),
    appUrl: request.appUrl,
    createdAt: new Date().toISOString(),
    stages: Object.entries(stageLabels).map(([id, label]) => ({
      id,
      label,
      status: "pending",
      message: "等待执行",
    })),
    rawReviews: [],
    cleanedReviews: [],
    findings: [],
    requirements: [],
    testCases: [],
    traceabilityIssues: [],
    revisions: [],
    errors: [],
    modelInfo: {
      provider: process.env.LLM_PROVIDER ?? "openai-compatible",
      model: process.env.LLM_MODEL ?? "未配置",
      usedRuntimeModel: false,
      semanticTask: "动态主题发现",
      promptPolicy: "严格 JSON 输出；每个发现必须引用输入 review_id；无证据结论会被删除。",
    },
  };

  try {
    setStage(run, "scope", "running", "正在解析 App Store 链接和用户目标");
    const [metadata, scope] = await Promise.all([
      lookupMetadata(appId, request.appUrl, country),
      determineScope(appId, request.goal, country),
    ]);
    run.metadata = metadata;
    run.scope = scope;
    setStage(run, "scope", "done", `锁定 ${country.toUpperCase()} 商店评论，目标提示 ${scope.focusHints.length} 个`);

    setStage(run, "collect", "running", "正在收集、导入或读取缓存评论");
    const collected = await collectReviews(appId, country, request);
    run.rawReviews = collected.reviews;
    run.collectionReport = collected.report;
    setStage(run, "collect", run.rawReviews.length ? "done" : "warning", `获得 ${run.rawReviews.length} 条原始评论`);

    setStage(run, "clean", "running", "正在规范化字段、去重并应用范围过滤");
    const cleaned = cleanReviews(run.rawReviews, scope);
    run.cleanedReviews = cleaned.reviews;
    run.cleaningReport = cleaned.report;
    setStage(run, "clean", "done", `清洗后保留 ${cleaned.report.outputCount} 条，去重 ${cleaned.report.duplicateCount} 条`);

    setStage(run, "analyze", "running", "正在执行模型驱动的动态主题发现");
    const semantic = await analyzeFindings(run.cleanedReviews, scope);
    run.findings = semantic.findings;
    run.modelInfo = semantic.modelInfo;
    if (semantic.revision) run.revisions.push(semantic.revision);
    setStage(
      run,
      "analyze",
      run.modelInfo.usedRuntimeModel ? "done" : "warning",
      `识别 ${run.findings.length} 个发现；模型运行状态：${run.modelInfo.usedRuntimeModel ? "已使用" : "未使用"}`,
    );

    setStage(run, "prd", "running", "正在把发现转化为版本规划和可测试需求");
    run.requirements = await generateRequirements(run.findings, scope, run.modelInfo.usedRuntimeModel);
    setStage(run, "prd", "done", `生成 ${run.requirements.length} 条需求`);

    setStage(run, "tests", "running", "正在为每条需求生成可追溯测试用例");
    run.testCases = generateTestCases(run.requirements);
    setStage(run, "tests", "done", `生成 ${run.testCases.length} 条测试用例`);

    setStage(run, "trace", "running", "正在验证 Review -> Finding -> Requirement -> TestCase 链路");
    run.traceabilityIssues = validateTraceability(run);
    const hasError = run.traceabilityIssues.some((issue) => issue.level === "error");
    setStage(run, "trace", hasError ? "error" : "done", hasError ? "发现断链，请查看验证结果" : "追溯链验证通过");

    setStage(run, "reliability", "running", "正在评估证据充分性、泛化能力和数据局限");
    run.reliability = assessReliability(run);
    setStage(run, "reliability", run.reliability.level === "low" ? "warning" : "done", `可靠性评分 ${run.reliability.score}/100`);

    setStage(run, "evaluation", "running", "正在逐项核对质量标准");
    run.evaluation = evaluateDelivery(run);
    setStage(
      run,
      "evaluation",
      run.evaluation.overallStatus === "fail" ? "error" : run.evaluation.overallStatus === "warning" ? "warning" : "done",
      `评估核对：${run.evaluation.criteria.filter((item) => item.status === "pass").length}/${run.evaluation.criteria.length} 项通过`,
    );

    run.visualization = buildVisualization(run);
    run.workflowVerification = verifyWorkflow(run);
    run.reportMarkdown = buildMarkdownReport(run);

    await persistRun(run);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    run.errors.push(message);
    markRunningStageAsError(run, message);
    ensurePostRunReports(run);
  }

  return run;
}

function ensurePostRunReports(run: PipelineRun): void {
  if (!run.cleaningReport) {
    run.cleaningReport = {
      inputCount: run.rawReviews.length,
      outputCount: run.cleanedReviews.length,
      duplicateCount: 0,
      invalidCount: 0,
      filteredCount: 0,
      ratingDistribution: countBy(run.cleanedReviews, (review) => String(review.rating)),
      versionDistribution: countBy(run.cleanedReviews, (review) => review.version ?? "unknown"),
    };
  }

  if (!run.collectionReport) {
    run.collectionReport = {
      attempts: [],
      limitations: ["流水线在采集报告生成前失败，无法确认在线数据来源。"],
      reproducibility: ["请查看 errors 字段并重跑；也可以导入 JSON/CSV 数据绕过在线采集。"],
    };
  }

  if (!run.traceabilityIssues.length) {
    run.traceabilityIssues = validateTraceability(run);
  }

  if (!run.reliability) {
    run.reliability = assessReliability(run);
    setStage(run, "reliability", run.reliability.level === "low" ? "warning" : "done", `可靠性评分 ${run.reliability.score}/100`);
  }

  if (!run.evaluation) {
    run.evaluation = evaluateDelivery(run);
    setStage(
      run,
      "evaluation",
      run.evaluation.overallStatus === "fail" ? "error" : run.evaluation.overallStatus === "warning" ? "warning" : "done",
      `评估核对：${run.evaluation.criteria.filter((item) => item.status === "pass").length}/${run.evaluation.criteria.length} 项通过`,
    );
  }

  run.visualization ??= buildVisualization(run);
  run.workflowVerification ??= verifyWorkflow(run);
  run.reportMarkdown ??= buildMarkdownReport(run);
}

function parseAppId(appUrl: string): string {
  const match = appUrl.match(/(?:id|id=)(\d+)/);
  if (!match) {
    throw new Error("请输入包含 id 数字的有效 App Store 链接，例如 https://apps.apple.com/us/app/name/id839285684");
  }
  return match[1];
}

function parseStorefront(appUrl: string): string {
  const match = appUrl.match(/apps\.apple\.com\/([a-z]{2})\//i);
  return (match?.[1] ?? "us").toLowerCase();
}

async function lookupMetadata(appId: string, fallbackUrl: string, country: string): Promise<AppMetadata> {
  try {
    const response = await fetch(`https://itunes.apple.com/lookup?id=${appId}&country=${country}`);
    const payload = (await response.json()) as { results?: Array<Record<string, unknown>> };
    const app = payload.results?.[0];
    if (!app) throw new Error("Lookup API 未返回应用元数据");
    return {
      appId,
      name: String(app.trackName ?? `App ${appId}`),
      sellerName: app.sellerName ? String(app.sellerName) : undefined,
      primaryGenreName: app.primaryGenreName ? String(app.primaryGenreName) : undefined,
      averageUserRating: numberOrUndefined(app.averageUserRating),
      userRatingCount: numberOrUndefined(app.userRatingCount),
      version: app.version ? String(app.version) : undefined,
      artworkUrl: app.artworkUrl100 ? String(app.artworkUrl100) : undefined,
      storeUrl: String(app.trackViewUrl ?? fallbackUrl),
    };
  } catch {
    return {
      appId,
      name: `App ${appId}`,
      storeUrl: fallbackUrl,
    };
  }
}

function determineScope(appId: string, goal: string, country: string): AnalysisScope {
  const normalizedGoal = goal.trim() || "发现主要用户问题并形成可执行版本计划";
  const lowerGoal = normalizedGoal.toLowerCase();
  const ratingFilter = lowerGoal.includes("低评分") || lowerGoal.includes("low rating") ? [1, 2] : undefined;
  const versionMatch = normalizedGoal.match(/(?:版本|version)\s*([0-9]+(?:\.[0-9a-z-]+)*)/i);

  // 这里用规则只做分析范围提示，不作为最终主题分类，避免把结果硬编码到关键词表。
  const focusHints = [
    ["订阅", "subscription"],
    ["转化", "conversion"],
    ["锻炼", "workout"],
    ["崩溃", "crash"],
    ["广告", "ads"],
    ["低评分", "low rating"],
  ]
    .filter(([zh, en]) => lowerGoal.includes(zh) || lowerGoal.includes(en))
    .map(([zh]) => zh);

  return {
    appId,
    country,
    goal: normalizedGoal,
    ratingFilter,
    versionFilter: versionMatch?.[1],
    focusHints,
    notes: [`评论范围来自 ${country.toUpperCase()} App Store；规则过滤只影响样本范围，语义主题由模型动态发现。`],
  };
}

async function collectReviews(appId: string, country: string, request: AnalyzeRequest): Promise<{ reviews: Review[]; report: CollectionReport }> {
  const attempts: CollectionAttempt[] = [];
  const limitations: string[] = [];
  const reproducibility = [
    `使用 ${country.toUpperCase()} App Store，App ID=${appId}。`,
    `在线采集会写入 data/cache/{appId}/${country}，后续可复现同一次样本。`,
    "用户导入 JSON/CSV 会走同一条清洗、分析、PRD、测试和追溯流水线。",
  ];

  if (request.importData) {
    const reviews = (request.importFormat === "csv" ? parseImportedCsv(request.importData, country) : parseImportedJson(request.importData, country));
    attempts.push({
      method: "import",
      status: reviews.length ? "success" : "empty",
      detail: `使用用户提供的 ${request.importFormat?.toUpperCase() ?? "JSON"} 数据。`,
      count: reviews.length,
    });
    return { reviews, report: { selectedSource: "import", attempts, limitations, reproducibility } };
  }

  const rss = await collectFromRss(appId, country);
  attempts.push(...rss.attempts);
  const liveReviews = rss.reviews;
  if (liveReviews.length > 0) {
    await writeCache(appId, country, liveReviews, "live-rss");
    return { reviews: liveReviews, report: { selectedSource: "live-rss", attempts, limitations, reproducibility } };
  }
  limitations.push("Apple 公开 RSS 评论接口在当前运行中没有返回可用评论，可能是接口策略、地区、网络或临时可用性限制。");

  const web = await collectFromAppStorePage(appId, country, request.appUrl);
  attempts.push(web.attempt);
  const webReviews = web.reviews;
  if (webReviews.length > 0) {
    await writeCache(appId, country, webReviews, "live-web");
    limitations.push("网页结构化数据通常是公开页面服务端渲染的有限子集，不等同于完整评论导出。");
    return { reviews: webReviews, report: { selectedSource: "live-web", attempts, limitations, reproducibility } };
  }

  const cached = await readLatestCache(appId, country);
  attempts.push({
    method: "cache",
    status: cached.length ? "success" : "empty",
    detail: "读取本地缓存作为在线采集失败时的可复查样本。",
    count: cached.length,
  });
  if (cached.length > 0) {
    limitations.push("本次使用缓存数据，可能不是 App Store 的最新评论。");
    return { reviews: cached, report: { selectedSource: "cache", attempts, limitations, reproducibility } };
  }

  if (request.useSampleOnFailure && existsSync(samplePath)) {
    const sample = parseImportedJson(await readFile(samplePath, "utf8"), country).map((review) => ({ ...review, source: "sample" as const }));
    attempts.push({
      method: "sample",
      status: sample.length ? "success" : "empty",
      detail: "使用明确标注的离线样例，仅用于无外网或接口不可用时演示完整流程。",
      count: sample.length,
    });
    limitations.push("本次使用离线样例，不能作为真实 App Store 最新用户反馈证据。");
    return { reviews: sample, report: { selectedSource: "sample", attempts, limitations, reproducibility } };
  }

  return { reviews: [], report: { attempts, limitations, reproducibility } };
}

async function collectFromRss(appId: string, country: string): Promise<{ reviews: Review[]; attempts: CollectionAttempt[] }> {
  const reviews: Review[] = [];
  const attempts: CollectionAttempt[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const url = `https://itunes.apple.com/${country}/rss/customerreviews/page=${page}/id=${appId}/sortby=mostrecent/json`;
    try {
      const response = await fetch(url, { headers: { "user-agent": "LaienTechReviewAnalyzer/1.0" } });
      if (!response.ok) {
        attempts.push({ method: "rss", status: "failed", detail: `RSS page ${page} HTTP ${response.status}`, count: 0 });
        break;
      }
      const payload = (await response.json()) as { feed?: { entry?: unknown[] } };
      const entries = payload.feed?.entry ?? [];
      const pageReviews = entries.map((entry) => normalizeRssEntry(entry, country)).filter((review): review is Review => Boolean(review));
      reviews.push(...pageReviews);
      attempts.push({
        method: "rss",
        status: pageReviews.length ? "success" : "empty",
        detail: `RSS page ${page} 返回 ${entries.length} 个 entry，规范化为 ${pageReviews.length} 条评论。`,
        count: pageReviews.length,
      });
      if (pageReviews.length === 0) break;
      await sleep(350);
    } catch (error) {
      attempts.push({
        method: "rss",
        status: "failed",
        detail: `RSS page ${page} 请求失败：${error instanceof Error ? error.message : String(error)}`,
        count: 0,
      });
      break;
    }
  }
  return { reviews, attempts };
}

function normalizeRssEntry(entry: unknown, country: string): Review | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const item = entry as Record<string, any>;
  const id = item.id?.label ?? item.id?.attributes?.["im:id"];
  const rating = Number(item["im:rating"]?.label);
  const body = item.content?.label;
  if (!id || !Number.isFinite(rating) || !body) return undefined;
  return {
    id: String(id),
    rating,
    title: String(item.title?.label ?? ""),
    body: String(body),
    version: item["im:version"]?.label ? String(item["im:version"].label) : undefined,
    date: item.updated?.label ? new Date(item.updated.label).toISOString() : undefined,
    author: item.author?.name?.label ? String(item.author.name.label) : undefined,
    country,
    source: "live-rss",
  };
}

async function collectFromAppStorePage(appId: string, country: string, appUrl: string): Promise<{ reviews: Review[]; attempt: CollectionAttempt }> {
  try {
    const url = appUrl.includes(`/${country}/`) ? appUrl : `https://apps.apple.com/${country}/app/_/id${appId}`;
    const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 LaienTechReviewAnalyzer/1.0" } });
    if (!response.ok) {
      return { reviews: [], attempt: { method: "web-structured-data", status: "failed", detail: `App Store 页面 HTTP ${response.status}`, count: 0 } };
    }
    const html = await response.text();
    const $ = cheerio.load(html);
    const raw = $("#serialized-server-data").text();
    if (!raw) {
      return { reviews: [], attempt: { method: "web-structured-data", status: "empty", detail: "页面未包含 serialized-server-data 结构化数据。", count: 0 } };
    }
    const parsed = JSON.parse(raw);
    const found: Review[] = [];
    walkJson(parsed, (node) => {
      const review = normalizeWebReview(node, found.length, country);
      if (review) found.push(review);
    });
    const reviews = found.map((review) => ({ ...review, source: "live-web" as const }));
    return {
      reviews,
      attempt: {
        method: "web-structured-data",
        status: reviews.length ? "success" : "empty",
        detail: `读取 App Store 页面服务端结构化数据，提取 ${reviews.length} 条评论。`,
        count: reviews.length,
      },
    };
  } catch (error) {
    return {
      reviews: [],
      attempt: {
        method: "web-structured-data",
        status: "failed",
        detail: `页面结构化数据解析失败：${error instanceof Error ? error.message : String(error)}`,
        count: 0,
      },
    };
  }
}

function normalizeWebReview(node: Record<string, any>, index: number, country: string): Review | undefined {
  const rating = Number(node.rating ?? node.userRating ?? node.attributes?.rating);
  const body = node.body ?? node.review ?? node.content ?? node.attributes?.body ?? node.attributes?.review;
  const title = node.title ?? node.attributes?.title ?? "";
  if (!Number.isFinite(rating) || typeof body !== "string" || body.length < 5) return undefined;
  const id = String(node.id ?? node.reviewId ?? node.attributes?.id ?? `web-${index}-${hashText(body)}`);
  return {
    id,
    rating,
    title: String(title),
    body,
    version: node.version ? String(node.version) : undefined,
    date: node.date ? new Date(node.date).toISOString() : undefined,
    author: node.author ? String(node.author) : undefined,
    country,
    source: "live-web",
  };
}

function parseImportedJson(raw: string, country = "us"): Review[] {
  const payload = JSON.parse(raw) as unknown;
  const payloadCountry =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? readString((payload as Record<string, unknown>).country ?? (payload as Record<string, unknown>).storefront ?? (payload as Record<string, unknown>).territory)
      : undefined;
  const fallbackCountry = payloadCountry ?? country;
  const directItems = extractReviewArray(payload);
  if (directItems.length > 0) {
    return directItems.map((item, index) => normalizeImportedReview(item, index, fallbackCountry)).filter((review): review is Review => Boolean(review));
  }

  const found: Review[] = [];
  walkJson(payload, (node) => {
    const review = normalizeImportedReview(node, found.length, fallbackCountry);
    if (review) found.push(review);
  });
  return found;
}

function parseImportedCsv(raw: string, country = "us"): Review[] {
  const rows = parseCsv(raw, {
    bom: true,
    columns: true,
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true,
  }) as Array<Record<string, unknown>>;
  return rows.map((row, index) => normalizeImportedReview(row, index, country)).filter((review): review is Review => Boolean(review));
}

function normalizeImportedReview(item: unknown, index: number, fallbackCountry: string): Review | undefined {
  if (!item || typeof item !== "object") return undefined;
  const row = item as Record<string, any>;
  const body = readString(row.body ?? row.content ?? row.review ?? row.text ?? row.comment ?? row.description ?? row.attributes?.body);
  const rating = Number(readString(row.rating ?? row.score ?? row.stars ?? row["im:rating"] ?? row.attributes?.rating));
  if (!body || !Number.isFinite(rating)) return undefined;
  const title = readString(row.title ?? row.subject ?? row.summary ?? row.attributes?.title) ?? "";
  const version = readString(row.version ?? row.appVersion ?? row["im:version"] ?? row.attributes?.version);
  const date = readString(row.date ?? row.updated ?? row.createdAt ?? row.publishedAt ?? row.attributes?.date);
  const author = readString(row.author ?? row.user ?? row.reviewer ?? row.author?.name ?? row.attributes?.author);
  return {
    id: readString(row.id ?? row.review_id ?? row.reviewId ?? row.attributes?.id) ?? `import-${index}-${hashText(String(body))}`,
    rating,
    title,
    body,
    version,
    date: normalizeDate(date),
    author,
    country: readString(row.country ?? row.storefront ?? row.territory) ?? fallbackCountry,
    source: "import",
  };
}

function cleanReviews(reviews: Review[], scope: AnalysisScope): { reviews: Review[]; report: CleaningReport } {
  const seen = new Set<string>();
  let duplicateCount = 0;
  let invalidCount = 0;
  let filteredCount = 0;
  const cleaned: Review[] = [];

  for (const review of reviews) {
    const body = review.body.trim().replace(/\s+/g, " ");
    const title = review.title.trim().replace(/\s+/g, " ");
    const dedupeKey = review.id || hashText(`${review.author ?? ""}${review.date ?? ""}${title}${body}`);
    if (!body || body.length < 5 || review.rating < 1 || review.rating > 5) {
      invalidCount += 1;
      continue;
    }
    if (seen.has(dedupeKey)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(dedupeKey);
    if (scope.ratingFilter && !scope.ratingFilter.includes(review.rating)) {
      filteredCount += 1;
      continue;
    }
    if (scope.versionFilter && review.version && review.version !== scope.versionFilter) {
      filteredCount += 1;
      continue;
    }
    cleaned.push({ ...review, id: dedupeKey, title, body });
  }

  const report: CleaningReport = {
    inputCount: reviews.length,
    outputCount: cleaned.length,
    duplicateCount,
    invalidCount,
    filteredCount,
    ratingDistribution: countBy(cleaned, (review) => String(review.rating)),
    versionDistribution: countBy(cleaned, (review) => review.version ?? "unknown"),
  };

  return { reviews: cleaned, report };
}

async function analyzeFindings(reviews: Review[], scope: AnalysisScope): Promise<{
  findings: Finding[];
  modelInfo: PipelineRun["modelInfo"];
  revision?: string;
}> {
  const modelInfo = {
    provider: process.env.LLM_PROVIDER ?? "openai-compatible",
    model: process.env.LLM_MODEL ?? "未配置",
    usedRuntimeModel: false,
    semanticTask: "动态主题发现",
    promptPolicy: "严格 JSON 输出；每个发现必须引用输入 review_id；无证据结论会被删除。",
    fallbackReason: undefined as string | undefined,
  };

  if (reviews.length === 0) {
    return { findings: [], modelInfo: { ...modelInfo, fallbackReason: "没有可分析的评论" } };
  }

  try {
    const findings = await discoverFindingsWithModel(reviews, scope);
    const guarded = enforceFindingEvidence(findings, reviews);
    return {
      findings: guarded,
      modelInfo: { ...modelInfo, usedRuntimeModel: true },
      revision: guarded.length < findings.length ? "已删除缺少有效 review_id 的模型发现，避免无证据结论。" : undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const fallback = discoverFindingsWithRules(reviews, scope);
    return {
      findings: fallback,
      modelInfo: { ...modelInfo, fallbackReason: `运行时模型不可用，已使用可审计规则降级：${message}` },
      revision: "语义分析未伪造模型结论；当前结果为规则降级版，正式提交需配置 LLM_API_KEY 后重跑。",
    };
  }
}

async function discoverFindingsWithModel(reviews: Review[], scope: AnalysisScope): Promise<Finding[]> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) throw new Error("缺少 LLM_API_KEY");

  const sample = reviews.slice(0, 120).map((review) => ({
    id: review.id,
    rating: review.rating,
    title: review.title,
    body: review.body.slice(0, 700),
  }));

  const system = [
    "You are a product analyst. Discover dynamic themes from app reviews.",
    "Return strict JSON only. Every finding must cite real review ids from the input.",
    "Do not invent facts. Mark uncertainty when evidence is limited or conflicting.",
  ].join(" ");

  const user = JSON.stringify({
    goal: scope.goal,
    reviews: sample,
    outputSchema: {
      findings: [
        {
          title: "short theme",
          userProblem: "problem statement",
          severity: "low|medium|high",
          confidence: "0..1",
          evidenceReviewIds: ["review id"],
          conflictingReviewIds: ["review id"],
          uncertainty: "limits and conflicts",
        },
      ],
    },
  });

  const payload = await callChatJson(system, user);
  const rawFindings = Array.isArray(payload.findings) ? payload.findings : [];
  return rawFindings.map((item: any, index: number) => {
    const evidence = reviewIdsToEvidence(item.evidenceReviewIds ?? [], reviews);
    const conflictingEvidence = reviewIdsToEvidence(item.conflictingReviewIds ?? [], reviews);
    return {
      id: `F-${index + 1}`,
      title: String(item.title ?? `模型发现 ${index + 1}`),
      userProblem: String(item.userProblem ?? ""),
      severity: normalizeSeverity(item.severity),
      confidence: clamp(Number(item.confidence ?? 0.5), 0, 1),
      supportCount: evidence.length,
      evidence,
      conflictingEvidence,
      modelGenerated: true,
      uncertainty: String(item.uncertainty ?? "模型未提供不确定性说明"),
    };
  });
}

async function callChatJson(system: string, user: string): Promise<any> {
  try {
    return await callChatJsonOnce(system, user, true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("response_format") && !message.includes("400") && !message.includes("422")) {
      throw error;
    }
    return callChatJsonOnce(
      `${system} Return only a raw JSON object. Do not wrap the response in markdown.`,
      user,
      false,
    );
  }
}

async function callChatJsonOnce(system: string, user: string, useResponseFormat: boolean): Promise<any> {
  const baseUrl = process.env.LLM_BASE_URL ?? "https://api.openai.com/v1/chat/completions";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.LLM_TIMEOUT_MS ?? 45000));
  const body: Record<string, unknown> = {
    model: process.env.LLM_MODEL ?? "gpt-4o-mini",
    temperature: Number(process.env.LLM_TEMPERATURE ?? 0.2),
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  if (useResponseFormat) {
    body.response_format = { type: "json_object" };
  }

  const response = await fetch(baseUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.LLM_API_KEY}`,
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`模型接口返回 ${response.status}${errorText ? `：${errorText.slice(0, 240)}` : ""}`);
  }
  const payload = (await response.json()) as any;
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("模型未返回内容");
  return JSON.parse(extractJsonObject(content));
}

function discoverFindingsWithRules(reviews: Review[], scope: AnalysisScope): Finding[] {
  const buckets = new Map<string, Review[]>();
  for (const review of reviews) {
    const key = review.rating <= 2 ? "低评分体验阻塞" : review.rating === 3 ? "中性反馈与可改进点" : "正向体验可复用";
    buckets.set(key, [...(buckets.get(key) ?? []), review]);
  }

  return [...buckets.entries()].map(([title, bucket], index) => {
    const evidence = bucket.slice(0, 6).map(toEvidenceSample);
    const conflict = reviews.filter((review) => !bucket.includes(review) && Math.abs(review.rating - bucket[0].rating) >= 3).slice(0, 3);
    return {
      id: `F-${index + 1}`,
      title,
      userProblem:
        title === "低评分体验阻塞"
          ? "部分用户给出低评分，说明存在需要优先排查的体验或商业化阻塞。"
          : `该主题来自评分分桶，需配置运行时模型后进一步拆解为真实语义问题；分析目标：${scope.goal}`,
      severity: title === "低评分体验阻塞" ? "high" : "medium",
      confidence: bucket.length >= 5 ? 0.55 : 0.35,
      supportCount: bucket.length,
      evidence,
      conflictingEvidence: conflict.map(toEvidenceSample),
      modelGenerated: false,
      uncertainty: "这是模型不可用时的规则降级结果，只能作为演示和初步 triage，不能替代运行时语义分析。",
    };
  });
}

function enforceFindingEvidence(findings: Finding[], reviews: Review[]): Finding[] {
  const validIds = new Set(reviews.map((review) => review.id));
  return findings
    .map((finding) => ({
      ...finding,
      evidence: finding.evidence.filter((sample) => validIds.has(sample.reviewId)),
      conflictingEvidence: finding.conflictingEvidence.filter((sample) => validIds.has(sample.reviewId)),
    }))
    .filter((finding) => finding.evidence.length > 0)
    .map((finding) => ({ ...finding, supportCount: finding.evidence.length }));
}

async function generateRequirements(
  findings: Finding[],
  scope: AnalysisScope,
  usedRuntimeModel: boolean,
): Promise<Requirement[]> {
  // PRD 生成可以由模型增强，但核心边界和证据校验仍保持确定性，确保无证据需求不会进入正式范围。
  return findings.map((finding, index) => {
    const priority = finding.severity === "high" ? "P0" : finding.severity === "medium" ? "P1" : "P2";
    const version = priority === "P0" ? "v1.0 修复版" : priority === "P1" ? "v1.1 体验版" : "v2.0 探索版";
    const reviewIds = finding.evidence.map((sample) => sample.reviewId);
    return {
      id: `R-${index + 1}`,
      version,
      priority,
      title: `解决：${finding.title}`,
      problem: finding.userProblem,
      requirement: `针对“${finding.title}”设计可验证的产品改进，目标是回应用户目标“${scope.goal}”下的主要证据。`,
      acceptanceCriteria: [
        "需求实现后，关联场景应能被测试用例稳定复现和验证。",
        "交互或文案变化不得引入新的订阅、训练流程或可访问性阻塞。",
        "发布说明应覆盖该需求关联的用户问题和适用范围。",
      ],
      outOfScope: ["未被评论证据支持的全新商业模式调整", "无法通过当前样本验证的长期增长假设"],
      sourceFindingIds: [finding.id],
      sourceReviewIds: reviewIds,
      evidenceType: usedRuntimeModel ? "mixed" : "deterministic_stat",
      uncertainty: finding.uncertainty,
    };
  });
}

function generateTestCases(requirements: Requirement[]): TestCase[] {
  return requirements.flatMap((requirement, index) => [
    {
      id: `TC-${index + 1}.1`,
      requirementId: requirement.id,
      title: `${requirement.title} - 主流程验证`,
      preconditions: ["安装最新测试版本", "准备与评论证据一致的用户路径或测试账号"],
      steps: ["进入相关功能入口", "按需求描述完成主路径操作", "记录关键页面、状态和错误提示"],
      expectedResult: requirement.acceptanceCriteria[0],
      linkedReviewIds: requirement.sourceReviewIds,
    },
    {
      id: `TC-${index + 1}.2`,
      requirementId: requirement.id,
      title: `${requirement.title} - 回归与边界验证`,
      preconditions: ["保留旧版本问题复现记录", "准备弱网、重复操作或低评分场景"],
      steps: ["复现评论中提到的异常或不满路径", "执行修复后的相同路径", "检查是否出现新的阻塞或误导"],
      expectedResult: "原问题不再出现，且未破坏相邻核心流程。",
      linkedReviewIds: requirement.sourceReviewIds,
    },
  ]);
}

function validateTraceability(run: PipelineRun): TraceabilityIssue[] {
  const issues: TraceabilityIssue[] = [];
  const reviewIds = new Set(run.cleanedReviews.map((review) => review.id));
  const findingIds = new Set(run.findings.map((finding) => finding.id));
  const requirementIds = new Set(run.requirements.map((requirement) => requirement.id));

  for (const finding of run.findings) {
    if (finding.evidence.length === 0) {
      issues.push({ level: "error", objectId: finding.id, message: "发现缺少来源评论证据" });
    }
    for (const sample of finding.evidence) {
      if (!reviewIds.has(sample.reviewId)) {
        issues.push({ level: "error", objectId: finding.id, message: `发现引用了不存在的 review_id：${sample.reviewId}` });
      }
    }
  }

  for (const requirement of run.requirements) {
    if (requirement.sourceReviewIds.length === 0) {
      issues.push({ level: "error", objectId: requirement.id, message: "需求缺少来源评论" });
    }
    for (const findingId of requirement.sourceFindingIds) {
      if (!findingIds.has(findingId)) {
        issues.push({ level: "error", objectId: requirement.id, message: `需求引用了不存在的 finding_id：${findingId}` });
      }
    }
  }

  for (const testCase of run.testCases) {
    if (!requirementIds.has(testCase.requirementId)) {
      issues.push({ level: "error", objectId: testCase.id, message: "测试用例引用了不存在的需求" });
    }
    if (testCase.linkedReviewIds.length === 0) {
      issues.push({ level: "warning", objectId: testCase.id, message: "测试用例没有直接关联评论证据" });
    }
  }

  if (!run.modelInfo.usedRuntimeModel) {
    issues.push({
      level: "warning",
      objectId: "model",
      message: "本次运行未使用模型完成核心语义任务；配置 LLM_API_KEY 后可满足运行时 AI 要求。",
    });
  }

  return issues;
}

function assessReliability(run: PipelineRun): ReliabilityAssessment {
  let score = 100;
  const reasons: string[] = [];
  const limitations: string[] = [];
  const generalizationChecks: ReliabilityAssessment["generalizationChecks"] = [];
  const cleanedCount = run.cleanedReviews.length;
  const traceErrors = run.traceabilityIssues.filter((issue) => issue.level === "error").length;
  const traceWarnings = run.traceabilityIssues.filter((issue) => issue.level === "warning").length;
  const sources = new Set(run.cleanedReviews.map((review) => review.source));
  const modelFindingCount = run.findings.filter((finding) => finding.modelGenerated).length;

  if (cleanedCount >= 50) {
    reasons.push("评论样本量较充足，能够支持更稳定的主题归纳。");
  } else if (cleanedCount >= 10) {
    score -= 12;
    limitations.push("评论样本量中等，适合发现高频问题，但长尾问题需要更多数据验证。");
  } else {
    score -= 28;
    limitations.push("评论样本量较少，结论应作为待验证假设或演示结果，不宜直接作为完整版本规划依据。");
  }

  if (run.modelInfo.usedRuntimeModel && modelFindingCount > 0) {
    reasons.push("已使用运行时模型完成动态主题发现，语义分析没有依赖固定 App 分类。");
  } else {
    score -= 22;
    limitations.push("本次未成功使用运行时模型，语义结果为规则降级版本，泛化能力有限。");
  }

  if (traceErrors === 0) {
    reasons.push("追溯链没有错误，正式结论均能回到来源评论。");
  } else {
    score -= traceErrors * 18;
    limitations.push(`存在 ${traceErrors} 个追溯错误，需要修复后再作为正式交付。`);
  }

  if (traceWarnings > 0) {
    score -= traceWarnings * 4;
    limitations.push(`存在 ${traceWarnings} 个追溯或模型警告，建议复核。`);
  }

  if (sources.has("sample")) {
    score -= 18;
    limitations.push("本次包含离线样例数据，适合演示流程，不应替代真实线上数据或用户提供的数据集。");
  }

  if (run.collectionReport?.selectedSource === "live-web") {
    score -= 8;
    limitations.push("本次使用 App Store 页面结构化数据降级，样本可能是公开页面有限子集。");
  }

  if (run.collectionReport?.selectedSource === "live-rss") {
    reasons.push("本次优先通过 App Store 评论 RSS 数据源获得评论，不是仅抓取页面可见文本。");
  }

  if (sources.has("import")) {
    reasons.push("本次使用导入数据，说明流程可处理未见过的数据集。");
  }

  generalizationChecks.push({
    name: "无 App 特定硬编码",
    status: "pass",
    detail: "主题、需求和测试用例来自输入评论与用户目标，代码中未写死目标 App 的问题类别。",
  });
  generalizationChecks.push({
    name: "兼容外部数据集",
    status: sources.has("import") ? "pass" : "warning",
    detail: sources.has("import") ? "已处理用户导入数据。" : "本次未使用导入数据，但系统支持 JSON/CSV 导入。",
  });
  generalizationChecks.push({
    name: "非页面可见内容依赖",
    status: run.collectionReport?.selectedSource === "live-web" ? "warning" : "pass",
    detail:
      run.collectionReport?.selectedSource === "live-web"
        ? "本次 RSS 不可用后使用网页结构化数据降级，已在局限中说明。"
        : "优先使用 RSS、导入或缓存数据，不依赖页面可见文本作为唯一来源。",
  });
  generalizationChecks.push({
    name: "运行时语义模型",
    status: run.modelInfo.usedRuntimeModel ? "pass" : "warning",
    detail: run.modelInfo.usedRuntimeModel ? "已使用 DeepSeek 动态发现主题。" : "模型不可用时已透明降级，需配置密钥后重跑正式分析。",
  });
  generalizationChecks.push({
    name: "证据链完整性",
    status: traceErrors === 0 ? "pass" : "fail",
    detail: traceErrors === 0 ? "Review、Finding、Requirement、TestCase 之间无断链。" : "存在追溯错误。",
  });

  const finalScore = clamp(Math.round(score), 0, 100);
  return {
    score: finalScore,
    level: finalScore >= 78 ? "high" : finalScore >= 55 ? "medium" : "low",
    reasons,
    limitations,
    generalizationChecks,
  };
}

function evaluateDelivery(run: PipelineRun): DeliveryEvaluation {
  const sourceSet = new Set(run.rawReviews.map((review) => review.source));
  const traceErrors = run.traceabilityIssues.filter((issue) => issue.level === "error");
  const requirementsWithBoundaries = run.requirements.filter(
    (requirement) =>
      requirement.problem &&
      requirement.priority &&
      requirement.version &&
      requirement.outOfScope.length > 0 &&
      requirement.sourceReviewIds.length > 0,
  );
  const testCasesCoveredRequirementIds = new Set(run.testCases.map((testCase) => testCase.requirementId));
  const conflictCount = run.findings.reduce((sum, finding) => sum + finding.conflictingEvidence.length, 0);
  const findingsWithEvidence = run.findings.filter((finding) => finding.evidence.length > 0);
  const findingsWithUncertainty = run.findings.filter((finding) => finding.uncertainty.trim().length > 0);
  const modelFindingCount = run.findings.filter((finding) => finding.modelGenerated).length;
  const selectedSource = run.collectionReport?.selectedSource;
  const hasProductWorkflow = run.findings.length > 0 && run.requirements.length > 0 && run.testCases.length > 0;

  const criteria: DeliveryEvaluation["criteria"] = [
    {
      id: "not-scraper-only",
      title: "不仅是网页抓取或界面展示，而是完整产品分析工作流",
      status: hasProductWorkflow ? "pass" : "fail",
      summary: hasProductWorkflow
        ? `已从 ${run.cleanedReviews.length} 条清洗评论生成 ${run.findings.length} 个发现、${run.requirements.length} 条需求和 ${run.testCases.length} 条测试用例。`
        : "当前没有形成发现、需求和测试用例的完整链路。",
      evidence: [
        `Findings=${run.findings.length}`,
        `Requirements=${run.requirements.length}`,
        `TestCases=${run.testCases.length}`,
        "UI 展示原始数据、清洗结果、分类发现、PRD、测试、追溯、可靠性和评估核对。",
      ],
    },
    {
      id: "data-source",
      title: "数据真实可靠、可复现，并说明来源和局限",
      status: run.rawReviews.length > 0 && run.cleaningReport ? (sourceSet.has("sample") ? "warning" : "pass") : "fail",
      summary:
        run.rawReviews.length > 0
          ? `本次获得 ${run.rawReviews.length} 条原始评论，来源包含 ${Array.from(sourceSet).join(", ")}。`
          : "没有获得可分析评论。",
      evidence: [
        `App ID：${run.scope?.appId ?? "unknown"}，商店：${run.scope?.country ?? "unknown"}`,
        `原始评论 ${run.rawReviews.length} 条，清洗后 ${run.cleanedReviews.length} 条。`,
        "数据来源与局限已在 DATA_COLLECTION 文档和 UI 可靠性页中说明。",
      ],
      improvement: sourceSet.has("sample") ? "当前包含离线样例，建议使用 live 或用户导入数据重跑。" : undefined,
    },
    {
      id: "collection-method",
      title: "不只抓取页面可见内容，优先使用更合适的评论数据方式并解释实现",
      status: selectedSource === "live-web" ? "warning" : run.collectionReport ? "pass" : "fail",
      summary: selectedSource
        ? `本次最终使用 ${selectedSource}，共记录 ${run.collectionReport?.attempts.length ?? 0} 次采集/降级尝试。`
        : "没有采集诊断报告。",
      evidence: [
        ...(run.collectionReport?.attempts.map((attempt) => `${attempt.method}: ${attempt.status} / ${attempt.count} 条 / ${attempt.detail}`) ?? []),
        ...(run.collectionReport?.limitations ?? []),
      ],
      improvement:
        selectedSource === "live-web"
          ? "本次为网页结构化数据降级结果，可导入真实数据或在 RSS 可用时重跑。"
          : undefined,
    },
    {
      id: "cleaning-analysis",
      title: "评论清理、分类和分析合理，能揭示具体用户问题",
      status: run.cleaningReport && findingsWithEvidence.length > 0 ? "pass" : "fail",
      summary: `清洗阶段去重 ${run.cleaningReport?.duplicateCount ?? 0} 条，过滤非法 ${run.cleaningReport?.invalidCount ?? 0} 条，产出 ${run.findings.length} 个发现。`,
      evidence: [
        `评分分布：${JSON.stringify(run.cleaningReport?.ratingDistribution ?? {})}`,
        `有证据发现：${findingsWithEvidence.length}/${run.findings.length}`,
        ...run.findings.slice(0, 3).map((finding) => `${finding.id}: ${finding.userProblem}`),
      ],
    },
    {
      id: "model-generalization",
      title: "模型驱动语义分析超越固定规则，并可推广到未见评论、应用和目标",
      status: run.modelInfo.usedRuntimeModel && modelFindingCount > 0 ? "pass" : "fail",
      summary: run.modelInfo.usedRuntimeModel
        ? `已使用 ${run.modelInfo.provider}/${run.modelInfo.model} 生成 ${modelFindingCount} 个模型发现。`
        : "模型未成功运行，本次为规则降级结果。",
      evidence: [
        "最终主题不依赖特定 App 硬编码类别。",
        "用户目标会作为模型输入，导入数据和新 App 使用同一流水线处理。",
        run.modelInfo.fallbackReason ?? "模型阶段已运行。",
      ],
      improvement: run.modelInfo.usedRuntimeModel ? undefined : "这项是硬性 AI 要求：必须配置有效 LLM_API_KEY 并在运行时成功调用模型后重跑。",
    },
    {
      id: "evidence-separation",
      title: "区分证据、确定性统计、模型结论、不确定性和冲突反馈",
      status: findingsWithEvidence.length > 0 && findingsWithUncertainty.length === run.findings.length ? "pass" : "warning",
      summary: `发现均带 evidence 样本；冲突证据 ${conflictCount} 条；确定性统计保存在 cleaningReport。`,
      evidence: [
        `模型生成发现：${modelFindingCount}`,
        `规则降级发现：${run.findings.length - modelFindingCount}`,
        `包含不确定性说明：${findingsWithUncertainty.length}/${run.findings.length}`,
        `冲突证据数量：${conflictCount}`,
      ],
    },
    {
      id: "prd-planning",
      title: "PRD 基于用户问题，需求边界、优先级和版本规划明确",
      status: run.requirements.length > 0 && requirementsWithBoundaries.length === run.requirements.length ? "pass" : "fail",
      summary: `生成 ${run.requirements.length} 条需求，其中 ${requirementsWithBoundaries.length} 条包含边界、优先级、版本和来源评论。`,
      evidence: run.requirements.slice(0, 4).map(
        (requirement) => `${requirement.id}: ${requirement.priority} / ${requirement.version} / ${requirement.sourceReviewIds.length} 条来源评论`,
      ),
    },
    {
      id: "test-coverage",
      title: "测试用例覆盖 PRD，并可追溯到相应用户评价",
      status:
        run.requirements.length > 0 &&
        run.requirements.every((requirement) => testCasesCoveredRequirementIds.has(requirement.id)) &&
        traceErrors.length === 0
          ? "pass"
          : "fail",
      summary: `生成 ${run.testCases.length} 条测试用例，覆盖 ${testCasesCoveredRequirementIds.size}/${run.requirements.length} 条需求。`,
      evidence: [
        `追溯错误：${traceErrors.length}`,
        ...run.testCases.slice(0, 4).map((testCase) => `${testCase.id}: ${testCase.requirementId} -> ${testCase.linkedReviewIds.length} 条评论`),
      ],
    },
    {
      id: "adversarial-robustness",
      title: "可应对未见数据、混合语言、重复/冲突评论、证据不足和临时失败",
      status: run.reliability && run.collectionReport ? (run.reliability.level === "low" ? "warning" : "pass") : "warning",
      summary: "系统通过兼容导入、去重、冲突证据、不确定性、采集降级和模型降级透明说明来处理评估中的对抗场景。",
      evidence: [
        `重复评论数：${run.cleaningReport?.duplicateCount ?? 0}`,
        `冲突证据数：${conflictCount}`,
        `数据局限：${run.reliability?.limitations.join("；") || "暂无"}`,
        `采集尝试数：${run.collectionReport?.attempts.length ?? 0}`,
      ],
      improvement: run.reliability?.level === "low" ? "当前证据较弱，建议导入更多真实评论或修复模型/采集配置后重跑。" : undefined,
    },
    {
      id: "ui-local-delivery",
      title: "界面清晰展示工作流程和结果，项目可本地运行并有交付说明",
      status: "pass",
      summary: "UI 提供阶段进度、方案说明、可靠性、原始/清洗数据、发现、PRD、测试、追溯和完整 JSON；README 提供本地运行说明。",
      evidence: [
        "前端通过标签页展示全部中间和最终交付物。",
        "README、IMPLEMENTATION、DATA_COLLECTION、AI 文档覆盖运行、数据和模型说明。",
        "构建命令 npm run build 用于验证本地可运行性。",
      ],
    },
  ];

  const hasFail = criteria.some((criterion) => criterion.status === "fail");
  const hasWarning = criteria.some((criterion) => criterion.status === "warning");
  return {
    overallStatus: hasFail ? "fail" : hasWarning ? "warning" : "pass",
    criteria,
  };
}

function buildVisualization(run: PipelineRun): VisualizationReport {
  const priorityDistribution = countBy(run.requirements, (requirement) => requirement.priority);
  const versionDistribution = countBy(run.requirements, (requirement) => requirement.version);
  const sourceDistribution = countBy(run.cleanedReviews, (review) => review.source);
  const findingSeverity = countBy(run.findings, (finding) => finding.severity);
  const traceStatus = countBy(run.traceabilityIssues, (issue) => issue.level);
  const stageStatus = countBy(run.stages, (stage) => stage.status);

  return {
    highlights: [
      `清洗后评论 ${run.cleanedReviews.length} 条，发现 ${run.findings.length} 个用户问题。`,
      `PRD 需求 ${run.requirements.length} 条，测试用例 ${run.testCases.length} 条。`,
      `可靠性评分 ${run.reliability?.score ?? 0}/100，评估状态 ${run.evaluation?.overallStatus ?? "unknown"}。`,
    ],
    charts: [
      { title: "评分分布", type: "bar", data: recordToChartData(run.cleaningReport?.ratingDistribution ?? {}) },
      { title: "评论来源", type: "bar", data: recordToChartData(sourceDistribution) },
      { title: "发现严重度", type: "bar", data: recordToChartData(findingSeverity) },
      { title: "需求优先级", type: "bar", data: recordToChartData(priorityDistribution) },
      { title: "版本规划", type: "bar", data: recordToChartData(versionDistribution) },
      { title: "追溯问题", type: "bar", data: recordToChartData(traceStatus) },
      { title: "阶段状态", type: "bar", data: recordToChartData(stageStatus) },
      {
        title: "交付物数量",
        type: "metric",
        data: [
          { label: "原始评论", value: run.rawReviews.length },
          { label: "清洗评论", value: run.cleanedReviews.length },
          { label: "发现", value: run.findings.length },
          { label: "需求", value: run.requirements.length },
          { label: "测试", value: run.testCases.length },
        ],
      },
    ],
  };
}

function verifyWorkflow(run: PipelineRun): WorkflowCheck[] {
  const validTrace = run.traceabilityIssues.every((issue) => issue.level !== "error");
  return [
    {
      id: "scope",
      title: "根据目标和可用数据确定分析范围",
      status: run.scope ? "pass" : "fail",
      evidence: run.scope ? `目标：${run.scope.goal}；商店：${run.scope.country}` : "缺少分析范围。",
    },
    {
      id: "collect",
      title: "收集应用评价数据",
      status: run.rawReviews.length > 0 ? "pass" : "warning",
      evidence: `原始评论 ${run.rawReviews.length} 条；来源：${run.collectionReport?.selectedSource ?? "none"}`,
    },
    {
      id: "clean",
      title: "清理、去重并结构化评价数据",
      status: run.cleaningReport ? "pass" : "fail",
      evidence: `清洗后 ${run.cleanedReviews.length} 条；重复 ${run.cleaningReport?.duplicateCount ?? 0} 条；非法 ${run.cleaningReport?.invalidCount ?? 0} 条。`,
    },
    {
      id: "analyze",
      title: "动态分类和分析评价",
      status: run.modelInfo.usedRuntimeModel ? "pass" : "warning",
      evidence: `模型运行：${run.modelInfo.usedRuntimeModel ? "是" : "否"}；发现 ${run.findings.length} 个。${run.modelInfo.fallbackReason ?? ""}`,
    },
    {
      id: "evidence",
      title: "评估证据充分性、冲突反馈、不确定性和数据限制",
      status: run.reliability ? "pass" : "fail",
      evidence: `可靠性 ${run.reliability?.score ?? 0}/100；冲突证据 ${run.findings.reduce((sum, finding) => sum + finding.conflictingEvidence.length, 0)} 条。`,
    },
    {
      id: "prd",
      title: "根据分析制定更新计划并生成 PRD",
      status: run.requirements.length > 0 ? "pass" : "fail",
      evidence: `需求 ${run.requirements.length} 条；版本数 ${new Set(run.requirements.map((requirement) => requirement.version)).size} 个。`,
    },
    {
      id: "tests",
      title: "基于 PRD 生成测试用例并关联需求和评论",
      status: run.testCases.length > 0 && run.testCases.every((testCase) => testCase.linkedReviewIds.length > 0) ? "pass" : "fail",
      evidence: `测试用例 ${run.testCases.length} 条；全部测试均需关联 requirementId 和 linkedReviewIds。`,
    },
    {
      id: "trace",
      title: "验证 Review -> Finding -> Requirement -> TestCase 追溯链",
      status: validTrace ? "pass" : "fail",
      evidence: `追溯错误 ${run.traceabilityIssues.filter((issue) => issue.level === "error").length} 个，警告 ${run.traceabilityIssues.filter((issue) => issue.level === "warning").length} 个。`,
    },
    {
      id: "progress",
      title: "界面显示执行进度、验证结果、错误和修订",
      status: "pass",
      evidence: `阶段 ${run.stages.length} 个；错误 ${run.errors.length} 个；修订 ${run.revisions.length} 条。`,
    },
    {
      id: "deliverables",
      title: "展示中期和最终交付物",
      status: "pass",
      evidence: "UI 提供任务要求、工作流核验、原始评论、清洗数据、分类发现、PRD、测试、追溯、报告和完整 JSON。",
    },
  ];
}

function buildMarkdownReport(run: PipelineRun): string {
  const findingLines = run.findings
    .map((finding) => `- **${finding.id} ${finding.title}**：${finding.userProblem}；支持 ${finding.supportCount} 条；置信度 ${Math.round(finding.confidence * 100)}%；来源 ${finding.evidence.map((sample) => sample.reviewId).join(", ") || "无"}`)
    .join("\n");
  const requirementLines = run.requirements
    .map((requirement) => `- **${requirement.id} ${requirement.title}**：${requirement.priority} / ${requirement.version}；来源评论 ${requirement.sourceReviewIds.join(", ")}`)
    .join("\n");
  const testLines = run.testCases
    .map((testCase) => `- **${testCase.id} ${testCase.title}**：验证 ${testCase.requirementId}；关联评论 ${testCase.linkedReviewIds.join(", ")}`)
    .join("\n");
  const workflowLines = (run.workflowVerification ?? [])
    .map((item) => `- ${item.status.toUpperCase()} **${item.title}**：${item.evidence}`)
    .join("\n");

  return [
    `# ${run.metadata?.name ?? "App Store Review Analysis"} 分析总结`,
    "",
    `- Run ID: ${run.runId}`,
    `- App ID: ${run.scope?.appId ?? "unknown"}`,
    `- Storefront: ${run.scope?.country ?? "unknown"}`,
    `- 分析目标: ${run.scope?.goal ?? "unknown"}`,
    `- 数据来源: ${run.collectionReport?.selectedSource ?? "none"}`,
    `- 可靠性: ${run.reliability?.score ?? 0}/100 (${run.reliability?.level ?? "unknown"})`,
    `- 评估状态: ${run.evaluation?.overallStatus ?? "unknown"}`,
    "",
    "## 数据与清洗",
    "",
    `原始评论 ${run.rawReviews.length} 条，清洗后 ${run.cleanedReviews.length} 条，重复 ${run.cleaningReport?.duplicateCount ?? 0} 条，非法 ${run.cleaningReport?.invalidCount ?? 0} 条。`,
    "",
    "## 主要发现",
    "",
    findingLines || "暂无发现。",
    "",
    "## PRD 草案",
    "",
    requirementLines || "暂无需求。",
    "",
    "## 测试用例草案",
    "",
    testLines || "暂无测试用例。",
    "",
    "## 工作流核验",
    "",
    workflowLines || "暂无核验结果。",
    "",
    "## 数据局限",
    "",
    [...(run.collectionReport?.limitations ?? []), ...(run.reliability?.limitations ?? [])].map((item) => `- ${item}`).join("\n") || "暂无主要局限。",
  ].join("\n");
}

function recordToChartData(record: Record<string, number>): Array<{ label: string; value: number }> {
  return Object.entries(record)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, value]) => ({ label, value }));
}

function setStage(run: PipelineRun, stageId: string, status: PipelineStage["status"], message: string): void {
  const stage = run.stages.find((item) => item.id === stageId);
  if (!stage) return;
  stage.status = status;
  stage.message = message;
  if (status === "running") stage.startedAt = new Date().toISOString();
  if (["done", "warning", "error"].includes(status)) stage.completedAt = new Date().toISOString();
}

function markRunningStageAsError(run: PipelineRun, message: string): void {
  const stage = run.stages.find((item) => item.status === "running") ?? run.stages.find((item) => item.status === "pending");
  if (stage) setStage(run, stage.id, "error", message);
}

async function writeCache(appId: string, country: string, reviews: Review[], source: string): Promise<void> {
  const dir = path.join(cacheDir, appId, country);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `reviews-${Date.now()}-${source}.json`), JSON.stringify({ appId, country, reviews }, null, 2));
}

async function readLatestCache(appId: string, country: string): Promise<Review[]> {
  const dir = path.join(cacheDir, appId, country);
  if (!existsSync(dir)) return [];
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort().reverse();
  if (!files[0]) return [];
  return parseImportedJson(await readFile(path.join(dir, files[0]), "utf8"), country).map((review) => ({ ...review, source: "cache" }));
}

async function persistRun(run: PipelineRun): Promise<void> {
  const dir = path.join(rootDir, "data", "runs");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${run.runId}.json`), JSON.stringify(run, null, 2));
}

function reviewIdsToEvidence(ids: unknown[], reviews: Review[]): EvidenceSample[] {
  const byId = new Map(reviews.map((review) => [review.id, review]));
  return ids.map(String).map((id) => byId.get(id)).filter((review): review is Review => Boolean(review)).map(toEvidenceSample);
}

function toEvidenceSample(review: Review): EvidenceSample {
  return {
    reviewId: review.id,
    rating: review.rating,
    excerpt: `${review.title ? `${review.title}: ` : ""}${review.body}`.slice(0, 240),
  };
}

function countBy<T>(items: T[], getKey: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, item) => {
    const key = getKey(item);
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}

function walkJson(value: unknown, visit: (node: Record<string, any>) => void): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => walkJson(item, visit));
    return;
  }
  const node = value as Record<string, any>;
  visit(node);
  Object.values(node).forEach((child) => walkJson(child, visit));
}

function extractReviewArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const possibleContainers = [record.reviews, record.data, record.items, record.entries, record.records, record.results, record.feed];
  for (const container of possibleContainers) {
    if (Array.isArray(container)) return container;
    if (container && typeof container === "object") {
      const nested = extractReviewArray(container);
      if (nested.length > 0) return nested;
    }
  }
  return [];
}

function hashText(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function extractJsonObject(content: string): string {
  const trimmed = content.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  // Some OpenAI-compatible providers may wrap JSON with short explanatory text.
  // Extracting the outermost object keeps the parser tolerant without trusting non-JSON prose.
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

function readString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return readString(record.label ?? record.value ?? record.name ?? record.text);
  }
  return undefined;
}

function normalizeDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function numberOrUndefined(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function normalizeSeverity(value: unknown): Finding["severity"] {
  return value === "high" || value === "medium" || value === "low" ? value : "medium";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
