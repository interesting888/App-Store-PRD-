# 数据收集方法说明

## 输入

用户提供 App Store 链接，系统从 URL 中提取数字 App ID，并固定使用美国商店 `country=us`。即使用户粘贴中国区链接，评论分析仍以美国商店为目标。

## 元数据

应用名称、开发者、类别、评分等元数据来自 iTunes Lookup API：

```text
https://itunes.apple.com/lookup?id={appId}&country=us
```

Lookup API 不返回评论正文，只用于展示应用背景。

## 评论采集策略

### 1. Apple RSS 评论接口

系统优先尝试：

```text
https://itunes.apple.com/us/rss/customerreviews/page={page}/id={appId}/sortby=mostrecent/json
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

面试官可以提供未见过的数据集。导入数据走同一条清洗、分析、PRD、测试和追溯流程，不依赖特定 App 的硬编码类别。

## 不捏造数据策略

- 采集失败且无导入/缓存/样例时，返回空评论并展示警告
- 样例文件明确标注为 demo fixture
- 每条 Finding、Requirement、TestCase 都必须能链接到输入评论 ID
- 追溯校验失败会在 UI 中标红，而不是静默通过
