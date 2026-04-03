import { Router } from "express";
import {
  createMigrationPlan,
  getMigrationArtifacts,
  getMigrationSession,
  listMigrationProjects,
  rollbackMigrationSession,
  startMigrationSession,
  subscribeMigrationEvents,
} from "../services/migration";

const router = Router();

router.get("/projects", async (_req, res) => {
  try {
    const environmentId = String(_req.query.environmentId || "local");
    const projects = await listMigrationProjects(environmentId);
    res.json(projects);
  } catch (error: any) {
    res.status(500).json({ error: "获取迁移项目列表失败", details: error.message });
  }
});

router.post("/plans", async (req, res) => {
  try {
    const session = await createMigrationPlan(req.body);
    res.json(session);
  } catch (error: any) {
    res.status(400).json({ error: "生成迁移计划失败", details: error.message });
  }
});

router.post("/jobs", async (req, res) => {
  try {
    const session = await createMigrationPlan(req.body);
    res.json(session);
  } catch (error: any) {
    res.status(400).json({ error: "创建迁移任务失败", details: error.message });
  }
});

router.get("/sessions/:id", (req, res) => {
  try {
    const session = getMigrationSession(req.params.id);
    res.json(session);
  } catch (error: any) {
    res.status(404).json({ error: "获取迁移会话失败", details: error.message });
  }
});

router.get("/sessions/:id/artifacts", (req, res) => {
  try {
    const artifacts = getMigrationArtifacts(req.params.id);
    res.json(artifacts);
  } catch (error: any) {
    res.status(404).json({ error: "获取迁移产物失败", details: error.message });
  }
});

router.post("/sessions/:id/start", async (req, res) => {
  try {
    const session = await startMigrationSession(req.params.id);
    res.json(session);
  } catch (error: any) {
    res.status(400).json({ error: "启动迁移失败", details: error.message });
  }
});

router.post("/sessions/:id/rollback", async (req, res) => {
  try {
    const session = await rollbackMigrationSession(req.params.id);
    res.json(session);
  } catch (error: any) {
    res.status(400).json({ error: "执行回滚失败", details: error.message });
  }
});

router.get("/sessions/:id/events", (req, res) => {
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  try {
    const unsubscribe = subscribeMigrationEvents(req.params.id, (event) => {
      res.write(`${JSON.stringify(event)}\n`);
    });

    const heartbeat = setInterval(() => {
      res.write(`${JSON.stringify({ type: "heartbeat", ts: new Date().toISOString() })}\n`);
    }, 15000);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  } catch (error: any) {
    res.status(404).json({ error: "订阅迁移事件失败", details: error.message });
  }
});

export default router;
