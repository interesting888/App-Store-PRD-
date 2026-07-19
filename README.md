# LaienTech iOS Review Analyzer

一个可本地运行和部署的端到端 Web 应用，用于把 App Store 用户评论转化为动态主题发现、产品问题、版本规划、PRD、测试用例和可追溯验证矩阵。

## 功能

- 输入有效的 App Store 链接并自动识别国家/地区，例如 `https://apps.apple.com/us/app/workout-for-women-home-gym/id839285684`
- 输入分析目标或限制条件，例如关注订阅转化、锻炼体验、指定版本或低评分评论
- 按链接国家/地区在线采集 App Store 评论，失败时尝试网页结构化数据、缓存或离线样例
- 支持粘贴或上传 JSON / CSV 评论数据，并兼容多种字段别名和嵌套结构
- 清洗、去重、字段规范化和统计
- 使用运行时 LLM 做动态主题发现，并用确定性校验阻止无证据结论
- 根据发现生成版本规划、PRD、测试用例
- 验证 `Review -> Finding -> Requirement -> TestCase` 追溯链
- 展示 vibe coding 闭环：用自然语言目标驱动数据收集、清洗分析、需求摘要、版本规划、测试设计和互动交付
- 生成可靠性评分、数据局限和泛化能力检查，帮助判断结果是否可用于未见过的数据集
- 生成“评估核对”报告，逐项对应质量标准并给出证据和改进建议
- 生成“工作流核验”结果，确认开始后每个必需阶段都已完成或透明标记失败
- 生成可下载的 Markdown 分析总结报告
- 在“任务要求”页集中展示系统能力要求和对应实现
- 在界面中展示阶段状态、中间产物、错误、修订和完整 JSON
- 在“方案说明”页展示设计思路、实现过程、AI 使用方式和防幻觉措施

## 设计与实现说明

建议部署或验收前先阅读：

- `docs/IMPLEMENTATION.md`：设计思路、实现过程、AI 使用方式、可追溯性和演示建议
- `docs/DATA_COLLECTION.md`：评论采集方法、数据来源和局限
- `docs/AI.md`：DeepSeek 配置、提示词约束、故障处理和防幻觉策略

应用运行后，结果区的“方案说明”标签页也会展示同样的设计逻辑，并结合当次运行状态说明每个阶段的执行结果。

## Vibe Coding 交付闭环

本项目把 vibe coding 能力落到可运行的产品流程中，而不是只停留在说明文档：

- 用户用自然语言输入分析目标，系统自动确定 App、国家/地区、数据来源和分析范围。
- 后端自动收集评论、清洗去重、结构化字段，并记录来源、失败原因和局限。
- 运行时模型负责动态主题发现，服务端再用追溯规则校验每条发现是否有真实评论证据。
- 产品需求、版本规划和测试用例由分析结果自动生成，每条需求和测试都关联来源评论。
- 前端把进度、原始数据、清洗数据、发现、PRD、测试、追溯、可靠性和报告下载做成互动体验。

## 本地运行

本项目包含前端和 Express 后端，GitHub 仓库本身不是在线托管服务。请在本地运行，或部署到支持 Node.js 后端的环境；单独打开 GitHub 页面或静态预览无法完成在线采集、模型调用和分析流水线。

```bash
npm install
npm run dev
```

打开 Vite 输出的本地地址，通常是 `http://localhost:5173`。

后端 API 默认运行在 `http://localhost:8787`，前端通过 Vite proxy 访问 `/api`。开发模式下如果直接打开 `http://localhost:8787/`，会看到后端运行说明和健康检查入口。

如果希望直接从后端端口访问完整界面，请先构建前端：

```bash
npm run build
npm start
```

构建后后端会托管 `dist`，此时可以打开 `http://localhost:8787/` 查看完整应用。

## 部署

部署环境需要支持 Node.js 20+，并能运行长驻的 Express 服务。推荐流程：

```bash
npm ci
npm run build
npm start
```

