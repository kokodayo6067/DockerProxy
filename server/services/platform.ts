import crypto from "crypto";
import { exec as execCallback } from "child_process";
import { promisify } from "util";
import { NodeSSH } from "node-ssh";
import { getDb } from "../db";
import { CONFIG } from "../utils/config";
import { decryptSecret, encryptSecret, hasMasterKey } from "./security";

const execAsync = promisify(execCallback);
const LOCAL_ENVIRONMENT_ID = "local";

type EnvironmentRow = {
  id: string;
  display_name: string;
  type: "local-docker" | "remote-ssh-docker";
  source: "local-host" | "manual-ssh" | "provider-imported";
  runtime_driver: string;
  host: string | null;
  port: number | null;
  username: string | null;
  workdir: string;
  auth_type: "password" | "privateKey" | null;
  host_fingerprint: string | null;
  status: "ready" | "warning" | "error" | "pending";
  last_error: string | null;
  created_at: string;
  updated_at: string;
  last_verified_at: string | null;
  is_local: number;
};

type CapabilityRow = {
  environment_id: string;
  connect_ok: number;
  inspect_ok: number;
  operate_ok: number;
  elevated_ok: number;
  docker_version: string | null;
  compose_version: string | null;
  architecture: string | null;
  available_disk_bytes: number | null;
  sudo_mode: "none" | "passwordless" | "with-password";
  modules_json: string;
  permissions_json: string;
  warnings_json: string;
  details_json: string;
  host_fingerprint: string | null;
  last_checked_at: string | null;
};

type CreateEnvironmentInput = {
  displayName: string;
  host: string;
  port?: number;
  username: string;
  authType: "password" | "privateKey";
  password?: string;
  privateKey?: string;
  workdir?: string;
  source?: "manual-ssh" | "provider-imported";
};

type EnvironmentCredentialPayload = {
  password?: string;
  privateKey?: string;
};

type CapabilityAssessment = {
  connectOk: boolean;
  inspectOk: boolean;
  operateOk: boolean;
  elevatedOk: boolean;
  dockerVersion?: string;
  composeVersion?: string;
  architecture?: string;
  availableDiskBytes?: number;
  sudoMode: "none" | "passwordless" | "with-password";
  modules: string[];
  permissions: string[];
  warnings: string[];
  details: Record<string, unknown>;
  hostFingerprint?: string;
  status: "ready" | "warning" | "error";
  lastError?: string;
};

function nowIso() {
  return new Date().toISOString();
}

function defaultWorkdir(environmentId: string) {
  return environmentId === LOCAL_ENVIRONMENT_ID
    ? `${CONFIG.DATA_DIR}/projects`
    : "/opt/docker-projects";
}

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeModules(capability: CapabilityAssessment) {
  return {
    monitor: capability.connectOk && capability.inspectOk,
    docker: capability.inspectOk,
    deploy: capability.operateOk,
    migrateTarget: capability.inspectOk && capability.operateOk && capability.elevatedOk,
    gateway: capability.elevatedOk,
  };
}

function serializeCapability(environmentId: string, capability: CapabilityAssessment): CapabilityRow {
  return {
    environment_id: environmentId,
    connect_ok: capability.connectOk ? 1 : 0,
    inspect_ok: capability.inspectOk ? 1 : 0,
    operate_ok: capability.operateOk ? 1 : 0,
    elevated_ok: capability.elevatedOk ? 1 : 0,
    docker_version: capability.dockerVersion || null,
    compose_version: capability.composeVersion || null,
    architecture: capability.architecture || null,
    available_disk_bytes: capability.availableDiskBytes ?? null,
    sudo_mode: capability.sudoMode,
    modules_json: JSON.stringify(normalizeModules(capability)),
    permissions_json: JSON.stringify(capability.permissions),
    warnings_json: JSON.stringify(capability.warnings),
    details_json: JSON.stringify(capability.details),
    host_fingerprint: capability.hostFingerprint || null,
    last_checked_at: nowIso(),
  };
}

