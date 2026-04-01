import { Router } from "express";
import { getAvailableZones, getDnsRecords, createDnsRecord, updateDnsRecord, deleteDnsRecord } from "../services/cloudflare";
import { CONFIG } from "../utils/config";

const router = Router();

router.get("/zones", async (req, res) => {
  if (!CONFIG.CF_API_TOKEN) {
    return res.status(400).json({ error: "未在 .env 中配置 Cloudflare API Token" });
  }
  
  try {
    const data = await getAvailableZones();
    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: "获取可用 Zones 列表失败", details: error.message });
  }
});

router.get("/records", async (req, res) => {
  if (!CONFIG.CF_API_TOKEN) {
    return res.status(400).json({ error: "未在 .env 中配置 Cloudflare API Token" });
  }
  const domain = req.query.domain as string;
  if (!domain) return res.status(400).json({ error: "必须提供 domain 参数" });

  try {
    const records = await getDnsRecords(domain);
    res.json(records);
  } catch (error: any) {
    res.status(500).json({ error: "获取 DNS 记录失败", details: error.response?.data || error.message });
  }
});

router.post("/records", async (req, res) => {
  if (!CONFIG.CF_API_TOKEN) {
    return res.status(400).json({ error: "未在 .env 中配置 Cloudflare API Token" });
  }
  const domain = req.query.domain as string;
  if (!domain) return res.status(400).json({ error: "必须提供 domain 参数" });

  try {
    const result = await createDnsRecord(domain, req.body);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: "添加 DNS 记录失败", details: error.response?.data || error.message });
  }
});

router.put("/records/:id", async (req, res) => {
  if (!CONFIG.CF_API_TOKEN) {
    return res.status(400).json({ error: "未在 .env 中配置 Cloudflare API Token" });
  }
  const domain = req.query.domain as string;
  if (!domain) return res.status(400).json({ error: "必须提供 domain 参数" });

  try {
    const result = await updateDnsRecord(domain, req.params.id, req.body);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: "更新 DNS 记录失败", details: error.response?.data || error.message });
  }
});

router.delete("/records/:id", async (req, res) => {
  const domain = req.query.domain as string;
  try {
    const result = await deleteDnsRecord(domain, req.params.id);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: "删除 DNS 记录失败", details: error.response?.data || error.message });
  }
});

export default router;
