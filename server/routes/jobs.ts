import { Router } from "express";
import { listJobs } from "../services/jobs";

const router = Router();

router.get("/", (req, res) => {
  try {
    const serverId = req.query.serverId ? String(req.query.serverId) : undefined;
    res.json(listJobs(serverId));
  } catch (error: any) {
    res.status(500).json({ error: "获取任务列表失败", details: error.message });
  }
});

export default router;
