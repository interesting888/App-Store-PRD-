import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { analyzeReviews, loadSampleReviews } from "./api";
import type { PipelineRun, Review } from "../shared/types";
import "./style.css";

const defaultUrl = "https://apps.apple.com/us/app/workout-for-women-home-gym/id839285684";
const defaultGoal = "关注订阅转化率、锻炼体验、低评分评论和最近版本中的主要用户问题。";

type TabKey = "overview" | "reviews" | "cleaned" | "findings" | "prd" | "tests" | "trace" | "json";

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

  const summary = useMemo(() => {
    if (!run) return undefined;
    return [
      { label: "原始评论", value: run.rawReviews.length },
      { label: "清洗后", value: run.cleanedReviews.length },
      { label: "发现", value: run.findings.length },
      { label: "需求", value: run.requirements.length },
      { label: "测试用例", value: run.testCases.length },
    ];
  }, [run]);

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">LaienTech iOS 应用审查分析和版本规划评估</p>
          <h1>App Store 评论到 PRD 与测试计划的端到端工具</h1>
          <p className="lead">
            输入美国 App Store 链接和分析目标，系统会完成采集、清洗、动态语义分析、版本规划、PRD、测试用例和追溯校验。
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
            美国 App Store 链接
            <input value={appUrl} onChange={(event) => setAppUrl(event.target.value)} />
          </label>

          <label>
            分析目标或限制条件
            <textarea value={goal} onChange={(event) => setGoal(event.target.value)} rows={5} />
          </label>

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
              placeholder="支持 { reviews: [...] }、[...] 或带表头 CSV。字段可用 id/rating/title/body/version/date/author。"
              rows={8}
            />
          </label>

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
          这个工具把作业拆成一条可审计的数据流水线：先用确定性规则拿到可信数据，再把开放式语义判断交给
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

function JsonBlock({ data }: { data: unknown }) {
  return <pre className="json-block">{JSON.stringify(data, null, 2)}</pre>;
}
