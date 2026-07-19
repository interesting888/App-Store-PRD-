import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { analyzeReviews, loadSampleReviews } from "./api";
import type { PipelineRun, Review } from "../shared/types";
import "./style.css";

const defaultUrl = "https://apps.apple.com/us/app/workout-for-women-home-gym/id839285684";
const defaultGoal = "关注订阅转化率、锻炼体验、低评分评论和最近版本中的主要用户问题。";
const goalPresets = ["低评分评论", "订阅转化率", "锻炼体验", "最近版本问题", "冲突反馈", "测试用例覆盖"];

type TabKey =
  | "overview"
  | "requirements"
  | "workflow"
  | "report"
  | "evaluation"
  | "reliability"
  | "reviews"
  | "cleaned"
  | "findings"
  | "prd"
  | "tests"
  | "trace"
  | "json";

export default function App() {
  const [appUrl, setAppUrl] = useState(defaultUrl);
  const [goal, setGoal] = useState(defaultGoal);
  const [importData, setImportData] = useState("");
  const [importFormat, setImportFormat] = useState<"json" | "csv">("json");
  const [useSampleOnFailure, setUseSampleOnFailure] = useState(true);
  const [activeTab, setActiveTab] = useState<TabKey>("overview");
  const [run, setRun] = useState<PipelineRun | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    setRun(undefined);
    try {
      const result = await analyzeReviews({
        appUrl,
        goal,
        importData: importData.trim() || undefined,
        importFormat: importData.trim() ? importFormat : undefined,
        useSampleOnFailure,
      });
      setRun(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleLoadSample() {
    setImportFormat("json");
    setImportData(await loadSampleReviews());
  }

  async function handleFileImport(file: File | undefined) {
    if (!file) return;
    const text = await file.text();
    setImportData(text);
    setImportFormat(file.name.toLowerCase().endsWith(".csv") ? "csv" : "json");
  }

  const summary = useMemo(() => {
    if (!run) return undefined;
    return [
      { label: "原始评论", value: run.rawReviews.length },
      { label: "清洗后", value: run.cleanedReviews.length },
      { label: "发现", value: run.findings.length },
      { label: "需求", value: run.requirements.length },
      { label: "测试用例", value: run.testCases.length },
      { label: "可靠性", value: run.reliability?.score ?? 0 },
    ];
  }, [run]);

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Vibe Coding Product Intelligence</p>
          <h1>App Store 评论到 PRD 与测试计划的端到端工具</h1>
          <p className="lead">
            输入 App Store 链接和分析目标，系统会自动识别国家/地区，也支持导入评论数据完成清洗、动态语义分析、PRD、测试用例和追溯校验。
          </p>
        </div>
        <div className="model-card">
          <span>运行时 AI</span>
          <strong>{run?.modelInfo.usedRuntimeModel ? "已使用模型" : "等待配置或运行"}</strong>
          <small>{run?.modelInfo.fallbackReason ?? "通过 .env 配置 LLM_API_KEY 后启用模型驱动主题发现。"}</small>
        </div>
      </section>

      <section className="workspace">
        <form className="input-panel" onSubmit={handleSubmit}>
          <label>
            App Store 链接（自动识别国家/地区）
            <input value={appUrl} onChange={(event) => setAppUrl(event.target.value)} />
          </label>

          <label>
            分析目标或限制条件
            <textarea value={goal} onChange={(event) => setGoal(event.target.value)} rows={5} />
          </label>
          <div className="preset-row" aria-label="分析目标快捷选项">
            {goalPresets.map((preset) => (
              <button
                key={preset}
                type="button"
                className="chip"
                onClick={() => setGoal((current) => (current.includes(preset) ? current : `${current} ${preset}`.trim()))}
              >
                {preset}
              </button>
            ))}
          </div>

          <div className="inline-fields">
            <label>
              导入格式
              <select value={importFormat} onChange={(event) => setImportFormat(event.target.value as "json" | "csv")}>
                <option value="json">JSON</option>
                <option value="csv">CSV</option>
              </select>
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={useSampleOnFailure}
                onChange={(event) => setUseSampleOnFailure(event.target.checked)}
              />
              采集失败时使用离线样例
            </label>
          </div>

          <label>
            可选：粘贴 JSON/CSV 评论数据
            <textarea
              className="import-box"
              value={importData}
              onChange={(event) => setImportData(event.target.value)}
              placeholder="支持 { reviews: [...] }、[...]、Apple RSS 风格 JSON、嵌套 data/items/records，或带表头 CSV。字段可用 id/rating/title/body/version/date/author，也兼容 reviewId/content/text/score 等别名。"
              rows={8}
            />
          </label>
          <div className="import-actions">
            <label className="file-button">
              上传 JSON/CSV
              <input type="file" accept=".json,.csv,application/json,text/csv" onChange={(event) => handleFileImport(event.target.files?.[0])} />
            </label>
            <button type="button" className="secondary" onClick={() => setImportData("")} disabled={!importData}>
              清空导入
            </button>
          </div>
          <p className="helper-text">
            当前导入内容约 {importData.length.toLocaleString()} 字符；为空时系统会按链接国家/地区尝试在线采集、缓存或离线样例。
          </p>

          <section className="compat-card">
            <strong>通用兼容性</strong>
            <p>可输入不同国家/地区的 App Store 链接，也可导入未见过的 JSON/CSV 数据集；系统不会依赖特定应用硬编码分类。</p>
            <p>若数据不足、采集失败或模型失败，结果会在“可靠性”和“评估核对”中透明标记。</p>
          </section>

          <div className="button-row">
            <button type="submit" disabled={loading}>
              {loading ? "分析中..." : "开始分析"}
            </button>
            <button type="button" className="secondary" onClick={handleLoadSample}>
              加载离线样例
            </button>
          </div>
          {error && <p className="error-text">{error}</p>}
        </form>

        <section className="result-panel">
          {loading && <LoadingState />}
          {!loading && !run && <EmptyState />}
          {run && (
            <>
              <RunHeader run={run} summary={summary ?? []} />
              <StageTimeline run={run} />
              <Tabs activeTab={activeTab} onChange={setActiveTab} />
              <TabContent run={run} activeTab={activeTab} />
            </>
          )}
        </section>
      </section>
    </main>
  );
}

function LoadingState() {
  return (
    <div className="empty-state">
      <div className="spinner" />
      <h2>正在执行分析流水线</h2>
      <p>在线采集和模型调用可能需要几十秒。失败时系统会展示错误、缓存或规则降级原因。</p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="empty-state">
      <h2>等待开始</h2>
      <p>建议先用默认链接运行；无外网或无模型密钥时，可点击“加载离线样例”验证完整界面和追溯链。</p>
    </div>
  );
}

function RunHeader({ run, summary }: { run: PipelineRun; summary: Array<{ label: string; value: number }> }) {
  return (
    <section className="run-header">
      <div>
        <p className="eyebrow">Run {run.runId.slice(0, 8)}</p>
        <h2>{run.metadata?.name ?? "App Review Analysis"}</h2>
        <p>{run.scope?.goal}</p>
      </div>
      <div className="summary-grid">
        {summary.map((item) => (
          <div key={item.label}>
            <strong>{item.value}</strong>
            <span>{item.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function StageTimeline({ run }: { run: PipelineRun }) {
  return (
    <section className="timeline">
      {run.stages.map((stage) => (
        <article key={stage.id} className={`stage ${stage.status}`}>
          <span>{stage.label}</span>
          <strong>{stage.status}</strong>
          <p>{stage.message}</p>
        </article>
      ))}
    </section>
  );
}

function Tabs({ activeTab, onChange }: { activeTab: TabKey; onChange: (tab: TabKey) => void }) {
  const tabs: Array<[TabKey, string]> = [
    ["overview", "方案说明"],
    ["requirements", "任务要求"],
    ["workflow", "工作流核验"],
    ["report", "报告总结"],
    ["evaluation", "评估核对"],
    ["reliability", "可靠性"],
    ["reviews", "原始评论"],
    ["cleaned", "清洗数据"],
    ["findings", "分类发现"],
    ["prd", "PRD"],
    ["tests", "测试用例"],
    ["trace", "追溯验证"],
    ["json", "完整 JSON"],
  ];
  return (
    <nav className="tabs">
      {tabs.map(([key, label]) => (
        <button key={key} className={activeTab === key ? "active" : ""} onClick={() => onChange(key)}>
          {label}
        </button>
      ))}
    </nav>
  );
}

function TabContent({ run, activeTab }: { run: PipelineRun; activeTab: TabKey }) {
  if (activeTab === "overview") return <DesignOverview run={run} />;
  if (activeTab === "requirements") return <TaskRequirementsPanel />;
  if (activeTab === "workflow") return <WorkflowPanel run={run} />;
  if (activeTab === "report") return <ReportPanel run={run} />;
  if (activeTab === "evaluation") return <EvaluationPanel run={run} />;
  if (activeTab === "reliability") return <ReliabilityPanel run={run} />;
  if (activeTab === "reviews") return <ReviewTable reviews={run.rawReviews} />;
  if (activeTab === "cleaned") {
    return (
      <div className="stack">
        <JsonBlock data={run.cleaningReport} />
        <ReviewTable reviews={run.cleanedReviews} />
      </div>
    );
  }
  if (activeTab === "findings") {
    return (
      <div className="card-grid">
        {run.findings.map((finding) => (
          <article className="artifact-card" key={finding.id}>
            <p className="eyebrow">{finding.id} · {finding.severity} · 置信度 {Math.round(finding.confidence * 100)}%</p>
            <h3>{finding.title}</h3>
            <p>{finding.userProblem}</p>
            <strong>支持样本：{finding.supportCount}</strong>
            <EvidenceList title="证据摘录" evidence={finding.evidence} />
            <EvidenceList title="冲突证据" evidence={finding.conflictingEvidence} />
            <small>{finding.uncertainty}</small>
          </article>
        ))}
      </div>
    );
  }
  if (activeTab === "prd") {
    return (
      <div className="card-grid">
        {run.requirements.map((requirement) => (
          <article className="artifact-card" key={requirement.id}>
            <p className="eyebrow">{requirement.id} · {requirement.version} · {requirement.priority}</p>
            <h3>{requirement.title}</h3>
            <p>{requirement.problem}</p>
            <p>{requirement.requirement}</p>
            <List title="验收标准" items={requirement.acceptanceCriteria} />
            <List title="不在范围" items={requirement.outOfScope} />
            <small>来源评论：{requirement.sourceReviewIds.join(", ")}</small>
          </article>
        ))}
      </div>
    );
  }
  if (activeTab === "tests") {
    return (
      <div className="card-grid">
        {run.testCases.map((testCase) => (
          <article className="artifact-card" key={testCase.id}>
            <p className="eyebrow">{testCase.id} · 需求 {testCase.requirementId}</p>
            <h3>{testCase.title}</h3>
            <List title="前置条件" items={testCase.preconditions} />
            <List title="步骤" items={testCase.steps} />
            <p><strong>期望：</strong>{testCase.expectedResult}</p>
            <small>关联评论：{testCase.linkedReviewIds.join(", ")}</small>
          </article>
        ))}
      </div>
    );
  }
  if (activeTab === "trace") {
    return (
      <div className="stack">
        <section className="artifact-card">
          <h3>验证结果</h3>
          {run.traceabilityIssues.length === 0 ? (
            <p>所有正式发现、需求和测试用例均可追溯到来源评论。</p>
          ) : (
            run.traceabilityIssues.map((issue) => (
              <p key={`${issue.objectId}-${issue.message}`} className={issue.level === "error" ? "error-text" : "warning-text"}>
                {issue.level.toUpperCase()} · {issue.objectId} · {issue.message}
              </p>
            ))
          )}
        </section>
        <section className="artifact-card">
          <h3>自动修订记录</h3>
          {run.revisions.length ? run.revisions.map((item) => <p key={item}>{item}</p>) : <p>本次没有自动修订。</p>}
        </section>
      </div>
    );
  }
  return <JsonBlock data={run} />;
}

function DesignOverview({ run }: { run: PipelineRun }) {
  return (
    <div className="stack">
      <section className="artifact-card">
        <p className="eyebrow">Design Rationale</p>
        <h3>设计思路</h3>
        <p>
          这个工具把评论分析拆成一条可审计的数据流水线：先用确定性规则拿到可信数据，再把开放式语义判断交给
          DeepSeek，最后用规则校验每条发现、需求和测试用例是否能追溯到真实评论。这样既能泛化到未见过的
          App 和数据集，也能避免模型凭空生成产品结论。
        </p>
        <List
          title="核心原则"
          items={[
            "不硬编码特定 App 的分类、结论、需求或测试用例。",
            "采集、清洗、去重、统计和追溯校验使用确定性规则，保证可复现。",
            "动态主题发现使用运行时模型，满足开放域语义分析要求。",
            "所有正式结论必须保留 review_id、摘录、样本量、置信度和不确定性。",
          ]}
        />
      </section>

      <section className="artifact-card">
        <p className="eyebrow">Vibe Coding Flow</p>
        <h3>AI 协作式产品分析闭环</h3>
        <p>
          系统把 vibe coding 落到可运行流程中：用户用自然语言描述目标，应用自动完成数据收集、清理、语义分析、
          需求摘要、版本规划、测试设计和追溯核验，并把每一步转化为可查看、可下载、可复核的互动体验。
        </p>
        <List
          title="闭环步骤"
          items={[
            "收集数据：从 App Store 链接、RSS、结构化网页、缓存、样例或导入文件中获得评论。",
            "清理和分析评价：统一字段、去重、统计评分，并用模型发现动态主题和冲突反馈。",
            "摘要产品需求：把用户问题转化为带证据的发现、PRD 需求和验收标准。",
            "规划版本：按优先级和影响范围拆分 Now / Next / Later 更新计划。",
            "设计测试用例：每条测试绑定需求和来源评论，验证改动是否真正解决反馈。",
            "产品化互动：在标签页、进度流、报告下载和完整 JSON 中展示过程与结果。",
          ]}
        />
      </section>

      {run.reliability && (
        <section className={`artifact-card reliability-card ${run.reliability.level}`}>
          <p className="eyebrow">Reliability</p>
          <h3>结果可靠性：{run.reliability.score}/100</h3>
          <p>
            系统会同时看样本量、模型是否成功运行、追溯链是否断裂、是否使用样例数据以及是否处理了导入数据，
            用于判断结果能否可靠泛化到未见过的数据集。
          </p>
        </section>
      )}

      <section className="artifact-card">
        <p className="eyebrow">Implementation Flow</p>
        <h3>实现过程</h3>
        <div className="process-grid">
          {run.stages.map((stage, index) => (
            <article key={stage.id} className={`process-step ${stage.status}`}>
              <span>{index + 1}</span>
              <strong>{stage.label}</strong>
              <p>{stage.message}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="artifact-card">
        <p className="eyebrow">AI Usage</p>
        <h3>AI 的使用方式</h3>
        <p>
          当前运行模型为 <strong>{run.modelInfo.provider}</strong> / <strong>{run.modelInfo.model}</strong>。
          {run.modelInfo.usedRuntimeModel
            ? " 本次运行已调用模型完成动态主题发现。"
            : " 本次运行未完成模型调用，系统已透明降级为规则分析。"}
        </p>
        <List
          title="模型承担的任务"
          items={[
            "根据用户目标和评论内容发现动态主题，而不是依赖固定关键词映射。",
            "输出用户问题、严重度、置信度、支持评论和冲突评论。",
            "为 PRD 和测试用例提供语义基础，但不绕过证据校验。",
          ]}
        />
        <List
          title="防幻觉措施"
          items={[
            "提示词要求模型只返回 JSON，且每条发现必须引用输入中的 review_id。",
            "服务端会删除没有有效证据的模型发现。",
            "追溯验证会检查 Review -> Finding -> Requirement -> TestCase 是否断链。",
            "模型不可用时明确记录 fallbackReason，不伪造 AI 结论。",
          ]}
        />
        {run.modelInfo.fallbackReason && <p className="warning-text">{run.modelInfo.fallbackReason}</p>}
      </section>
    </div>
  );
}

function TaskRequirementsPanel() {
  const groups = [
    {
      title: "自动工作流",
      items: [
        "根据用户目标和可用数据确定分析范围。",
        "收集应用评价数据，并记录数据来源、失败原因和局限。",
        "清理、去重并结构化评价数据。",
        "动态分类和分析评价，不仅依赖固定关键词或预设分类。",
        "评估证据充分性、冲突反馈、不确定性和数据限制。",
      ],
    },
    {
      title: "产品化交付",
      items: [
        "根据分析制定更新计划并生成 PRD，必要时拆分多个版本。",
        "基于 PRD 生成测试用例，每个测试用例关联需求和来源用户评价。",
        "验证 Review -> Finding -> Requirement -> TestCase 追溯链。",
        "没有根据的结论必须删除、修正或明确标记为假设。",
      ],
    },
    {
      title: "界面与交付",
      items: [
        "显示执行进度、阶段结果、验证结果、错误和自动修订。",
        "展示原始评论、清洗数据、分类结果、发现、PRD 草案、测试用例草案和完整 JSON。",
        "支持不同 App Store 链接、未见过的数据集和新的分析目标。",
        "透明说明数据不足、采集受限、模型失败和样例数据使用情况。",
      ],
    },
    {
      title: "Vibe Coding 能力",
      items: [
        "用自然语言分析目标驱动完整流水线，而不是手工拼接静态页面。",
        "把 AI 协作产物转成可运行、可验证、可下载的产品功能。",
        "从评论证据自动沉淀需求、版本计划和测试用例，形成端到端交付闭环。",
        "在界面中保留中间过程和追溯结果，方便用户复核 AI 生成内容。",
      ],
    },
  ];

  return (
    <div className="stack">
      <section className="artifact-card">
        <p className="eyebrow">Product Requirements</p>
        <h3>能力要求映射</h3>
        <p>
          这里把产品能力要求直接映射到系统界面和运行结果。用户更换 App、数据集或分析目标时，仍会走同一条流水线，不依赖特定应用硬编码。
        </p>
      </section>
      <div className="requirement-grid">
        {groups.map((group) => (
          <section key={group.title} className="artifact-card requirement-group">
            <h3>{group.title}</h3>
            <ul>
              {group.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function WorkflowPanel({ run }: { run: PipelineRun }) {
  const checks = run.workflowVerification?.length ? run.workflowVerification : buildClientWorkflowChecks(run);
  return (
    <div className="stack">
      <section className="artifact-card">
        <p className="eyebrow">Workflow Verification</p>
        <h3>自动工作流核验</h3>
        <p>
          这里逐项确认“开始分析”后是否完成范围、采集、清洗、分析、证据评估、PRD、版本规划、测试、追溯、
          进度和交付物展示，确保 vibe coding 产物不是静态说明，而是可交互运行的工作流。
        </p>
      </section>
      <div className="workflow-list">
        {checks.map((check) => (
          <article key={check.id} className={`artifact-card workflow-item ${check.status}`}>
            <span>{check.status}</span>
            <h3>{check.title}</h3>
            <p>{check.evidence}</p>
          </article>
        ))}
      </div>
    </div>
  );
}

function ReportPanel({ run }: { run: PipelineRun }) {
  const report = run.reportMarkdown?.trim() ? run.reportMarkdown : buildClientMarkdownReport(run);

  function downloadReport() {
    const blob = new Blob([report], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `review-analysis-${run.runId.slice(0, 8)}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="stack">
      <section className="artifact-card report-actions">
        <div>
          <p className="eyebrow">Summary Report</p>
          <h3>分析文档总结</h3>
          <p>该报告由后端根据本次运行结果生成，可作为产品分析归档、团队验收或交付材料。</p>
        </div>
        <button type="button" onClick={downloadReport}>下载 Markdown</button>
      </section>
      <pre className="report-block">{report}</pre>
    </div>
  );
}

function ReliabilityPanel({ run }: { run: PipelineRun }) {
  if (!run.reliability) {
    return (
      <section className="artifact-card">
        <h3>暂无可靠性评估</h3>
        <p>请重新运行分析以生成可靠性评估。</p>
      </section>
    );
  }

  return (
    <div className="stack">
      <section className={`artifact-card reliability-card ${run.reliability.level}`}>
        <p className="eyebrow">Reliability Assessment</p>
        <h3>{run.reliability.score}/100 · {run.reliability.level}</h3>
        <div className="score-bar" aria-label={`可靠性评分 ${run.reliability.score}`}>
          <span style={{ width: `${run.reliability.score}%` }} />
        </div>
      </section>

      <section className="artifact-card">
        <h3>为什么可信</h3>
        {run.reliability.reasons.length ? <List title="支持因素" items={run.reliability.reasons} /> : <p>当前没有足够支持因素。</p>}
        {run.reliability.limitations.length ? <List title="数据局限" items={run.reliability.limitations} /> : <p>当前未发现主要数据局限。</p>}
      </section>

      {run.collectionReport && (
        <section className="artifact-card">
          <h3>数据来源诊断</h3>
          <p>最终来源：{run.collectionReport.selectedSource ?? "none"}</p>
          <div className="check-grid">
            {run.collectionReport.attempts.map((attempt, index) => (
              <article key={`${attempt.method}-${index}`} className={`check-card ${attempt.status === "success" ? "pass" : attempt.status === "failed" ? "fail" : "warning"}`}>
                <strong>{attempt.method}</strong>
                <span>{attempt.status}</span>
                <p>{attempt.detail}</p>
                <p>评论数：{attempt.count}</p>
              </article>
            ))}
          </div>
          {run.collectionReport.reproducibility.length > 0 && <List title="可复现说明" items={run.collectionReport.reproducibility} />}
          {run.collectionReport.limitations.length > 0 && <List title="采集局限" items={run.collectionReport.limitations} />}
        </section>
      )}

      <section className="artifact-card">
        <h3>泛化能力检查</h3>
        <div className="check-grid">
          {run.reliability.generalizationChecks.map((check) => (
            <article key={check.name} className={`check-card ${check.status}`}>
              <strong>{check.name}</strong>
              <span>{check.status}</span>
              <p>{check.detail}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function EvaluationPanel({ run }: { run: PipelineRun }) {
  if (!run.evaluation) {
    return (
      <section className="artifact-card">
        <h3>暂无评估核对报告</h3>
        <p>请重新运行分析以生成完整评估报告。</p>
      </section>
    );
  }

  const passed = run.evaluation.criteria.filter((criterion) => criterion.status === "pass").length;

  return (
    <div className="stack">
      <section className={`artifact-card evaluation-summary ${run.evaluation.overallStatus}`}>
        <p className="eyebrow">Evaluation Checklist</p>
        <h3>总体状态：{run.evaluation.overallStatus}</h3>
        <p>
          已通过 {passed}/{run.evaluation.criteria.length} 项质量核对标准。该报告用于确认数据、分析、AI、PRD、测试和 UI 交付是否完整。
        </p>
      </section>
      <div className="evaluation-list">
        {run.evaluation.criteria.map((criterion) => (
          <article key={criterion.id} className={`artifact-card evaluation-item ${criterion.status}`}>
            <div className="evaluation-title">
              <h3>{criterion.title}</h3>
              <span>{criterion.status}</span>
            </div>
            <p>{criterion.summary}</p>
            <List title="核对证据" items={criterion.evidence} />
            {criterion.improvement && <p className="warning-text">改进建议：{criterion.improvement}</p>}
          </article>
        ))}
      </div>
    </div>
  );
}

function ReviewTable({ reviews }: { reviews: Review[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>评分</th>
            <th>标题</th>
            <th>正文</th>
            <th>版本</th>
            <th>来源</th>
          </tr>
        </thead>
        <tbody>
          {reviews.slice(0, 80).map((review) => (
            <tr key={review.id}>
              <td>{review.id}</td>
              <td>{review.rating}</td>
              <td>{review.title}</td>
              <td>{review.body}</td>
              <td>{review.version ?? "-"}</td>
              <td>{review.source}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {reviews.length > 80 && <p className="muted">仅展示前 80 条，完整数据见 JSON。</p>}
    </div>
  );
}

function EvidenceList({ title, evidence }: { title: string; evidence: Array<{ reviewId: string; rating: number; excerpt: string }> }) {
  if (!evidence.length) return null;
  return (
    <div>
      <strong>{title}</strong>
      {evidence.map((item) => (
        <blockquote key={item.reviewId}>
          <span>{item.reviewId} · {item.rating} 星</span>
          {item.excerpt}
        </blockquote>
      ))}
    </div>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <strong>{title}</strong>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function buildClientWorkflowChecks(run: PipelineRun) {
  const traceErrors = run.traceabilityIssues.filter((issue) => issue.level === "error").length;
  return [
    {
      id: "scope",
      title: "根据用户目标和可用数据确定分析范围",
      status: run.scope ? "pass" : "fail",
      evidence: run.scope ? `目标：${run.scope.goal}；国家/地区：${run.scope.country}` : "当前返回结果缺少 scope。",
    },
    {
      id: "collect",
      title: "收集应用评价数据",
      status: run.rawReviews.length > 0 ? "pass" : "warning",
      evidence: `原始评论 ${run.rawReviews.length} 条；来源：${run.collectionReport?.selectedSource ?? "未标注"}`,
    },
    {
      id: "clean",
      title: "清理、去重并结构化评价数据",
      status: run.cleaningReport ? "pass" : "warning",
      evidence: `清洗后 ${run.cleanedReviews.length} 条；重复 ${run.cleaningReport?.duplicateCount ?? 0} 条；过滤 ${run.cleaningReport?.filteredCount ?? 0} 条。`,
    },
    {
      id: "analyze",
      title: "动态分类和分析评价",
      status: run.findings.length > 0 ? (run.modelInfo.usedRuntimeModel ? "pass" : "warning") : "fail",
      evidence: `发现 ${run.findings.length} 个；运行时模型：${run.modelInfo.usedRuntimeModel ? "已使用" : "未使用或降级"}。`,
    },
    {
      id: "evidence",
      title: "评估证据、冲突、不确定性和数据限制",
      status: run.reliability ? "pass" : "warning",
      evidence: `可靠性 ${run.reliability?.score ?? 0}/100；局限：${run.reliability?.limitations.join("；") || "未返回局限字段"}`,
    },
    {
      id: "prd",
      title: "生成 PRD 和版本规划",
      status: run.requirements.length > 0 ? "pass" : "fail",
      evidence: `需求 ${run.requirements.length} 条；版本 ${new Set(run.requirements.map((item) => item.version)).size} 个。`,
    },
    {
      id: "tests",
      title: "生成测试用例并关联需求和评论",
      status: run.testCases.length > 0 ? "pass" : "fail",
      evidence: `测试用例 ${run.testCases.length} 条；含评论关联 ${run.testCases.filter((item) => item.linkedReviewIds.length > 0).length} 条。`,
    },
    {
      id: "trace",
      title: "验证 Review -> Finding -> Requirement -> TestCase 追溯链",
      status: traceErrors === 0 ? "pass" : "fail",
      evidence: `追溯错误 ${traceErrors} 个，追溯警告 ${run.traceabilityIssues.filter((issue) => issue.level === "warning").length} 个。`,
    },
    {
      id: "progress",
      title: "显示执行进度、错误和修订",
      status: "pass",
      evidence: `阶段 ${run.stages.length} 个；错误 ${run.errors.length} 个；修订 ${run.revisions.length} 条。`,
    },
    {
      id: "deliverables",
      title: "展示中期和最终交付物",
      status: "pass",
      evidence: "界面包含原始评论、清洗数据、分类发现、PRD、测试用例、追溯、评估、可靠性、报告和完整 JSON。",
    },
  ] as const;
}

function buildClientMarkdownReport(run: PipelineRun): string {
  const findings = run.findings
    .map((finding) => `- **${finding.id} ${finding.title}**：${finding.userProblem}；支持 ${finding.supportCount} 条；来源 ${finding.evidence.map((item) => item.reviewId).join(", ") || "无"}`)
    .join("\n");
  const requirements = run.requirements
    .map((requirement) => `- **${requirement.id} ${requirement.title}**：${requirement.priority} / ${requirement.version}；来源评论 ${requirement.sourceReviewIds.join(", ") || "无"}`)
    .join("\n");
  const tests = run.testCases
    .map((testCase) => `- **${testCase.id} ${testCase.title}**：验证 ${testCase.requirementId}；关联评论 ${testCase.linkedReviewIds.join(", ") || "无"}`)
    .join("\n");
  const workflow = buildClientWorkflowChecks(run)
    .map((item) => `- ${item.status.toUpperCase()} **${item.title}**：${item.evidence}`)
    .join("\n");

  return [
    `# ${run.metadata?.name ?? "App Store Review Analysis"} 分析总结`,
    "",
    `- Run ID: ${run.runId}`,
    `- App ID: ${run.scope?.appId ?? "unknown"}`,
    `- 国家/地区: ${run.scope?.country ?? "unknown"}`,
    `- 分析目标: ${run.scope?.goal ?? "unknown"}`,
    `- 数据来源: ${run.collectionReport?.selectedSource ?? "unknown"}`,
    `- 可靠性: ${run.reliability?.score ?? 0}/100 (${run.reliability?.level ?? "unknown"})`,
    `- 评估状态: ${run.evaluation?.overallStatus ?? "unknown"}`,
    "",
    "## Vibe Coding 闭环",
    "",
    "本次运行以用户自然语言目标驱动完整分析流程：收集 App Store 或导入评价数据，清理和结构化评论，用运行时模型发现动态主题，再把证据化发现转成 PRD、版本规划和测试用例。界面将阶段进度、中间产物、追溯验证、可靠性和 Markdown 报告整合为互动体验，方便用户复核 AI 协作结果。",
    "",
    "## 数据与清洗",
    "",
    `原始评论 ${run.rawReviews.length} 条，清洗后 ${run.cleanedReviews.length} 条，重复 ${run.cleaningReport?.duplicateCount ?? 0} 条，非法 ${run.cleaningReport?.invalidCount ?? 0} 条。`,
    "",
    "## 主要发现",
    "",
    findings || "暂无发现。",
    "",
    "## PRD 草案",
    "",
    requirements || "暂无需求。",
    "",
    "## 测试用例草案",
    "",
    tests || "暂无测试用例。",
    "",
    "## 工作流核验",
    "",
    workflow,
    "",
    "## 数据局限",
    "",
    [...(run.collectionReport?.limitations ?? []), ...(run.reliability?.limitations ?? [])].map((item) => `- ${item}`).join("\n") || "暂无主要局限。",
  ].join("\n");
}

function JsonBlock({ data }: { data: unknown }) {
  return <pre className="json-block">{JSON.stringify(data, null, 2)}</pre>;
}
