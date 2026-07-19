# 数据收集方法说明

## 输入

用户提供 App Store 链接，系统从 URL 中提取数字 App ID，并从路径中识别国家/地区代码，例如 `/us/`、`/cn/`、`/jp/`。如果链接中没有国家/地区，默认使用 `us`。这让程序可以适配多数 App Store storefront。

## 元数据

应用名称、开发者、类别、评分等元数据来自 iTunes Lookup API：

```text
https://itunes.apple.com/lookup?id={appId}&country={country}
```

Lookup API 不返回评论正文，只用于展示应用背景。

## 评论采集策略

系统不会只读取页面可见内容。采集顺序是：用户导入优先，其次尝试 Apple RSS 评论接口，再降级到公开页面中的服务端结构化数据，最后才使用缓存或明确标注的离线样例。

### 1. Apple RSS 评论接口

系统优先尝试：

```text
https://itunes.apple.com/{country}/rss/customerreviews/page={page}/id={appId}/sortby=mostrecent/json
```

实现细节：

- 最多请求 10 页
- 单线程顺序请求
- 页间等待约 350ms，避免异常负载
- 只保留包含 rating 和正文的 entry
- 用 review id 去重

局限：

- 该公开接口在部分环境或时间点可能返回空结果
- 可用字段和页数不保证稳定
- 不是 App Store Connect 官方完整评论导出

### 2. App Store 页面结构化数据降级

如果 RSS 为空，系统尝试读取公开 App Store 页面里的服务端序列化数据，并递归寻找具有评论形态的对象。

这不是读取页面上用户肉眼可见的文本，而是解析页面中服务端返回的结构化数据。它仍然只是降级方案，因为该数据通常不是完整评论集。

局限：

- 样本通常较少，可能偏向“最有帮助”或页面展示子集
- Apple 页面结构可能变化
- 系统会保留 `source=live-web` 以区别来源

### 3. 本地缓存

在线采集成功后，系统写入：

```text
data/cache/{appId}/us/reviews-{timestamp}-{source}.json
```

缓存用于离线复查，不应被解释为最新完整数据。

### 4. JSON / CSV 导入

用户可以提供未见过的数据集。导入数据走同一条清洗、分析、PRD、测试和追溯流程，不依赖特定 App 的硬编码类别。

兼容性策略：

- JSON 可以是数组，也可以包在 `reviews`、`data`、`items`、`entries`、`records`、`results` 等字段下。
- 如果没有标准容器，系统会递归扫描对象，寻找具有评分和正文的评论形态数据。
- CSV 支持 BOM、自动 trim 和宽松列数。
- 评论正文兼容 `body`、`content`、`review`、`text`、`comment`、`description` 等字段。
- 评分兼容 `rating`、`score`、`stars`、`im:rating` 等字段。
- 标识符兼容 `id`、`review_id`、`reviewId`，缺失时使用文本 hash 生成稳定导入 ID。

导入数据不会跳过证据校验。后续 Finding、Requirement 和 TestCase 仍必须引用导入评论 ID。

## 不捏造数据策略

- 采集失败且无导入/缓存/样例时，返回空评论并展示警告
- 样例文件明确标注为 demo fixture
- 每条 Finding、Requirement、TestCase 都必须能链接到输入评论 ID
- 追溯校验失败会在 UI 中标红，而不是静默通过
- 可靠性评估会明确标出样本量不足、使用样例数据、模型降级和追溯警告

## 在线不可用时如何诊断

每次运行都会生成 `collectionReport`：

- `attempts`：记录 RSS、网页结构化数据、缓存、样例或导入的每次尝试。
- `selectedSource`：说明最终使用的数据来源。
- `limitations`：说明当前数据是否受限，例如 RSS 空结果、网页结构化数据样本有限、缓存不一定最新。
- `reproducibility`：说明如何复现该次数据来源。

这些信息会显示在 UI 的“可靠性”页中。若在线采集失败，系统不会伪造数据，而是要求导入数据、使用缓存或明确标注的样例。