部署平台需要设置以下环境变量：

```bash
PORT=8787
LLM_BASE_URL=https://api.deepseek.com/chat/completions
LLM_PROVIDER=deepseek
LLM_MODEL=deepseek-chat
LLM_TEMPERATURE=0.2
LLM_TIMEOUT_MS=45000
LLM_API_KEY=<在部署平台中填写真实密钥>
```

仓库包含无密钥的 `.env` 和 `.env.example`，方便他人了解所需配置。真实 API Key 不应提交到 GitHub；本地可直接编辑 `.env`，线上应使用平台的环境变量或 Secret 管理能力。

## 模型配置

至少一项核心语义任务必须由模型驱动。本项目的核心模型任务是 `模型语义分析` 阶段的动态主题发现。

在 `.env` 中配置：

```bash
LLM_BASE_URL=https://api.deepseek.com/chat/completions
LLM_PROVIDER=deepseek
LLM_MODEL=deepseek-chat
LLM_TEMPERATURE=0.2
LLM_TIMEOUT_MS=45000
LLM_API_KEY=your_key_here
```

如果没有配置 `LLM_API_KEY`，应用仍可运行并展示规则降级结果，但 UI、可靠性评估和评估核对会明确标记“未使用运行时模型”。生产或验收环境应配置模型后重新运行，确保运行时语义分析真正参与。

## 数据来源和适用范围

程序会从 App Store URL 中自动识别国家/地区代码，例如 `/us/`、`/cn/`、`/jp/`。在线采集会按该国家/地区尝试 RSS 和结构化数据。若用户提供 JSON/CSV，导入数据会使用同一套清洗、模型分析、PRD、测试和追溯流程，因此不局限于某个特定 App。

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

JSON 支持直接数组、`reviews`、`data`、`items`、`entries`、`records`、`results` 等常见容器，也会递归寻找评论形态对象。

CSV 支持字段：`id`, `review_id`, `reviewId`, `rating`, `score`, `stars`, `title`, `body`, `content`, `review`, `text`, `comment`, `description`, `version`, `appVersion`, `date`, `updated`, `author`, `user`, `reviewer`。

界面支持：

- 粘贴 JSON / CSV
- 上传 `.json` / `.csv` 文件
- 使用分析目标快捷标签
- 查看可靠性评分和泛化能力检查
- 查看评估核对页，确认数据真实性、清洗分析、模型语义、证据区分、PRD、测试覆盖和本地交付说明是否达标
- 查看数据来源诊断，确认 RSS、网页结构化数据、缓存、样例或导入数据的每一步尝试、失败原因和局限
- 查看任务要求、工作流核验和 Markdown 报告总结

## 示例数据

`data/samples/workout-for-women-us.sample.json` 是离线演示夹具，用于在无外网或无模型密钥时验证界面和追溯链。它被清晰标注为 sample，不替代真实在线采集或用户提供的新数据集。

在线运行成功后，评论缓存会写入 `data/cache/{appId}/us/`，完整运行结果会写入 `data/runs/`。

## 重要限制

- App Store Connect API 只能访问自有 App 的完整评论；本项目不使用它访问第三方 App。
- 公开 RSS 评论接口在不同时间和地区可能返回空结果，应用会检测空结果并降级。
- 网页结构化数据通常只覆盖有限评论样本，UI 会通过样本量和来源字段体现局限。
- 模型输出必须引用输入中的真实 `review_id`，否则会被删除或降级，避免无根据结论进入 PRD。

## 提交历史

GitHub 项目应保留完整提交历史，用于展示从项目初始化、后端流水线、前端交互、文档完善到错误修复的迭代过程，也用于体现 vibe coding 辅助开发和人工验收修正的协作轨迹。不要压缩或重写已经发布的历史。

## 项目结构

```text
server/          Express API 与分析流水线
shared/          前后端共享类型
src/             React 前端
data/samples/    离线样例数据
docs/            数据采集和 AI 策略说明
```
