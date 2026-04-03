import { Router } from "express";
import { getContainers, containerAction, getContainerLogs } from "../services/docker";
import { getLocalEnvironmentId } from "../services/platform";

const router = Router();

router.get("/containers", async (req, res) => {
  const environmentId = String(req.query.environmentId || req.query.serverId || getLocalEnvironmentId());
  try {
    const containers = await getContainers(environmentId);
    res.json(containers);
  } catch (error: any) {
    res.status(500).json({ error: "获取容器列表失败", details: error.message });
  }
});

router.post("/container/:id/:action", async (req, res) => {
  const { id, action } = req.params;
  const environmentId = String(req.query.environmentId || req.query.serverId || req.body?.environmentId || req.body?.serverId || getLocalEnvironmentId());
  try {
    await containerAction(environmentId, id, action, (req as any).user?.username || "admin");
    res.json({ success: true, message: `容器 ${id} ${action} 成功` });
  } catch (error: any) {
    res.status(500).json({ error: `容器操作失败`, details: error.message });
  }
});

router.get("/container/:id/logs", async (req, res) => {
  const { id } = req.params;
  const environmentId = String(req.query.environmentId || req.query.serverId || getLocalEnvironmentId());
  const structured = String(req.query.structured || req.query.timestamps || "false") === "true";
  try {
    const logs = await getContainerLogs(environmentId, id, structured);
    if (structured) {
      res.json(logs);
      return;
    }
    res.send(logs);
  } catch (error: any) {
    res.status(500).json({ error: "获取日志失败", details: error.message });
  }
});

export default router;
