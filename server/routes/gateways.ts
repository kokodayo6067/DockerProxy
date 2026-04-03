import { Router } from "express";
import { getGatewayCertificates, listGateways } from "../services/gateways";

const router = Router();

router.get("/", (req, res) => {
  try {
    const serverId = req.query.serverId ? String(req.query.serverId) : undefined;
    res.json(listGateways(serverId));
  } catch (error: any) {
    res.status(500).json({ error: "获取网关列表失败", details: error.message });
  }
});

router.get("/:id/certificates", (req, res) => {
  try {
    res.json(getGatewayCertificates(req.params.id));
  } catch (error: any) {
    res.status(400).json({ error: "获取网关证书失败", details: error.message });
  }
});

export default router;
