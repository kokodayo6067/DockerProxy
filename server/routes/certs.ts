import { Router } from "express";
import { appendJobEvent, createJob, updateJob } from "../services/jobs";
import { getGatewayCertificates, listGateways } from "../services/gateways";
import { getEnvironment, getLocalEnvironmentId } from "../services/platform";

const router = Router();

router.get("/", (req, res) => {
  try {
    const gatewayId = req.query.gatewayId ? String(req.query.gatewayId) : undefined;
    if (gatewayId) {
      res.json(getGatewayCertificates(gatewayId));
      return;
    }
    const serverId = req.query.serverId ? String(req.query.serverId) : undefined;
    const certs = listGateways(serverId).flatMap((gateway) => getGatewayCertificates(gateway.id));
    res.json(certs);
  } catch (error: any) {
    res.status(500).json({ error: "获取证书列表失败", details: error.message });
  }
});

router.post("/:domain/renew", async (req, res) => {
  const { domain } = req.params;
  const gatewayId = String(req.body?.gatewayId || req.query.gatewayId || "gateway:local");
  const serverId = String(req.body?.serverId || req.query.serverId || getLocalEnvironmentId());
  const actor = (req as any).user?.username || "admin";
  const jobId = createJob({
    kind: "certificate-renew",
    sourceEnvironmentId: serverId,
    status: "running",
    metadata: {
      gatewayId,
      domain,
      actor,
    },
  });

  appendJobEvent(jobId, "info", "renew", `已向 ${gatewayId} 提交 ${domain} 的证书续签请求`);
  updateJob(jobId, "completed", {
    gatewayId,
    domain,
    serverId,
  });

  res.json({
    success: true,
    jobId,
    message: `已向 ${getEnvironment(serverId).displayName} 的网关发送续签 ${domain} 的请求`,
  });
});

export default router;
