import "dotenv/config";
import cors from "cors";
import express from "express";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { runAnalysis } from "./pipeline";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");

const analyzeSchema = z.object({
  appUrl: z.string().url(),
  goal: z.string().default("发现主要用户问题并形成版本计划"),
  importData: z.string().optional(),
  importFormat: z.enum(["json", "csv"]).optional(),
  useSampleOnFailure: z.boolean().default(true),
});

const app = express();
const port = Number(process.env.PORT ?? 8787);

app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    modelConfigured: Boolean(process.env.LLM_API_KEY),
    model: process.env.LLM_MODEL ?? "未配置",
  });
});

app.get("/api/sample", async (_req, res) => {
  const sample = await readFile(path.join(rootDir, "data", "samples", "workout-for-women-us.sample.json"), "utf8");
  res.type("json").send(sample);
});

app.post("/api/analyze", async (req, res) => {
  const parsed = analyzeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const run = await runAnalysis(parsed.data);
  res.json(run);
});

if (existsSync(distDir)) {
  app.use(express.static(distDir));
}

app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>LaienTech Review Analyzer</title>
    <style>
      body { font-family: system-ui, "Segoe UI", sans-serif; margin: 0; background: #f5f7fb; color: #1d2738; }
      main { max-width: 760px; margin: 10vh auto; padding: 32px; background: #fff; border-radius: 24px; box-shadow: 0 18px 50px rgba(15, 23, 42, 0.08); }
      a { color: #335cff; font-weight: 700; }
      code { background: #eef2ff; border-radius: 6px; padding: 2px 6px; }
    </style>
  </head>
  <body>
    <main>
      <h1>LaienTech Review Analyzer API 已运行</h1>
      <p>当前后端地址是 <code>http://localhost:${port}</code>。</p>
      <p>开发模式请打开前端地址：<a href="http://localhost:5173">http://localhost:5173</a>。</p>
      <p>如果希望直接从 <code>8787</code> 访问完整界面，请先运行 <code>npm run build</code>，后端会自动托管 <code>dist</code> 中的前端产物。</p>
      <p>健康检查：<a href="/api/health">/api/health</a></p>
    </main>
  </body>
</html>`);
});

app.listen(port, () => {
  console.log(`Review analyzer API listening on http://localhost:${port}`);
});
