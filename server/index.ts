import "dotenv/config";
import cors from "cors";
import express from "express";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { runAnalysis } from "./pipeline";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

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

app.listen(port, () => {
  console.log(`Review analyzer API listening on http://localhost:${port}`);
});
