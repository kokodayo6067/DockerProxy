import { Router } from "express";
import { createEnvironment, getEnvironment, listEnvironments, verifyEnvironment } from "../services/platform";
import { appendJobEvent, createJob, updateJob } from "../services/jobs";
import { initGatewaysData } from "../services/gateways";

const router = Router();

router.get("/", (_req, res) => {
  try {
    res.json(listEnvironments());
  } catch (error: any) {
    res.status(500).json({ error: "获取环境列表失败", details: error.message });
  }
});

router.get("/:id", (req, res) => {
  try {
    res.json(getEnvironment(req.params.id));
  } catch (error: any) {
    res.status(404).json({ error: "获取环境详情失败", details: error.message });
  }
});

router.post("/", async (req, res) => {
  try {
    const environment = await createEnvironment(req.body, (req as any).user?.username || "admin");
    initGatewaysData();
    res.json(environment);
  } catch (error: any) {
    res.status(400).json({ error: "创建环境失败", details: error.message });
  }
});

router.post("/:id/verify", async (req, res) => {
  const jobId = createJob({
    kind: "server-verify",
    sourceEnvironmentId: req.params.id,
    status: "running",
    metadata: { serverId: req.params.id },
  });
  appendJobEvent(jobId, "info", "verify", `开始校验服务器 ${req.params.id}`);
  try {
    const environment = await verifyEnvironment(req.params.id, (req as any).user?.username || "admin");
    initGatewaysData();
    updateJob(jobId, "completed", { serverId: req.params.id, status: environment.status });
    appendJobEvent(jobId, "info", "verify", `服务器 ${req.params.id} 校验完成`);
    res.json(environment);
  } catch (error: any) {
    updateJob(jobId, "failed", { serverId: req.params.id, error: error.message });
    appendJobEvent(jobId, "error", "verify", `服务器 ${req.params.id} 校验失败：${error.message}`);
    res.status(400).json({ error: "环境校验失败", details: error.message });
  }
});

export default router;
