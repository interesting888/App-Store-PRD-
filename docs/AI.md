# AI 使用说明

## 运行时模型任务

本项目至少有一项核心语义任务由运行时模型完成：动态主题发现。

位置：`server/pipeline.ts` 的 `discoverFindingsWithModel()`。

输入：

- 用户分析目标
- 清洗后的评论样本
- 每条评论的 `id`, `rating`, `title`, `body`

输出：

- 主题标题
- 用户问题陈述
- 严重度
- 置信度
- 支持评论 ID
- 冲突评论 ID
- 不确定性说明

## 模型和提供商

默认使用 DeepSeek 的 OpenAI-compatible Chat Completions API：

```text
LLM_BASE_URL=https://api.deepseek.com/chat/completions
LLM_PROVIDER=deepseek
LLM_MODEL=deepseek-chat
LLM_TEMPERATURE=0.2
```

也可以替换为其他兼容接口的模型服务，例如 OpenAI 或 Ollama 的 OpenAI-compatible endpoint。

## 主要提示词约束

系统提示核心约束：

```text
You are a product analyst. Discover dynamic themes from app reviews.
Return strict JSON only. Every finding must cite real review ids from the input.
Do not invent facts. Mark uncertainty when evidence is limited or conflicting.
```

用户消息包含目标、评论样本和输出 JSON schema。模型必须返回 `findings` 数组。

## 防幻觉措施

1. **低温度**：默认 `temperature=0.2`，减少发散。
2. **结构化输出**：请求 JSON object，并解析为对象。
3. **证据 ID 白名单**：模型返回的每个 review id 都必须存在于输入评论中。
4. **无证据删除**：没有有效证据的 Finding 会被删除。
5. **追溯链验证**：Requirement 和 TestCase 必须继承真实评论 ID。
6. **结论类型标注**：`evidenceType` 区分 `mixed`、`deterministic_stat`、`hypothesis`。
7. **降级透明**：模型失败时使用规则分桶结果，并在 UI、JSON 和验证结果中标注“未使用运行时模型”。
8. **运行时校验**：评估核对会把未成功调用模型标为失败项，明确说明系统需要运行时模型参与语义分析。
9. **兼容重试**：如果兼容接口不接受 `response_format`，服务端会重试一次纯提示词 JSON 模式。
10. **超时保护**：模型请求默认 45 秒超时，避免界面长时间无响应。

## 故障处理

模型失败场景：

- 缺少 `LLM_API_KEY`
- API 超时或返回非 2xx
- 兼容接口不支持 `response_format`
- 模型未返回 JSON
- 模型返回无效 review id

处理方式：

- 不伪造模型结论
- 记录 `modelInfo.fallbackReason`
- 生成可审计的规则降级分析
- 可靠性和评估核对增加 warning/fail，提示正式评估需配置模型后重跑

## 为什么规则和模型混合

- 数据采集、清洗、去重、统计、追溯校验需要可复现和可审计，因此用确定性规则。
- 用户评论主题发现、问题整合和语义解释属于开放域任务，需要泛化到未见过的 App、语言和目标，因此由模型完成。
- PRD 和测试用例生成使用发现结果和固定模板结合，确保产品内容可执行，同时保持证据链不丢失。
