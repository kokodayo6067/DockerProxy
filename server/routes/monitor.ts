import { Router } from "express";
import { getMonitorSnapshot } from "../services/monitor";
import { getLocalEnvironmentId } from "../services/platform";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const environmentId = String(req.query.environmentId || req.query.serverId || getLocalEnvironmentId());
    const snapshot = await getMonitorSnapshot(environmentId);
    res.json(snapshot);
  } catch (error) {
    console.error("Monitor API Error:", error);
    res.status(500).json({ error: "Failed to fetch system information" });
  }
});

export default router;
