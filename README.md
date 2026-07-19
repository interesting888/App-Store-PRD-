# LaienTech iOS Review Analyzer

一个可本地运行的端到端 Web 应用，用于把美国 App Store 用户评论转化为动态主题发现、产品问题、版本规划、PRD、测试用例和可追溯验证矩阵。

## 功能

- 输入有效的美国 App Store 链接，例如 `https://apps.apple.com/us/app/workout-for-women-home-gym/id839285684`
- 输入分析目标或限制条件，例如关注订阅转化、锻炼体验、指定版本或低评分评论
- 在线采集美国商店评论，失败时尝试网页结构化数据、缓存或离线样例
- 支持 JSON / CSV 评论数据导入
- 清洗、去重、字段规范化和统计
- 使用运行时 LLM 做动态主题发现，并用确定性校验阻止无证据结论
- 根据发现生成版本规划、PRD、测试用例
- 验证 `Review -> Finding -> Requirement -> TestCase` 追溯链
- 在界面中展示阶段状态、中间产物、错误、修订和完整 JSON
- 在“方案说明”页展示设计思路、实现过程、AI 使用方式和防幻觉措施

## 设计与实现说明

建议评审时先阅读：

- `docs/IMPLEMENTATION.md`：设计思路、实现过程、AI 使用方式、可追溯性和演示建议
- `docs/DATA_COLLECTION.md`：评论采集方法、数据来源和局限
- `docs/AI.md`：DeepSeek 配置、提示词约束、故障处理和防幻觉策略

应用运行后，结果区的“方案说明”标签页也会展示同样的设计逻辑，并结合当次运行状态说明每个阶段的执行结果。

## 本地运行

```bash
npm install
cp .env.example .env
npm run dev
```

打开 Vite 输出的本地地址，通常是 `http://localhost:5173`。

后端 API 默认运行在 `http://localhost:8787`，前端通过 Vite proxy 访问 `/api`。

## 模型配置

至少一项核心语义任务必须由模型驱动。本项目的核心模型任务是 `模型语义分析` 阶段的动态主题发现。

在 `.env` 中配置：

```bash
LLM_BASE_URL=https://api.deepseek.com/chat/completions
LLM_PROVIDER=deepseek
LLM_MODEL=deepseek-chat
LLM_TEMPERATURE=0.2
LLM_API_KEY=your_key_here
```

如果没有配置 `LLM_API_KEY`，应用仍可运行并展示规则降级结果，但 UI 和追溯验证会明确标记“未使用运行时模型”。正式评估请配置模型后重新运行。

## 数据导入格式

JSON 支持：

```json
{
  "appId": "839285684",
  "country": "us",
  "reviews": [
    {
      "id": "review-id",
      "rating": 1,
      "title": "title",
      "body": "review body",
      "version": "8.3.1",
      "date": "2026-05-18T12:20:00Z",
      "author": "user"
    }
  ]
}
```

CSV 支持字段：`id`, `review_id`, `rating`, `score`, `title`, `body`, `content`, `review`, `text`, `version`, `date`, `author`。

## 示例数据

`data/samples/workout-for-women-us.sample.json` 是离线演示夹具，用于在无外网或无模型密钥时验证界面和追溯链。它被清晰标注为 sample，不替代真实在线采集或面试官提供的新数据集。

在线运行成功后，评论缓存会写入 `data/cache/{appId}/us/`，完整运行结果会写入 `data/runs/`。

## 重要限制

- App Store Connect API 只能访问自有 App 的完整评论；本项目不使用它访问第三方 App。
- 公开 RSS 评论接口在不同时间和地区可能返回空结果，应用会检测空结果并降级。
- 网页结构化数据通常只覆盖有限评论样本，UI 会通过样本量和来源字段体现局限。
- 模型输出必须引用输入中的真实 `review_id`，否则会被删除或降级，避免无根据结论进入 PRD。

## 项目结构

```text
server/          Express API 与分析流水线
shared/          前后端共享类型
src/             React 前端
data/samples/    离线样例数据
docs/            数据采集和 AI 策略说明
```
