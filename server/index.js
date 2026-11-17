// GatorGraph server: serves the static UI and the /api routes (architecture.md §9). Plain Node (D-011).
const path = require("path");
const express = require("express");
const D = require("./data.js");
const { aiPlan } = require("./aiPlan.js");
const { evaluate } = require("./evaluate.js");
const runs = require("./runs.js");
const gemini = require("./gemini.js");

// /api/plan and /api/evaluate call the AI provider with the server's API key, so anyone who
// can reach the server can spend it. Cap AI calls per client IP (in memory, per process).
// AI_RATE_LIMIT_PER_HOUR=0 turns the cap off. Behind a proxy, set TRUST_PROXY=1 so req.ip
// is the real client address.
function aiRateLimit(perHour) {
  const hits = new Map();
  return (req, res, next) => {
    if (!perHour) return next();
    const now = Date.now();
    const recent = (hits.get(req.ip) || []).filter(t => now - t < 3600e3);
    if (recent.length >= perHour) {
      return res.status(429).json({ error: "Too many requests. Try again later.", code: "RATE_LIMITED" });
    }
    recent.push(now);
    hits.set(req.ip, recent);
    if (hits.size > 10000) hits.clear();
    next();
  };
}

function createApp(deps = {}) {
  const app = express();
  if (process.env.TRUST_PROXY) app.set("trust proxy", 1);
  const limitAi = aiRateLimit(deps.aiRateLimitPerHour ?? Number(process.env.AI_RATE_LIMIT_PER_HOUR ?? 30));
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(path.join(D.ROOT, "web")));

  app.get("/api/health", (req, res) => res.json({ ok: true, provider: gemini.provider(), model: gemini.modelName() }));
  app.get("/api/catalog", (req, res) => {
    if (req.query.programId) {
      if (!D.programs[req.query.programId]) return res.status(404).json({ error: "Unknown program", code: "UNKNOWN_PROGRAM" });
      const ids = new Set(D.programCourseIds(req.query.programId));
      return res.json(D.catalog.filter(c => ids.has(c.id)));
    }
    res.json(D.catalog);
  });
  app.get("/api/programs", (req, res) => res.json(Object.values(D.programs).map(p => ({ id: p.id, name: p.name }))));
  app.get("/api/programs/:id", (req, res) => D.programs[req.params.id] ? res.json(D.programs[req.params.id])
    : res.status(404).json({ error: "Unknown program", code: "UNKNOWN_PROGRAM" }));
  app.get("/api/policies", (req, res) => res.json(D.policies));
  app.get("/api/career-directions", (req, res) => res.json(D.careerTags.directions));
  app.get("/api/runs", (req, res) => res.json(runs.listRuns()));
  app.get("/api/runs/:id", (req, res) => {
    const r = runs.getRun(req.params.id);
    return r ? res.json(r) : res.status(404).json({ error: "Run not found", code: "RUN_NOT_FOUND" });
  });

  app.post("/api/plan", limitAi, async (req, res, next) => {
    try {
      const out = await aiPlan(req.body, deps);
      const scores = runs.scorePlan(out.plan, out.report, Planner().directionScores(out.plan, D.catalog, D.careerTags), out.attempts);
      const run = runs.saveRun({ variant: "plan", input: req.body,
        config: { provider: gemini.provider(), model: gemini.modelName(), maxRepairs: 2 },
        steps: out.steps, final_state: { plan: out.plan, source: out.source, rationale: out.rationale }, scores });
      res.json(Object.assign({}, out, { runId: run.run_id, aiProvider: gemini.provider() }));
    } catch (e) { next(e); }
  });
  app.post("/api/evaluate", limitAi, async (req, res, next) => {
    try {
      const out = await evaluate(req.body, deps);
      const scores = runs.scorePlan(req.body.plan, out.report, out.directionScores, null);
      const run = runs.saveRun({ variant: "evaluate", input: req.body,
        config: { provider: gemini.provider(), model: gemini.modelName() },
        steps: out.steps, final_state: { report: out.report, ai: out.ai, aiStatus: out.aiStatus }, scores });
      res.json(Object.assign({}, out, { runId: run.run_id, aiProvider: gemini.provider() }));
    } catch (e) { next(e); }
  });

  app.use((err, req, res, next) => {  // eslint-disable-line no-unused-vars
    const status = err.status || 500;
    res.status(status).json({ error: status === 500 ? "Something went wrong on the server." : err.message, code: err.code || "SERVER_ERROR" });
    if (status === 500) console.error(err);
  });
  return app;
}

function Planner() { return require("../web/planner.js"); }

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => console.log(`GatorGraph on http://localhost:${port} (model provider: ${gemini.provider()})`));
}

module.exports = { createApp };
