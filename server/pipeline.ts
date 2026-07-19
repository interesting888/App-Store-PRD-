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
  CleaningReport,
  EvidenceSample,
  Finding,
  PipelineRun,
  PipelineStage,
  Requirement,
  Review,
  TestCase,
  TraceabilityIssue,
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
};

export async function runAnalysis(request: AnalyzeRequest): Promise<PipelineRun> {
  const appId = parseAppId(request.appUrl);
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
    },
  };

  try {
    setStage(run, "scope", "running", "正在解析 App Store 链接和用户目标");
    const [metadata, scope] = await Promise.all([
      lookupMetadata(appId, request.appUrl),
      determineScope(appId, request.goal),
    ]);
    run.metadata = metadata;
    run.scope = scope;
    setStage(run, "scope", "done", `锁定美国商店评论，目标提示 ${scope.focusHints.length} 个`);

    setStage(run, "collect", "running", "正在收集、导入或读取缓存评论");
    run.rawReviews = await collectReviews(appId, request);
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

    await persistRun(run);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    run.errors.push(message);
    markRunningStageAsError(run, message);
  }

  return run;
}

function parseAppId(appUrl: string): string {
  const match = appUrl.match(/id(\d+)/);
  if (!match) {
    throw new Error("请输入包含 id 数字的有效 App Store 链接，例如 https://apps.apple.com/us/app/name/id839285684");
  }
  return match[1];
}

async function lookupMetadata(appId: string, fallbackUrl: string): Promise<AppMetadata> {
  try {
    const response = await fetch(`https://itunes.apple.com/lookup?id=${appId}&country=us`);
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

function determineScope(appId: string, goal: string): AnalysisScope {
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
    country: "us",
    goal: normalizedGoal,
    ratingFilter,
    versionFilter: versionMatch?.[1],
    focusHints,
    notes: ["评论范围固定为美国 App Store；规则过滤只影响样本范围，语义主题由模型动态发现。"],
  };
}

async function collectReviews(appId: string, request: AnalyzeRequest): Promise<Review[]> {
  if (request.importData) {
    return request.importFormat === "csv" ? parseImportedCsv(request.importData) : parseImportedJson(request.importData);
  }

  const liveReviews = await collectFromRss(appId);
  if (liveReviews.length > 0) {
    await writeCache(appId, liveReviews, "live-rss");
    return liveReviews;
  }

  const webReviews = await collectFromAppStorePage(appId, request.appUrl);
  if (webReviews.length > 0) {
    await writeCache(appId, webReviews, "live-web");
    return webReviews;
  }

  const cached = await readLatestCache(appId);
  if (cached.length > 0) return cached;

  if (request.useSampleOnFailure && existsSync(samplePath)) {
    return parseImportedJson(await readFile(samplePath, "utf8")).map((review) => ({ ...review, source: "sample" }));
  }

  return [];
}

async function collectFromRss(appId: string): Promise<Review[]> {
  const reviews: Review[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const url = `https://itunes.apple.com/us/rss/customerreviews/page=${page}/id=${appId}/sortby=mostrecent/json`;
    try {
      const response = await fetch(url, { headers: { "user-agent": "LaienTechReviewAnalyzer/1.0" } });
      if (!response.ok) break;
      const payload = (await response.json()) as { feed?: { entry?: unknown[] } };
      const entries = payload.feed?.entry ?? [];
      const pageReviews = entries.map(normalizeRssEntry).filter((review): review is Review => Boolean(review));
      reviews.push(...pageReviews);
      if (pageReviews.length === 0) break;
      await sleep(350);
    } catch {
      break;
    }
  }
  return reviews;
}

function normalizeRssEntry(entry: unknown): Review | undefined {
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
    country: "us",
    source: "live-rss",
  };
}

async function collectFromAppStorePage(appId: string, appUrl: string): Promise<Review[]> {
  try {
    const url = appUrl.includes("/us/") ? appUrl : `https://apps.apple.com/us/app/_/id${appId}`;
    const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 LaienTechReviewAnalyzer/1.0" } });
    if (!response.ok) return [];
    const html = await response.text();
    const $ = cheerio.load(html);
    const raw = $("#serialized-server-data").text();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const found: Review[] = [];
    walkJson(parsed, (node) => {
      const review = normalizeWebReview(node, found.length);
      if (review) found.push(review);
    });
    return found.map((review) => ({ ...review, source: "live-web" }));
  } catch {
    return [];
  }
}

function normalizeWebReview(node: Record<string, any>, index: number): Review | undefined {
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
    country: "us",
    source: "live-web",
  };
}

function parseImportedJson(raw: string): Review[] {
  const payload = JSON.parse(raw) as unknown;
  const items = Array.isArray(payload) ? payload : (payload as { reviews?: unknown[] }).reviews ?? [];
  return items.map((item, index) => normalizeImportedReview(item, index)).filter((review): review is Review => Boolean(review));
}

function parseImportedCsv(raw: string): Review[] {
  const rows = parseCsv(raw, { columns: true, skip_empty_lines: true }) as Array<Record<string, unknown>>;
  return rows.map((row, index) => normalizeImportedReview(row, index)).filter((review): review is Review => Boolean(review));
}

function normalizeImportedReview(item: unknown, index: number): Review | undefined {
  if (!item || typeof item !== "object") return undefined;
  const row = item as Record<string, any>;
  const body = row.body ?? row.content ?? row.review ?? row.text;
  const rating = Number(row.rating ?? row.score);
  if (!body || !Number.isFinite(rating)) return undefined;
  return {
    id: String(row.id ?? row.review_id ?? `import-${index}-${hashText(String(body))}`),
    rating,
    title: String(row.title ?? ""),
    body: String(body),
    version: row.version ? String(row.version) : undefined,
    date: row.date ? new Date(row.date).toISOString() : undefined,
    author: row.author ? String(row.author) : undefined,
    country: "us",
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
  const baseUrl = process.env.LLM_BASE_URL ?? "https://api.openai.com/v1/chat/completions";
  const response = await fetch(baseUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.LLM_MODEL ?? "gpt-4o-mini",
      temperature: Number(process.env.LLM_TEMPERATURE ?? 0.2),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`模型接口返回 ${response.status}`);
  }
  const payload = (await response.json()) as any;
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("模型未返回内容");
  return JSON.parse(stripJsonFence(content));
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

async function writeCache(appId: string, reviews: Review[], source: string): Promise<void> {
  const dir = path.join(cacheDir, appId, "us");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `reviews-${Date.now()}-${source}.json`), JSON.stringify({ appId, country: "us", reviews }, null, 2));
}

async function readLatestCache(appId: string): Promise<Review[]> {
  const dir = path.join(cacheDir, appId, "us");
  if (!existsSync(dir)) return [];
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort().reverse();
  if (!files[0]) return [];
  return parseImportedJson(await readFile(path.join(dir, files[0]), "utf8")).map((review) => ({ ...review, source: "cache" }));
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

function hashText(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function stripJsonFence(content: string): string {
  return content.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "").trim();
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
