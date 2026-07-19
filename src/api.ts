import type { AnalyzeRequest, PipelineRun } from "../shared/types";

export async function analyzeReviews(payload: AnalyzeRequest): Promise<PipelineRun> {
  const response = await fetch("/api/analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(error || `分析请求失败：${response.status}`);
  }
  return (await response.json()) as PipelineRun;
}

export async function loadSampleReviews(): Promise<string> {
  const response = await fetch("/api/sample");
  if (!response.ok) throw new Error("示例数据读取失败");
  return response.text();
}
