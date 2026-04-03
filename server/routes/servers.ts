import { Router } from "express";
import { getServerChannels, getServerMetrics, getServerSummary, getServerTasks, listServers } from "../services/servers";

const router = Router();

router.get("/", async (_req, res) => {
  try {
    const servers = await listServers();
    res.json(servers);
  } catch (error: any) {
    res.status(500).json({ error: "获取服务器列表失败", details: error.message });
  }
});

router.get("/:id/summary", async (req, res) => {
  try {
    res.json(await getServerSummary(req.params.id));
  } catch (error: any) {
    res.status(404).json({ error: "获取服务器摘要失败", details: error.message });
  }
});

router.get("/:id/metrics", async (req, res) => {
  try {
    res.json(await getServerMetrics(req.params.id));
  } catch (error: any) {
    res.status(400).json({ error: "获取服务器监控失败", details: error.message });
  }
});

router.get("/:id/channels", (req, res) => {
  try {
    res.json(getServerChannels(req.params.id));
  } catch (error: any) {
    res.status(400).json({ error: "获取管理通道失败", details: error.message });
  }
});

router.get("/:id/tasks", (req, res) => {
  try {
    res.json(getServerTasks(req.params.id));
  } catch (error: any) {
    res.status(400).json({ error: "获取服务器任务失败", details: error.message });
  }
});

export default router;
