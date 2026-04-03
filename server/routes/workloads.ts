import { Router } from "express";
import { containerAction, getContainerLogs, getContainers } from "../services/docker";
import { getLocalEnvironmentId } from "../services/platform";

const router = Router();

function resolveServerId(value: unknown) {
  return String(value || getLocalEnvironmentId());
}

router.get("/containers", async (req, res) => {
  const serverId = resolveServerId(req.query.serverId || req.query.environmentId);
  try {
    res.json(await getContainers(serverId));
  } catch (error: any) {
    res.status(500).json({ error: "获取容器列表失败", details: error.message });
  }
});

router.post("/containers/:id/:action", async (req, res) => {
  const serverId = resolveServerId(req.query.serverId || req.body?.serverId || req.query.environmentId);
  try {
    await containerAction(serverId, req.params.id, req.params.action, (req as any).user?.username || "admin");
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: "容器操作失败", details: error.message });
  }
});

router.get("/containers/:id/logs", async (req, res) => {
  const serverId = resolveServerId(req.query.serverId || req.query.environmentId);
  const structured = String(req.query.structured || req.query.timestamps || "false") === "true";
  try {
    const logs = await getContainerLogs(serverId, req.params.id, structured);
    if (structured) {
      res.json(logs);
      return;
    }
    res.type("text/plain").send(logs);
  } catch (error: any) {
    res.status(500).json({ error: "获取容器日志失败", details: error.message });
  }
});

export default router;
