import axios from "axios";
import { CONFIG } from "../utils/config";

export function getCfClient() {
  if (!CONFIG.CF_API_TOKEN) throw new Error("Cloudflare API Token 未配置");
  return axios.create({
    baseURL: "https://api.cloudflare.com/client/v4",
    headers: {
      "Authorization": `Bearer ${CONFIG.CF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
  });
}

let cachedZones: { id: string, name: string }[] | null = null;
export let isFallbackMode = false;

export async function getAvailableZones(): Promise<{ zones: {id: string, name: string}[], isFallbackMode: boolean }> {
  // 如果已经获取过，直接使用缓存，避免频繁请求 `/zones`
  if (cachedZones !== null) {
    return { zones: cachedZones, isFallbackMode };
  }

  const cf = getCfClient();
  let fetchedZones: {id: string, name: string}[] = [];
  
  try {
    const res = await cf.get("/zones");
    if (res.data.success) {
      fetchedZones = res.data.result.map((z: any) => ({ id: z.id, name: z.name }));
      isFallbackMode = false;
    }
  } catch (error: any) {
    console.warn("⚠️ [DNS Warning] 警告：因为 Cloudflare Token 限制或缺少 Zone.Read 权限，无法通过 API 动态获取您的域名授权列表。");
    console.warn("将退回默认使用 .env 中配置的 CF_ZONE_ID 作为兜底 (Fallback Mode) 进行盲配操作。如果您的 ALLOWED_DOMAINS 有多个，部分域名操作可能错乱或发生 403 / 404！");
    isFallbackMode = true;
  }

  const allowed = CONFIG.ALLOWED_DOMAINS || [];
  
  if (isFallbackMode) {
    // 降级模式：如果有配置 ALLOWED_DOMAINS，只能默认它们全用这一个 CF_ZONE_ID
    if (allowed.length > 0 && CONFIG.CF_ZONE_ID) {
      fetchedZones = allowed.map((domain: string) => ({ id: CONFIG.CF_ZONE_ID, name: domain }));
    } else if (CONFIG.CF_ZONE_ID) {
      fetchedZones = [{ id: CONFIG.CF_ZONE_ID, name: "默认兜底域名" }];
    } else {
      fetchedZones = [];
    }
  } else {
    // 正常模式：如果有白名单拦截，仅放出交集
    if (allowed.length > 0) {
      fetchedZones = fetchedZones.filter((z) => allowed.includes(z.name));
    }
  }

  cachedZones = fetchedZones;
  return { zones: cachedZones, isFallbackMode };
}

export async function getZoneId(domain: string): Promise<string> {
  const { zones, isFallbackMode } = await getAvailableZones();
  
  // 查找精准匹配
  const exactMatch = zones.find(z => domain === z.name || domain.endsWith(`.${z.name}`));
  if (exactMatch) {
    return exactMatch.id;
  }

  // 兜底保护
  if (isFallbackMode && CONFIG.CF_ZONE_ID) {
    console.warn(`⚠️ [DNS Warning] 域名 ${domain} 不在白名单下拉清单中，因为无查询权限强行使用默认 CF_ZONE_ID 盲配，大概率会遇到错误。`);
    return CONFIG.CF_ZONE_ID;
  }
  
  throw new Error(`无法找到域名 ${domain} 对应的安全 Zone ID。该域名未授权，或被 ALLOWED_DOMAINS 拦截限制。`);
}

export async function getDnsRecords(domain: string) {
  const cf = getCfClient();
  const zoneId = await getZoneId(domain);
  const res = await cf.get(`/zones/${zoneId}/dns_records`);
  return res.data.result;
}

export async function createDnsRecord(domain: string, payload: any) {
  const cf = getCfClient();
  const zoneId = await getZoneId(domain);
  const res = await cf.post(`/zones/${zoneId}/dns_records`, payload);
  return res.data.result;
}

export async function updateDnsRecord(domain: string, id: string, payload: any) {
  const cf = getCfClient();
  const zoneId = await getZoneId(domain);
  const res = await cf.put(`/zones/${zoneId}/dns_records/${id}`, payload);
  return res.data.result;
}

export async function deleteDnsRecord(domain: string, id: string) {
  const cf = getCfClient();
  const zoneId = await getZoneId(domain);
  const res = await cf.delete(`/zones/${zoneId}/dns_records/${id}`);
  return res.data.result;
}