async function execLocal(command: string) {
  try {
    const { stdout, stderr } = await execAsync(command, {
      shell: "/bin/zsh",
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, stdout: String(stdout || "").trim(), stderr: String(stderr || "").trim() };
  } catch (error: any) {
    return {
      ok: false,
      stdout: String(error?.stdout || "").trim(),
      stderr: String(error?.stderr || error?.message || "").trim(),
    };
  }
}

async function probeLocalEnvironment(): Promise<CapabilityAssessment> {
  const dockerVersion = await execLocal("docker --version");
  const composeVersion = await execLocal("docker compose version");
  const inspectDocker = await execLocal("docker ps --format '{{.ID}}' | head -n 1");
  const disk = await execLocal(`df -Pk ${JSON.stringify(CONFIG.DATA_DIR)}`);
  const arch = await execLocal("uname -m");

  let availableDiskBytes: number | undefined;
  if (disk.ok) {
    const line = disk.stdout.split(/\r?\n/).find((entry) => !entry.startsWith("Filesystem"));
    const parts = line?.trim().split(/\s+/) || [];
    availableDiskBytes = Number(parts[3] || 0) * 1024 || undefined;
  }

  const connectOk = true;
  const inspectOk = dockerVersion.ok;
  const operateOk = dockerVersion.ok && composeVersion.ok && inspectDocker.ok;
  const elevatedOk = operateOk;
  const warnings = [];
  if (!composeVersion.ok) warnings.push("未检测到 docker compose，远程部署与迁移将不可用");

  return {
    connectOk,
    inspectOk,
    operateOk,
    elevatedOk,
    dockerVersion: dockerVersion.stdout || undefined,
    composeVersion: composeVersion.stdout || undefined,
    architecture: arch.stdout || process.arch,
    availableDiskBytes,
    sudoMode: "passwordless",
    modules: [],
    permissions: ["connect", ...(inspectOk ? ["inspect"] : []), ...(operateOk ? ["operate", "elevated"] : [])],
    warnings,
    details: {
      scope: "local",
      dataDir: CONFIG.DATA_DIR,
    },
    status: operateOk ? "ready" : inspectOk ? "warning" : "error",
    lastError: inspectOk ? undefined : dockerVersion.stderr || "本机 Docker 不可用",
  };
}

async function connectWithFingerprint(
  environment: EnvironmentRow,
  credential: EnvironmentCredentialPayload,
  expectedFingerprint?: string | null
) {
  const ssh = new NodeSSH();
  let fingerprint = "";
  try {
    await ssh.connect({
      host: environment.host || "",
      port: environment.port || 22,
      username: environment.username || "",
      password: credential.password,
      privateKey: credential.privateKey,
      hostHash: "sha256",
      hostVerifier: (hashedKey) => {
        fingerprint = hashedKey;
        if (!expectedFingerprint) return true;
        return hashedKey === expectedFingerprint;
      },
    });
  } catch (error: any) {
    ssh.dispose();
    if (expectedFingerprint && fingerprint && fingerprint !== expectedFingerprint) {
      throw new Error("主机指纹与已记录值不一致，请确认是否更换了目标主机");
    }
    throw error;
  }
  return { ssh, fingerprint };
}

async function execRemote(ssh: NodeSSH, command: string) {
  const result = await ssh.execCommand(command, { cwd: "/" });
  return {
    ok: result.code === 0,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
    code: result.code ?? 1,
  };
}

async function probeRemoteEnvironment(environment: EnvironmentRow, credential: EnvironmentCredentialPayload) {
  const { ssh, fingerprint } = await connectWithFingerprint(environment, credential, environment.host_fingerprint);
  try {
    const dockerVersion = await execRemote(ssh, "docker --version");
    const composeVersion = await execRemote(ssh, "docker compose version");
    const inspectDocker = await execRemote(ssh, "docker ps --format '{{.ID}}' | head -n 1");
    const arch = await execRemote(ssh, "uname -m");
    const disk = await execRemote(
      ssh,
      `sh -lc 'parent="$(dirname "${environment.workdir.replace(/"/g, '\\"')}")"; test -d "$parent" || parent="/"; df -Pk "$parent" | tail -n 1'`
    );
    const directWrite = await execRemote(
      ssh,
      `sh -lc 'parent="$(dirname "${environment.workdir.replace(/"/g, '\\"')}")"; test -w "$parent"'`
    );
    const sudoNoPassword = await execRemote(ssh, "sudo -n true");
    const sudoWithPassword =
      credential.password && !sudoNoPassword.ok
        ? await execRemote(ssh, `printf '%s\n' ${JSON.stringify(credential.password)} | sudo -S -p '' true`)
        : { ok: false, stdout: "", stderr: "", code: 1 };

    let availableDiskBytes: number | undefined;
    if (disk.ok) {
      const parts = disk.stdout.trim().split(/\s+/);
      availableDiskBytes = Number(parts[3] || 0) * 1024 || undefined;
    }

    const sudoMode = sudoNoPassword.ok ? "passwordless" : sudoWithPassword.ok ? "with-password" : "none";
    const connectOk = true;
    const inspectOk = dockerVersion.ok;
    const operateOk = dockerVersion.ok && inspectDocker.ok;
    const elevatedOk = directWrite.ok || sudoNoPassword.ok || sudoWithPassword.ok;
    const warnings: string[] = [];

    if (!composeVersion.ok) warnings.push("未检测到 docker compose，目标环境无法用于 Compose 部署或迁移");
    if (!elevatedOk) warnings.push("当前账号无法写入工作目录，迁移和路由/证书下发将受限");

    return {
      connectOk,
      inspectOk,
      operateOk,
      elevatedOk,
      dockerVersion: dockerVersion.stdout || undefined,
      composeVersion: composeVersion.stdout || undefined,
      architecture: arch.stdout || undefined,
      availableDiskBytes,
      sudoMode,
      modules: [],
      permissions: [
        "connect",
        ...(inspectOk ? ["inspect"] : []),
        ...(operateOk ? ["operate"] : []),
        ...(elevatedOk ? ["elevated"] : []),
      ],
      warnings,
      details: {
        workdir: environment.workdir,
        directWrite: directWrite.ok,
        sudoMode,
      },
      hostFingerprint: fingerprint,
      status: operateOk && elevatedOk ? "ready" : inspectOk ? "warning" : "error",
      lastError: inspectOk ? undefined : dockerVersion.stderr || "远端 Docker 不可用",
    } satisfies CapabilityAssessment;
  } finally {
    ssh.dispose();
  }
}

function ensureCapabilityRecord(environmentId: string, capability: CapabilityAssessment) {
  const db = getDb();
  const row = serializeCapability(environmentId, capability);
  db.prepare(
    `INSERT INTO environment_capabilities (
      environment_id, connect_ok, inspect_ok, operate_ok, elevated_ok, docker_version, compose_version,
      architecture, available_disk_bytes, sudo_mode, modules_json, permissions_json, warnings_json,
      details_json, host_fingerprint, last_checked_at
    ) VALUES (
      @environment_id, @connect_ok, @inspect_ok, @operate_ok, @elevated_ok, @docker_version, @compose_version,
      @architecture, @available_disk_bytes, @sudo_mode, @modules_json, @permissions_json, @warnings_json,
      @details_json, @host_fingerprint, @last_checked_at
    )
    ON CONFLICT(environment_id) DO UPDATE SET
      connect_ok = excluded.connect_ok,
      inspect_ok = excluded.inspect_ok,
      operate_ok = excluded.operate_ok,
      elevated_ok = excluded.elevated_ok,
      docker_version = excluded.docker_version,
      compose_version = excluded.compose_version,
      architecture = excluded.architecture,
      available_disk_bytes = excluded.available_disk_bytes,
      sudo_mode = excluded.sudo_mode,
      modules_json = excluded.modules_json,
      permissions_json = excluded.permissions_json,
      warnings_json = excluded.warnings_json,
      details_json = excluded.details_json,
      host_fingerprint = excluded.host_fingerprint,
      last_checked_at = excluded.last_checked_at`
  ).run(row);
}

export function recordAuditLog(
  actor: string,
  action: string,
  targetType: string,
  targetId: string | null,
  level: "info" | "warning" | "error",
  details: Record<string, unknown>
) {
  const db = getDb();
  db.prepare(
    `INSERT INTO audit_logs (id, actor, action, target_type, target_id, level, details_json, created_at)
     VALUES (@id, @actor, @action, @targetType, @targetId, @level, @details, @createdAt)`
  ).run({
    id: crypto.randomUUID(),
    actor,
    action,
    targetType,
    targetId,
    level,
    details: JSON.stringify(details),
    createdAt: nowIso(),
  });
}

function getEnvironmentRow(environmentId: string) {
  const db = getDb();
  return db
    .prepare("SELECT * FROM environments WHERE id = ?")
    .get(environmentId) as EnvironmentRow | undefined;
}

function getCapabilityRow(environmentId: string) {
  const db = getDb();
  return db
    .prepare("SELECT * FROM environment_capabilities WHERE environment_id = ?")
    .get(environmentId) as CapabilityRow | undefined;
}

function getCredentialRow(environmentId: string) {
  const db = getDb();
  return db
    .prepare("SELECT * FROM environment_credentials WHERE environment_id = ?")
    .get(environmentId) as
    | {
        ciphertext: string;
        iv: string;
        auth_tag: string;
        key_version: number;
      }
    | undefined;
}

function buildEnvironmentResponse(environment: EnvironmentRow, capability?: CapabilityRow) {
  const moduleAccess = safeJsonParse<Record<string, boolean>>(capability?.modules_json, {});
  return {
    id: environment.id,
    displayName: environment.display_name,
    type: environment.type,
    source: environment.source,
    runtimeDriver: environment.runtime_driver,
    host: environment.host || "localhost",
    port: environment.port || 22,
    username: environment.username || null,
    workdir: environment.workdir,
    authType: environment.auth_type,
    hostFingerprint: capability?.host_fingerprint || environment.host_fingerprint,
    status: environment.status,
    lastError: environment.last_error,
    createdAt: environment.created_at,
    updatedAt: environment.updated_at,
    lastVerifiedAt: environment.last_verified_at,
    isLocal: environment.is_local === 1,
    capabilities: {
      connect: capability?.connect_ok === 1,
      inspect: capability?.inspect_ok === 1,
      operate: capability?.operate_ok === 1,
      elevated: capability?.elevated_ok === 1,
      dockerVersion: capability?.docker_version,
      composeVersion: capability?.compose_version,
      architecture: capability?.architecture,
      availableDiskBytes: capability?.available_disk_bytes,
      sudoMode: capability?.sudo_mode || "none",
      permissions: safeJsonParse<string[]>(capability?.permissions_json, []),
      warnings: safeJsonParse<string[]>(capability?.warnings_json, []),
      details: safeJsonParse<Record<string, unknown>>(capability?.details_json, {}),
      modules: moduleAccess,
    },
  };
}

export async function initPlatformData() {
  const db = getDb();
  const timestamp = nowIso();
  db.prepare(
    `INSERT INTO environments (
      id, display_name, type, source, runtime_driver, host, port, username, workdir,
      auth_type, status, created_at, updated_at, is_local
    ) VALUES (
      @id, @displayName, 'local-docker', 'local-host', 'docker', 'localhost', 22, @username,
      @workdir, NULL, 'pending', @timestamp, @timestamp, 1
    )
    ON CONFLICT(id) DO UPDATE SET
      display_name = excluded.display_name,
      host = excluded.host,
      port = excluded.port,
      username = excluded.username,
      workdir = excluded.workdir,
      updated_at = excluded.updated_at`
  ).run({
    id: LOCAL_ENVIRONMENT_ID,
    displayName: "当前宿主机",
    username: process.env.USER || "local",
    workdir: defaultWorkdir(LOCAL_ENVIRONMENT_ID),
    timestamp,
  });

  const capability = await probeLocalEnvironment();
  ensureCapabilityRecord(LOCAL_ENVIRONMENT_ID, capability);
  db.prepare(
    `UPDATE environments
     SET status = @status,
         last_error = @lastError,
         last_verified_at = @verifiedAt,
         updated_at = @updatedAt
     WHERE id = @id`
  ).run({
    id: LOCAL_ENVIRONMENT_ID,
    status: capability.status,
    lastError: capability.lastError || null,
    verifiedAt: nowIso(),
    updatedAt: nowIso(),
  });
}

export function listEnvironments() {
  const db = getDb();
  const environments = db
    .prepare("SELECT * FROM environments ORDER BY is_local DESC, created_at ASC")
    .all() as EnvironmentRow[];
  return environments.map((environment) => buildEnvironmentResponse(environment, getCapabilityRow(environment.id)));
}

export function getEnvironment(environmentId: string) {
  const environment = getEnvironmentRow(environmentId);
  if (!environment) throw new Error("环境不存在");
  return buildEnvironmentResponse(environment, getCapabilityRow(environmentId));
}

export function getEnvironmentConnection(environmentId: string) {
  const environment = getEnvironmentRow(environmentId);
  if (!environment) throw new Error("环境不存在");
  if (environment.is_local === 1) {
    return { environment, credential: null };
  }
  const credentialRow = getCredentialRow(environmentId);
  if (!credentialRow) {
    throw new Error("环境凭据不存在");
  }
  return {
    environment,
    credential: safeJsonParse<EnvironmentCredentialPayload>(
      decryptSecret({
        ciphertext: credentialRow.ciphertext,
        iv: credentialRow.iv,
        authTag: credentialRow.auth_tag,
        keyVersion: credentialRow.key_version,
      }),
      {}
    ),
  };
}

export async function verifyEnvironment(environmentId: string, actor = "system") {
  const db = getDb();
  const { environment, credential } = getEnvironmentConnection(environmentId);
  const capability =
    environment.is_local === 1 ? await probeLocalEnvironment() : await probeRemoteEnvironment(environment, credential || {});
  ensureCapabilityRecord(environmentId, capability);
  db.prepare(
    `UPDATE environments
     SET status = @status,
         host_fingerprint = COALESCE(@hostFingerprint, host_fingerprint),
         last_error = @lastError,
         last_verified_at = @verifiedAt,
         updated_at = @updatedAt
     WHERE id = @id`
  ).run({
    id: environmentId,
    status: capability.status,
    hostFingerprint: capability.hostFingerprint || null,
    lastError: capability.lastError || null,
    verifiedAt: nowIso(),
    updatedAt: nowIso(),
  });
  recordAuditLog(actor, "environment.verify", "environment", environmentId, capability.status === "error" ? "error" : "info", {
    status: capability.status,
    permissions: capability.permissions,
    warnings: capability.warnings,
  });
  return getEnvironment(environmentId);
}

export async function createEnvironment(input: CreateEnvironmentInput, actor = "admin") {
  if (!hasMasterKey()) {
    throw new Error("请先在 .env 中配置 APP_MASTER_KEY，再保存 SSH 环境凭据");
  }
  if (input.authType === "password" && !input.password) {
    throw new Error("使用密码接入时必须填写密码");
  }
  if (input.authType === "privateKey" && !input.privateKey) {
    throw new Error("使用私钥接入时必须填写私钥");
  }

  const db = getDb();
  const id = crypto.randomUUID();
  const timestamp = nowIso();
  const environment: EnvironmentRow = {
    id,
    display_name: input.displayName.trim(),
    type: "remote-ssh-docker",
    source: input.source || "manual-ssh",
    runtime_driver: "docker",
    host: input.host.trim(),
    port: Number(input.port || 22),
    username: input.username.trim(),
    workdir: input.workdir?.trim() || defaultWorkdir(id),
    auth_type: input.authType,
    host_fingerprint: null,
    status: "pending",
    last_error: null,
    created_at: timestamp,
    updated_at: timestamp,
    last_verified_at: null,
    is_local: 0,
  };

  db.prepare(
    `INSERT INTO environments (
      id, display_name, type, source, runtime_driver, host, port, username, workdir, auth_type,
      host_fingerprint, status, last_error, created_at, updated_at, last_verified_at, is_local
    ) VALUES (
      @id, @display_name, @type, @source, @runtime_driver, @host, @port, @username, @workdir, @auth_type,
      @host_fingerprint, @status, @last_error, @created_at, @updated_at, @last_verified_at, @is_local
    )`
  ).run(environment);

  const payload = encryptSecret(
    JSON.stringify({
      password: input.authType === "password" ? input.password : undefined,
      privateKey: input.authType === "privateKey" ? input.privateKey : undefined,
    })
  );
  db.prepare(
    `INSERT INTO environment_credentials (environment_id, ciphertext, iv, auth_tag, key_version, created_at, updated_at)
     VALUES (@environmentId, @ciphertext, @iv, @authTag, @keyVersion, @createdAt, @updatedAt)`
  ).run({
    environmentId: id,
    ciphertext: payload.ciphertext,
    iv: payload.iv,
    authTag: payload.authTag,
    keyVersion: payload.keyVersion,
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  recordAuditLog(actor, "environment.create", "environment", id, "info", {
    displayName: environment.display_name,
    host: environment.host,
    port: environment.port,
    username: environment.username,
    authType: environment.auth_type,
  });

  return verifyEnvironment(id, actor);
}

export async function connectEnvironmentSsh(environmentId: string) {
  const { environment, credential } = getEnvironmentConnection(environmentId);
  if (environment.is_local === 1) {
    throw new Error("本地环境不需要 SSH 连接");
  }
  return connectWithFingerprint(environment, credential || {}, environment.host_fingerprint);
}

export function isEnvironmentAllowed(environmentId: string, capability: keyof ReturnType<typeof normalizeModules>) {
  const environment = getEnvironment(environmentId);
  return Boolean(environment.capabilities.modules[capability]);
}

export function getLocalEnvironmentId() {
  return LOCAL_ENVIRONMENT_ID;
}
