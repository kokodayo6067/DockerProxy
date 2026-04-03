import crypto from "crypto";
import { getDb } from "../db";
import { CONFIG } from "../utils/config";
import { getEnvironment, getLocalEnvironmentId, listEnvironments } from "./platform";
import { getRoutes } from "./nginx";

type GatewayRow = {
  id: string;
  environment_id: string | null;
  display_name: string;
  kind: string;
  status: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
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

function buildGatewayResponse(row: GatewayRow) {
  const environment = row.environment_id ? getEnvironment(row.environment_id) : null;
  const routes = getRoutes({ gatewayId: row.id });
  const metadata = parseJson<Record<string, unknown>>(row.metadata_json, {});
  const isLocalGateway = row.id === "gateway:local";

  return {
    id: row.id,
    serverId: row.environment_id,
    displayName: row.display_name,
    kind: row.kind,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata,
    server: environment
      ? {
          id: environment.id,
          displayName: environment.displayName,
          host: environment.host,
          status: environment.status,
        }
      : null,
    routeCount: routes.length,
    certificateCount: routes.filter((route: any) => route.ssl).length,
    capabilities: {
      routeManagement: isLocalGateway || metadata.routeManagement !== false,
      certificateManagement: isLocalGateway,
    },
  };
}

export function initGatewaysData() {
  const db = getDb();
  const timestamp = nowIso();
  db.prepare(
    `INSERT INTO gateways (id, environment_id, display_name, kind, status, metadata_json, created_at, updated_at)
     VALUES (@id, @environmentId, @displayName, 'nginx', 'active', @metadataJson, @createdAt, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       environment_id = excluded.environment_id,
       display_name = excluded.display_name,
       status = excluded.status,
       metadata_json = excluded.metadata_json,
       updated_at = excluded.updated_at`
  ).run({
    id: "gateway:local",
    environmentId: getLocalEnvironmentId(),
    displayName: "本地 Nginx 网关",
    metadataJson: JSON.stringify({
      container: CONFIG.NGINX_CONTAINER_NAME,
      certAgentContainer: CONFIG.CERT_AGENT_CONTAINER_NAME,
    }),
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  for (const environment of listEnvironments().filter((item) => !item.isLocal)) {
    db.prepare(
      `INSERT INTO gateways (id, environment_id, display_name, kind, status, metadata_json, created_at, updated_at)
       VALUES (@id, @environmentId, @displayName, 'nginx', @status, @metadataJson, @createdAt, @updatedAt)
       ON CONFLICT(id) DO UPDATE SET
         environment_id = excluded.environment_id,
         display_name = excluded.display_name,
         status = excluded.status,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`
    ).run({
      id: `gateway:ssh:${environment.id}`,
      environmentId: environment.id,
      displayName: `${environment.displayName} Nginx 网关`,
      status: environment.capabilities.modules?.gateway ? "active" : "inactive",
      metadataJson: JSON.stringify({
        mode: "ssh-nginx",
        configDir: "/etc/nginx/conf.d",
        reloadCommand: "nginx -s reload",
        routeManagement: Boolean(environment.capabilities.modules?.gateway),
      }),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }
}

export function listGateways(serverId?: string) {
  const db = getDb();
  const rows = (serverId
    ? db.prepare("SELECT * FROM gateways WHERE environment_id = ? ORDER BY created_at ASC").all(serverId)
    : db.prepare("SELECT * FROM gateways ORDER BY created_at ASC").all()) as GatewayRow[];
  return rows.map(buildGatewayResponse);
}

export function listServerGatewaySummaries() {
  const gateways = listGateways();
  const summary = new Map<
    string,
    {
      total: number;
      active: number;
      certificates: number;
      routes: number;
    }
  >();

  for (const gateway of gateways) {
    if (!gateway.serverId) continue;
    const current = summary.get(gateway.serverId) || { total: 0, active: 0, certificates: 0, routes: 0 };
    current.total += 1;
    if (gateway.status === "active") current.active += 1;
    current.certificates += gateway.certificateCount;
    current.routes += gateway.routeCount;
    summary.set(gateway.serverId, current);
  }

  for (const environment of listEnvironments()) {
    if (!summary.has(environment.id)) {
      summary.set(environment.id, { total: 0, active: 0, certificates: 0, routes: 0 });
    }
  }

  return summary;
}

export function getGateway(gatewayId: string) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM gateways WHERE id = ?").get(gatewayId) as GatewayRow | undefined;
  if (!row) throw new Error("网关不存在");
  return buildGatewayResponse(row);
}

export function getGatewayCertificates(gatewayId: string) {
  const gateway = getGateway(gatewayId);
  return getRoutes({ gatewayId: gateway.id })
    .filter((route: any) => route.ssl)
    .map((route: any) => ({
      id: crypto.createHash("sha1").update(route.domain).digest("hex"),
      gatewayId,
      serverId: gateway.serverId,
      gatewayName: gateway.displayName,
      domain: route.domain,
      issueDate: new Date().toISOString(),
      expiryDate: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      status: "valid" as const,
      routeTarget: route.target,
    }));
}
