import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { NodeSSH } from "node-ssh";
import { getDb } from "../db";
import { CONFIG } from "../utils/config";
import { docker } from "./docker";
import { connectEnvironmentSsh, getEnvironmentConnection, getLocalEnvironmentId } from "./platform";

export const ROUTES_FILE = path.join(process.cwd(), "data", "routes.json");

type ProxyRouteRow = {
  id: string;
  gateway_id?: string | null;
  environment_id: string | null;
  domain: string;
  target: string;
  ssl: number;
  created_at: string;
  updated_at: string;
};

type GatewayRow = {
  id: string;
  environment_id: string | null;
  display_name: string;
  kind: string;
  status: string;
  metadata_json: string;
};

type RouteInput = {
  gatewayId?: string;
  serverId?: string;
  domain: string;
  target?: string;
  targetIp?: string;
  targetPort?: string | number;
  ssl?: boolean;
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

function shellQuote(value: string) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function sanitizeDomain(domain: string) {
  return domain.replace(/[^a-zA-Z0-9.-]/g, "-");
}

function normalizeTarget(input: RouteInput | { target?: string; targetIp?: string; targetPort?: string | number }) {
  if (input.target) return String(input.target).trim();
  const targetIp = String(input.targetIp || "").trim();
  const targetPort = String(input.targetPort || "").trim();
  if (targetIp && targetPort) return `${targetIp}:${targetPort}`;
  return "";
}

function buildRouteResponse(row: ProxyRouteRow) {
  return {
    id: row.id,
    gatewayId: row.gateway_id || "gateway:local",
    serverId: row.environment_id,
    domain: row.domain,
    target: row.target,
    ssl: row.ssl === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getGatewayRow(gatewayId: string) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM gateways WHERE id = ?").get(gatewayId) as GatewayRow | undefined;
  if (!row) {
    throw new Error("网关不存在");
  }
  return {
    ...row,
    metadata: parseJson<Record<string, string>>(row.metadata_json, {}),
  };
}

function syncLegacyRoutesFile() {
  const localRoutes = getRoutes({ gatewayId: "gateway:local" });
  fs.writeFileSync(ROUTES_FILE, JSON.stringify(localRoutes, null, 2), "utf-8");
}

function ensureProxyRouteColumns() {
  const db = getDb();
  const columns = db.prepare("PRAGMA table_info(proxy_routes)").all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("gateway_id")) {
    db.exec("ALTER TABLE proxy_routes ADD COLUMN gateway_id TEXT REFERENCES gateways(id) ON DELETE SET NULL");
  }
}

function importLegacyRoutesIfNeeded() {
  const db = getDb();
  const total = Number((db.prepare("SELECT COUNT(*) AS count FROM proxy_routes").get() as { count: number }).count || 0);
  if (total > 0) return;
  if (!fs.existsSync(ROUTES_FILE)) {
    fs.writeFileSync(ROUTES_FILE, JSON.stringify([]), "utf-8");
    return;
  }
  const legacyRoutes = parseJson<any[]>(fs.readFileSync(ROUTES_FILE, "utf-8"), []);
  const insert = db.prepare(
    `INSERT INTO proxy_routes (id, gateway_id, environment_id, domain, target, ssl, created_at, updated_at)
     VALUES (@id, @gatewayId, @environmentId, @domain, @target, @ssl, @createdAt, @updatedAt)`
  );
  const timestamp = nowIso();
  for (const route of legacyRoutes) {
    const target = normalizeTarget(route);
    if (!route?.domain || !target) continue;
    insert.run({
      id: route.id || crypto.randomUUID(),
      gatewayId: "gateway:local",
      environmentId: getLocalEnvironmentId(),
      domain: String(route.domain).trim(),
      target,
      ssl: route.ssl === false ? 0 : 1,
      createdAt: route.createdAt || timestamp,
      updatedAt: route.updatedAt || timestamp,
    });
  }
  syncLegacyRoutesFile();
}

async function runRemoteGatewayCommand(gateway: ReturnType<typeof getGatewayRow>, command: string) {
  if (!gateway.environment_id || gateway.environment_id === getLocalEnvironmentId()) {
    throw new Error("当前网关不是远端 SSH 网关");
  }

  const { credential } = getEnvironmentConnection(gateway.environment_id);
  const { ssh } = await connectEnvironmentSsh(gateway.environment_id);
  const attempts = [
    command,
    `sudo -n sh -lc ${shellQuote(command)}`,
    credential?.password
      ? `printf '%s\n' ${JSON.stringify(credential.password)} | sudo -S -p '' sh -lc ${shellQuote(command)}`
      : null,
  ].filter(Boolean) as string[];

  try {
    let lastError = "远端网关命令执行失败";
    for (const candidate of attempts) {
      const result = await ssh.execCommand(candidate, { execOptions: { pty: true } });
      if (result.code === 0) {
        return result.stdout;
      }
      lastError = result.stderr || result.stdout || lastError;
    }
    throw new Error(lastError);
  } finally {
    ssh.dispose();
  }
}

async function writeGatewayConf(gatewayId: string, route: ReturnType<typeof buildRouteResponse>) {
  const gateway = getGatewayRow(gatewayId);
  const metadata = gateway.metadata;
  const confDir =
    metadata.configDir || (gateway.environment_id === getLocalEnvironmentId() ? CONFIG.NGINX_CONF_DIR : "/etc/nginx/conf.d");
  const confPath = path.posix.join(confDir, `${sanitizeDomain(route.domain)}.conf`);
  const confContent = generateNginxConf(route);

  if (gateway.environment_id === getLocalEnvironmentId()) {
    fs.mkdirSync(CONFIG.NGINX_CONF_DIR, { recursive: true });
    fs.writeFileSync(path.join(CONFIG.NGINX_CONF_DIR, `${sanitizeDomain(route.domain)}.conf`), confContent, "utf-8");
    await reloadNginx(gatewayId);
    syncLegacyRoutesFile();
    return;
  }

  const tempFile = path.join(os.tmpdir(), `docker-proxy-${route.id}.conf`);
  fs.writeFileSync(tempFile, confContent, "utf-8");

  const { ssh } = await connectEnvironmentSsh(gateway.environment_id || "");
  try {
    const remoteTempDir = metadata.workdir || `/tmp/docker-proxy-gateway/${gatewayId}`;
    const remoteTempPath = path.posix.join(remoteTempDir, `${sanitizeDomain(route.domain)}.conf`);
    await runRemoteGatewayCommand(gateway, `mkdir -p ${shellQuote(remoteTempDir)} ${shellQuote(confDir)}`);
    await ssh.putFile(tempFile, remoteTempPath);
    await runRemoteGatewayCommand(gateway, `mv ${shellQuote(remoteTempPath)} ${shellQuote(confPath)}`);
  } finally {
    ssh.dispose();
    fs.rmSync(tempFile, { force: true });
  }
  await reloadNginx(gatewayId);
}

async function removeGatewayConf(gatewayId: string, route: ReturnType<typeof buildRouteResponse>) {
  const gateway = getGatewayRow(gatewayId);
  const metadata = gateway.metadata;
  const confDir =
    metadata.configDir || (gateway.environment_id === getLocalEnvironmentId() ? CONFIG.NGINX_CONF_DIR : "/etc/nginx/conf.d");
  const confPath = path.posix.join(confDir, `${sanitizeDomain(route.domain)}.conf`);

  if (gateway.environment_id === getLocalEnvironmentId()) {
    const localConfPath = path.join(CONFIG.NGINX_CONF_DIR, `${sanitizeDomain(route.domain)}.conf`);
    if (fs.existsSync(localConfPath)) {
      fs.unlinkSync(localConfPath);
    }
    await reloadNginx(gatewayId);
    syncLegacyRoutesFile();
    return;
  }

  await runRemoteGatewayCommand(gateway, `rm -f ${shellQuote(confPath)}`);
  await reloadNginx(gatewayId);
}

export function initNginx() {
  if (!fs.existsSync(ROUTES_FILE)) {
    fs.writeFileSync(ROUTES_FILE, JSON.stringify([]), "utf-8");
  }
  ensureProxyRouteColumns();
  importLegacyRoutesIfNeeded();
}

export function getRoutes(filter?: { serverId?: string; gatewayId?: string }) {
  const db = getDb();
  const rows = (filter?.gatewayId
    ? db.prepare("SELECT * FROM proxy_routes WHERE gateway_id = ? ORDER BY created_at DESC").all(filter.gatewayId)
    : filter?.serverId
      ? db.prepare("SELECT * FROM proxy_routes WHERE environment_id = ? ORDER BY created_at DESC").all(filter.serverId)
      : db.prepare("SELECT * FROM proxy_routes ORDER BY created_at DESC").all()) as ProxyRouteRow[];
  return rows.map(buildRouteResponse);
}

export function saveRoutes(routes: any[]) {
  const db = getDb();
  db.prepare("DELETE FROM proxy_routes WHERE gateway_id = ?").run("gateway:local");
  const insert = db.prepare(
    `INSERT INTO proxy_routes (id, gateway_id, environment_id, domain, target, ssl, created_at, updated_at)
     VALUES (@id, 'gateway:local', @environmentId, @domain, @target, @ssl, @createdAt, @updatedAt)`
  );
  const timestamp = nowIso();
  for (const route of routes) {
    const target = normalizeTarget(route);
    if (!route?.domain || !target) continue;
    insert.run({
      id: route.id || crypto.randomUUID(),
      environmentId: getLocalEnvironmentId(),
      domain: route.domain,
      target,
      ssl: route.ssl === false ? 0 : 1,
      createdAt: route.createdAt || timestamp,
      updatedAt: route.updatedAt || timestamp,
    });
  }
  syncLegacyRoutesFile();
}

export async function reloadNginx(gatewayId = "gateway:local") {
  const gateway = getGatewayRow(gatewayId);
  if (gateway.environment_id === getLocalEnvironmentId()) {
    try {
      const nginxContainer = docker.getContainer(CONFIG.NGINX_CONTAINER_NAME);
      const exec = await nginxContainer.exec({
        Cmd: ["nginx", "-s", "reload"],
        AttachStdout: true,
        AttachStderr: true,
      });
      await exec.start({});
      return true;
    } catch (error: any) {
      console.error("Nginx reload 失败:", error.message);
      throw error;
    }
  }

  const metadata = gateway.metadata;
  const reloadCommand = metadata.reloadCommand || "nginx -s reload";
  await runRemoteGatewayCommand(gateway, reloadCommand);
  return true;
}

export function generateNginxConf(route: { domain: string; target?: string; targetIp?: string; targetPort?: string | number }) {
  const normalizedTarget = normalizeTarget(route);
  const upstream = /^https?:\/\//.test(normalizedTarget) ? normalizedTarget : `http://${normalizedTarget}`;
  return `
server {
    listen 80;
    server_name ${route.domain};

    location / {
        proxy_pass ${upstream};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
`;
}

export async function createRoute(input: RouteInput) {
  const gatewayId = input.gatewayId || "gateway:local";
  const gateway = getGatewayRow(gatewayId);
  const target = normalizeTarget(input);
  if (!input.domain?.trim() || !target) {
    throw new Error("域名和目标地址不能为空");
  }

  const route = buildRouteResponse({
    id: crypto.randomUUID(),
    gateway_id: gatewayId,
    environment_id: input.serverId || gateway.environment_id,
    domain: input.domain.trim(),
    target,
    ssl: input.ssl === false ? 0 : 1,
    created_at: nowIso(),
    updated_at: nowIso(),
  });

  await writeGatewayConf(gatewayId, route);

  const db = getDb();
  db.prepare(
    `INSERT INTO proxy_routes (id, gateway_id, environment_id, domain, target, ssl, created_at, updated_at)
     VALUES (@id, @gatewayId, @environmentId, @domain, @target, @ssl, @createdAt, @updatedAt)`
  ).run({
    id: route.id,
    gatewayId,
    environmentId: route.serverId,
    domain: route.domain,
    target: route.target,
    ssl: route.ssl ? 1 : 0,
    createdAt: route.createdAt,
    updatedAt: route.updatedAt,
  });

  if (gatewayId === "gateway:local") {
    syncLegacyRoutesFile();
  }
  return route;
}

export async function deleteRoute(routeId: string) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM proxy_routes WHERE id = ?").get(routeId) as ProxyRouteRow | undefined;
  if (!row) {
    throw new Error("路由未找到");
  }
  const route = buildRouteResponse(row);
  await removeGatewayConf(route.gatewayId || "gateway:local", route);
  db.prepare("DELETE FROM proxy_routes WHERE id = ?").run(routeId);
  if ((row.gateway_id || "gateway:local") === "gateway:local") {
    syncLegacyRoutesFile();
  }
  return route;
}
