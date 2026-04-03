import crypto from "crypto";
import axios from "axios";
import { getDb } from "../db";
import { CONFIG } from "../utils/config";
import { decryptSecret, encryptSecret, hasMasterKey } from "./security";

type IntegrationRow = {
  id: string;
  kind: string;
  provider: string;
  display_name: string;
  status: string;
  metadata_json: string;
  last_verified_at: string | null;
  created_at: string;
  updated_at: string;
};

type SecretRow = {
  integration_id: string;
  ciphertext: string;
  iv: string;
  auth_tag: string;
  key_version: number;
  created_at: string;
  updated_at: string;
};

type CreateProviderConnectionInput = {
  provider: "cloudflare" | "gcore";
  displayName: string;
  apiToken?: string;
  apiKey?: string;
};

type NormalizedRecord = {
  id: string;
  provider: string;
  name: string;
  fqdn: string;
  type: string;
  content: string;
  ttl: number;
  proxied?: boolean;
  editable: boolean;
  readOnlyReason?: string;
  meta?: Record<string, unknown>;
};

function nowIso() {
  return new Date().toISOString();
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function getIntegrationRows() {
  const db = getDb();
  return db
    .prepare("SELECT * FROM integrations WHERE kind = 'dns-provider' ORDER BY created_at ASC")
    .all() as IntegrationRow[];
}

function getIntegrationRow(connectionId: string) {
  const db = getDb();
  return db.prepare("SELECT * FROM integrations WHERE id = ?").get(connectionId) as IntegrationRow | undefined;
}

function getSecretRow(connectionId: string) {
  const db = getDb();
  return db.prepare("SELECT * FROM integration_secrets WHERE integration_id = ?").get(connectionId) as SecretRow | undefined;
}

function serializeConnection(row: IntegrationRow) {
  const metadata = parseJson<Record<string, unknown>>(row.metadata_json, {});
  return {
    id: row.id,
    kind: row.kind,
    provider: row.provider,
    displayName: row.display_name,
    status: row.status,
    lastVerifiedAt: row.last_verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    managedBy: metadata.managedBy || "database",
    capabilities: {
      supportsProxyStatus: row.provider === "cloudflare",
      recordTypes: row.provider === "cloudflare" ? ["A", "AAAA", "CNAME", "TXT"] : ["A", "AAAA", "CNAME", "TXT"],
    },
  };
}

function getLegacyCloudflareConnection() {
  if (!CONFIG.CF_API_TOKEN) return null;
  return {
    id: "legacy-cloudflare-env",
    kind: "dns-provider",
    provider: "cloudflare",
    displayName: "Cloudflare（.env 旧配置）",
    status: "ready",
    lastVerifiedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    managedBy: "env",
    capabilities: {
      supportsProxyStatus: true,
      recordTypes: ["A", "AAAA", "CNAME", "TXT"],
    },
  };
}

function getCloudflareClient(token: string) {
  return axios.create({
    baseURL: "https://api.cloudflare.com/client/v4",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
}

function getGcoreClient(apiKey: string) {
  return axios.create({
    baseURL: "https://api.gcore.com/dns",
    headers: {
      Authorization: `APIKey ${apiKey}`,
      "Content-Type": "application/json",
    },
  });
}

function normalizeZoneName(zoneName: string, fqdn: string) {
  if (fqdn === zoneName) return "@";
  return fqdn.endsWith(`.${zoneName}`) ? fqdn.slice(0, -1 * (`.${zoneName}`.length)) : fqdn;
}

function toContentString(content: unknown) {
  if (Array.isArray(content)) {
    return content.map((item) => String(item)).join(" ");
  }
  if (content == null) return "";
  return String(content);
}

async function resolveCloudflareZoneId(token: string, zoneName: string) {
  const client = getCloudflareClient(token);
  const response = await client.get("/zones", { params: { name: zoneName } });
  const zone = response.data?.result?.[0];
  if (!zone?.id) {
    throw new Error(`Cloudflare 未找到 Zone：${zoneName}`);
  }
  return zone.id as string;
}

async function cloudflareListZones(token: string) {
  const client = getCloudflareClient(token);
  const response = await client.get("/zones");
  return (response.data?.result || []).map((zone: any) => ({
    id: zone.id,
    name: zone.name,
    status: zone.status,
    provider: "cloudflare",
  }));
}

async function cloudflareListRecords(token: string, zoneName: string): Promise<NormalizedRecord[]> {
  const client = getCloudflareClient(token);
  const zoneId = await resolveCloudflareZoneId(token, zoneName);
  const response = await client.get(`/zones/${zoneId}/dns_records`);
  return (response.data?.result || []).map((record: any) => ({
    id: record.id,
    provider: "cloudflare",
    name: normalizeZoneName(zoneName, record.name),
    fqdn: record.name,
    type: record.type,
    content: record.content,
    ttl: record.ttl,
    proxied: record.proxied,
    editable: true,
    meta: {
      providerId: record.id,
    },
  }));
}

async function cloudflareCreateRecord(token: string, zoneName: string, payload: Record<string, unknown>) {
  const client = getCloudflareClient(token);
  const zoneId = await resolveCloudflareZoneId(token, zoneName);
  const response = await client.post(`/zones/${zoneId}/dns_records`, payload);
  return response.data?.result;
}

async function cloudflareUpdateRecord(token: string, zoneName: string, recordId: string, payload: Record<string, unknown>) {
  const client = getCloudflareClient(token);
  const zoneId = await resolveCloudflareZoneId(token, zoneName);
  const response = await client.put(`/zones/${zoneId}/dns_records/${recordId}`, payload);
  return response.data?.result;
}

async function cloudflareDeleteRecord(token: string, zoneName: string, recordId: string) {
  const client = getCloudflareClient(token);
  const zoneId = await resolveCloudflareZoneId(token, zoneName);
  const response = await client.delete(`/zones/${zoneId}/dns_records/${recordId}`);
  return response.data?.result;
}

async function gcoreListZones(apiKey: string) {
  const client = getGcoreClient(apiKey);
  const response = await client.get("/v2/zones");
  return (response.data?.zones || []).map((zone: any) => ({
    id: String(zone.id || zone.name),
    name: zone.name,
    status: zone.status || (zone.enabled ? "active" : "disabled"),
    provider: "gcore",
    rrsetsAmount: zone.rrsets_amount || null,
  }));
}

async function gcoreListRecords(apiKey: string, zoneName: string): Promise<NormalizedRecord[]> {
  const client = getGcoreClient(apiKey);
  const response = await client.get(`/v2/zones/${encodeURIComponent(zoneName)}/rrsets`);
  return (response.data?.rrsets || []).map((rrset: any) => {
    const resourceRecords = Array.isArray(rrset.resource_records) ? rrset.resource_records : [];
    const simpleRecord = resourceRecords.length === 1 && !rrset.pickers?.length && !(rrset.warnings || []).length;
    const primaryRecord = resourceRecords[0];
    const readOnlyReason = simpleRecord
      ? undefined
      : rrset.pickers?.length
        ? "动态 RRset 当前只读展示"
        : resourceRecords.length > 1
          ? "多值 RRset 当前只读展示"
          : (rrset.warnings || []).map((item: any) => item.message).filter(Boolean).join("；") || rrset.warning || "当前 RRset 只读";

    return {
      id: `${rrset.name}::${rrset.type}`,
      provider: "gcore",
      name: normalizeZoneName(zoneName, rrset.name),
      fqdn: rrset.name,
      type: rrset.type,
      content: toContentString(primaryRecord?.content),
      ttl: rrset.ttl || 0,
      editable: Boolean(simpleRecord),
      readOnlyReason,
      meta: {
        providerId: `${rrset.name}::${rrset.type}`,
        warnings: rrset.warnings || [],
      },
    };
  });
}

async function gcoreCreateOrUpdateRecord(
  apiKey: string,
  zoneName: string,
  recordName: string,
  payload: Record<string, unknown>,
  method: "post" | "put"
) {
  const client = getGcoreClient(apiKey);
  const rrsetName = payload.name === "@" ? zoneName : String(payload.fqdn || payload.name || "").trim() || zoneName;
  const rrsetType = String(payload.type || "A");
  const body = {
    ttl: Number(payload.ttl || 300),
    resource_records: [
      {
        content: [String(payload.content || "")],
        enabled: true,
      },
    ],
  };
  const response = await client.request({
    url: `/v2/zones/${encodeURIComponent(zoneName)}/${encodeURIComponent(rrsetName)}/${encodeURIComponent(rrsetType)}`,
    method,
    data: body,
  });
  return response.data;
}

async function gcoreDeleteRecord(apiKey: string, zoneName: string, recordId: string) {
  const client = getGcoreClient(apiKey);
  const [rrsetName, rrsetType] = recordId.split("::");
  if (!rrsetName || !rrsetType) {
    throw new Error("Gcore 记录标识不合法");
  }
  const response = await client.delete(
    `/v2/zones/${encodeURIComponent(zoneName)}/${encodeURIComponent(rrsetName)}/${encodeURIComponent(rrsetType)}`
  );
  return response.data;
}

function buildPayload(input: any, zoneName: string, provider: string) {
  const name = String(input.name || "@").trim() || "@";
  const fqdn = name === "@" ? zoneName : name.endsWith(`.${zoneName}`) ? name : `${name}.${zoneName}`;
  return {
    name,
    fqdn,
    type: String(input.type || "A").toUpperCase(),
    content: String(input.content || "").trim(),
    ttl: Number(input.ttl || 1),
    proxied: Boolean(input.proxied),
    provider,
  };
}

export function getProviderCatalog() {
  return [
    {
      key: "cloudflare",
      name: "Cloudflare",
      supportsProxyStatus: true,
      secretLabel: "API Token",
      description: "适合需要代理状态、快速接入和常见 A/CNAME/TXT 记录管理的场景。",
    },
    {
      key: "gcore",
      name: "Gcore",
      supportsProxyStatus: false,
      secretLabel: "API Key",
      description: "适合已经把 Zone 托管到 Gcore Managed DNS 的场景，复杂 RRset 首版只读。",
    },
  ];
}

export function listProviderConnections() {
  const rows = getIntegrationRows().map(serializeConnection);
  const legacy = getLegacyCloudflareConnection();
  return legacy ? [legacy, ...rows] : rows;
}

function getConnectionSecret(connectionId: string) {
  if (connectionId === "legacy-cloudflare-env") {
    return {
      provider: "cloudflare" as const,
      secret: CONFIG.CF_API_TOKEN,
    };
  }

  const row = getIntegrationRow(connectionId);
  if (!row) throw new Error("接入不存在");
  const secretRow = getSecretRow(connectionId);
  if (!secretRow) throw new Error("接入凭据不存在");
  const decrypted = parseJson<Record<string, string>>(
    decryptSecret({
      ciphertext: secretRow.ciphertext,
      iv: secretRow.iv,
      authTag: secretRow.auth_tag,
      keyVersion: secretRow.key_version,
    }),
    {}
  );

  return {
    provider: row.provider as "cloudflare" | "gcore",
    secret: row.provider === "cloudflare" ? decrypted.apiToken : decrypted.apiKey,
    row,
  };
}

export async function createProviderConnection(input: CreateProviderConnectionInput) {
  if (!hasMasterKey()) {
    throw new Error("请先配置 APP_MASTER_KEY，再保存 DNS 厂商接入凭据");
  }
  const provider = input.provider;
  const secret = provider === "cloudflare" ? input.apiToken?.trim() : input.apiKey?.trim();
  if (!secret) {
    throw new Error(`${provider === "cloudflare" ? "Cloudflare API Token" : "Gcore API Key"} 不能为空`);
  }

  const db = getDb();
  const id = crypto.randomUUID();
  const timestamp = nowIso();
  const encrypted = encryptSecret(JSON.stringify(provider === "cloudflare" ? { apiToken: secret } : { apiKey: secret }));

  db.prepare(
    `INSERT INTO integrations (id, kind, provider, display_name, status, metadata_json, last_verified_at, created_at, updated_at)
     VALUES (@id, 'dns-provider', @provider, @displayName, 'pending', @metadataJson, NULL, @createdAt, @updatedAt)`
  ).run({
    id,
    provider,
    displayName: input.displayName.trim() || `${provider}-${timestamp.slice(0, 10)}`,
    metadataJson: JSON.stringify({ managedBy: "database" }),
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  db.prepare(
    `INSERT INTO integration_secrets (integration_id, ciphertext, iv, auth_tag, key_version, created_at, updated_at)
     VALUES (@integrationId, @ciphertext, @iv, @authTag, @keyVersion, @createdAt, @updatedAt)`
  ).run({
    integrationId: id,
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    authTag: encrypted.authTag,
    keyVersion: encrypted.keyVersion,
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  await verifyProviderConnection(id);
  return listProviderConnections().find((connection) => connection.id === id);
}

export async function verifyProviderConnection(connectionId: string) {
  const db = getDb();
  const timestamp = nowIso();
  try {
    const connection = getConnectionSecret(connectionId);
    if (connection.provider === "cloudflare") {
      await cloudflareListZones(connection.secret || "");
    } else {
      await gcoreListZones(connection.secret || "");
    }
    if (connectionId !== "legacy-cloudflare-env") {
      db.prepare(
        `UPDATE integrations
         SET status = 'ready',
             last_verified_at = @lastVerifiedAt,
             updated_at = @updatedAt
         WHERE id = @id`
      ).run({
        id: connectionId,
        lastVerifiedAt: timestamp,
        updatedAt: timestamp,
      });
    }
  } catch (error: any) {
    if (connectionId !== "legacy-cloudflare-env") {
      db.prepare(
        `UPDATE integrations
         SET status = 'error',
             last_verified_at = @lastVerifiedAt,
             metadata_json = @metadataJson,
             updated_at = @updatedAt
         WHERE id = @id`
      ).run({
        id: connectionId,
        lastVerifiedAt: timestamp,
        metadataJson: JSON.stringify({ managedBy: "database", lastError: error.message }),
        updatedAt: timestamp,
      });
    }
    throw error;
  }
  return listProviderConnections().find((connection) => connection.id === connectionId);
}

export async function listConnectionZones(connectionId: string) {
  const connection = getConnectionSecret(connectionId);
  return connection.provider === "cloudflare"
    ? cloudflareListZones(connection.secret || "")
    : gcoreListZones(connection.secret || "");
}

export async function listConnectionRecords(connectionId: string, zoneName: string) {
  const connection = getConnectionSecret(connectionId);
  return connection.provider === "cloudflare"
    ? cloudflareListRecords(connection.secret || "", zoneName)
    : gcoreListRecords(connection.secret || "", zoneName);
}

export async function createConnectionRecord(connectionId: string, zoneName: string, input: any) {
  const connection = getConnectionSecret(connectionId);
  const payload = buildPayload(input, zoneName, connection.provider);
  if (connection.provider === "cloudflare") {
    return cloudflareCreateRecord(connection.secret || "", zoneName, payload);
  }
  return gcoreCreateOrUpdateRecord(connection.secret || "", zoneName, payload.fqdn, payload, "post");
}

export async function updateConnectionRecord(connectionId: string, zoneName: string, recordId: string, input: any) {
  const connection = getConnectionSecret(connectionId);
  const payload = buildPayload(input, zoneName, connection.provider);
  if (connection.provider === "cloudflare") {
    return cloudflareUpdateRecord(connection.secret || "", zoneName, recordId, payload);
  }
  return gcoreCreateOrUpdateRecord(connection.secret || "", zoneName, payload.fqdn, payload, "put");
}

export async function deleteConnectionRecord(connectionId: string, zoneName: string, recordId: string) {
  const connection = getConnectionSecret(connectionId);
  if (connection.provider === "cloudflare") {
    return cloudflareDeleteRecord(connection.secret || "", zoneName, recordId);
  }
  return gcoreDeleteRecord(connection.secret || "", zoneName, recordId);
}
