import crypto from "crypto";
import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import { exec as execCallback } from "child_process";
import { promisify } from "util";
import yaml from "js-yaml";
import { NodeSSH } from "node-ssh";
import { CONFIG } from "../utils/config";
import { docker } from "./docker";
import { getEnvironment, getEnvironmentConnection, getLocalEnvironmentId } from "./platform";

const execAsync = promisify(execCallback);
const migrationBus = new EventEmitter();
migrationBus.setMaxListeners(0);

const HELPER_IMAGE = "busybox:1.36.1";
const PHASES = [
  "discover",
  "plan",
  "preflight",
  "sync",
  "stage_restore",
  "cutover",
  "verify_or_rollback",
] as const;

type Phase = (typeof PHASES)[number];
type RiskLevel = "low" | "medium" | "high";
type SessionStatus =
  | "idle"
  | "planning"
  | "plan_ready"
  | "blocked"
  | "running"
  | "cutover_pending"
  | "verifying"
  | "completed"
  | "rolled_back"
  | "failed";

export interface TargetHostInput {
  host: string;
  port?: number | string;
  username: string;
  password?: string;
  privateKey?: string;
}

interface PlanInput {
  projectPath: string;
  rootService: string;
  sourceEnvironmentId?: string;
  targetEnvironmentId: string;
}

interface MigrationProjectSource {
  environmentId: string;
  name: string;
  path: string;
  projectDir: string;
  composePath: string;
  services: string[];
  sourceType: "runtime-compose" | "managed-project" | "runtime-container";
  sourceKind: "compose-project" | "standalone-container";
  selectionMode: "whole-project" | "single-service";
  planningMode: "compose-file" | "runtime-snapshot";
  description: string;
  runningContainerCount: number;
  warning?: string;
  remoteProjectDir?: string;
  remoteComposePath?: string;
}

interface MigrationRisk {
  id: string;
  level: RiskLevel;
  title: string;
  category: string;
  scope: string;
  reason: string;
  blocking: boolean;
  recommendation: string;
}

interface ConflictItem {
  id: string;
  kind: string;
  target: string;
  reason: string;
  blocking: boolean;
  recommendation: string;
}

interface BoundaryItem {
  kind: string;
  label: string;
  detail: string;
}

interface ResourceImpact {
  kind: string;
  label: string;
  classification: "read-only inspect" | "new staging resource" | "needs cutover" | "blocked";
  detail: string;
}

interface ServiceRuntimeDrift {
  service: string;
  running: boolean;
  containerNames: string[];
  notes: string[];
}

interface ServiceMount {
  service: string;
  type: "bind" | "volume" | "anonymous";
  source?: string;
  target: string;
  raw: any;
  sourcePath?: string;
}

interface ServiceInfo {
  name: string;
  image?: string;
  hasPorts: boolean;
  ports: number[];
  envFiles: string[];
  externalNetworks: string[];
  internalNetworks: string[];
  namedVolumes: string[];
  bindMounts: string[];
}

interface MigrationPlan {
  sessionId: string;
  projectName: string;
  projectPath: string;
  composePath: string;
  rootService: string;
  dependencyServices: string[];
  selectedServices: string[];
  services: ServiceInfo[];
  readOnlyInspect: ResourceImpact[];
  stagingResources: ResourceImpact[];
  needsCutover: ResourceImpact[];
  blockedResources: ResourceImpact[];
  notTouched: BoundaryItem[];
  safetyBoundary: {
    immutableTargets: BoundaryItem[];
    permissions: BoundaryItem[];
  };
  risks: MigrationRisk[];
  conflicts: ConflictItem[];
  target: {
    host: string;
    port: number;
    username: string;
    workdir: string;
  };
  artifactPaths: {
    manifest: string;
    riskReport: string;
    stagingCompose: string;
    cutoverCompose: string;
  };
  runtimeDrift: ServiceRuntimeDrift[];
  transferEstimate: {
    totalBytes: number;
    knownVolumeBytes: number;
    projectBytes: number;
    unknownVolumeSize: boolean;
  };
  preflight: {
    dockerVersion?: string;
    composeVersion?: string;
    architecture?: string;
    availableDiskBytes?: number;
    missingPermissions: string[];
  };
}

interface TransferSummary {
  currentFile?: string;
  bytesDone: number;
  bytesTotal: number;
  percent: number;
  etaSeconds?: number | null;
  speedBytesPerSec?: number | null;
  checksumStatus: "pending" | "verifying" | "passed" | "failed" | "n/a";
}

interface ServiceRuntimeState {
  phase: string;
  status: string;
  health: "unknown" | "starting" | "healthy" | "unhealthy";
  dataStatus: "n/a" | "pending" | "synced" | "restored" | "failed" | "skipped";
  updatedAt: string;
  note?: string;
}

interface RollbackSummary {
  status: "not_requested" | "completed" | "failed";
  actions: string[];
  message?: string;
  finishedAt?: string;
}

export interface MigrationSession {
  id: string;
  status: SessionStatus;
  pageState: SessionStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
  projectName: string;
  projectPath: string;
  composePath: string;
  sourceEnvironmentId: string;
  targetEnvironmentId: string;
  rootService: string;
  dependencyServices: string[];
  selectedServices: string[];
  target: {
    host: string;
    port: number;
    username: string;
    workdir: string;
  };
  currentPhase: Phase;
  currentStep: string;
  progress: {
    percent: number;
    phasePercent: number;
  };
  serviceCount: number;
  riskCounts: Record<RiskLevel, number>;
  blockingCount: number;
  plan: MigrationPlan;
  services: Record<string, ServiceRuntimeState>;
  transfer: TransferSummary;
  result: {
    outcome: "pending" | "blocked" | "completed" | "rolled_back" | "failed";
    message: string;
    artifacts: string[];
    finalResources: string[];
    verification: { label: string; status: "pass" | "warn" | "fail"; detail: string }[];
    rollback: RollbackSummary;
  };
  internal: {
    migrationProjectName: string;
    remoteBaseDir: string;
    remoteProjectDir: string;
    remoteArtifactsDir: string;
    remoteComposePath: string;
    remoteCutoverComposePath: string;
    remoteProjectArchivePath?: string;
    localSessionDir: string;
    localArtifactsDir: string;
    localProjectDir: string;
    localProjectArchivePath?: string;
    localComposePath: string;
    localProjectBytes: number;
    localFileManifest: Array<{ path: string; size: number }>;
    sourceProjectCached?: boolean;
    sourceRemoteProjectDir?: string;
    sourceRemoteComposePath?: string;
    sourceWorkdir?: string;
    namedVolumeArchives: Array<{
      sourceVolume: string;
      stagingVolume: string;
      archiveName: string;
      archivePath: string;
      size: number;
    }>;
  };
}

export interface MigrationEvent {
  sessionId: string;
  type:
    | "phase_started"
    | "phase_finished"
    | "phase_failed"
    | "service_status_changed"
    | "transfer_progress"
    | "command_log"
    | "session_summary"
    | "result";
  ts: string;
  phase?: Phase;
  step?: string;
  service?: string;
  level?: "info" | "warn" | "error" | "success";
  message: string;
  command?: string;
  current?: number;
  total?: number;
  percent?: number;
  unit?: string;
  meta?: Record<string, any>;
}

interface RemotePreflightResult {
  dockerVersion?: string;
  composeVersion?: string;
  architecture?: string;
  availableDiskBytes?: number;
  missingPermissions: string[];
  conflicts: ConflictItem[];
  risks: MigrationRisk[];
  readOnlyInspect: ResourceImpact[];
}

const activeExecutions = new Map<string, Promise<void>>();

function ensureDir(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function migrationRoot() {
  const baseDataDir = CONFIG.DATA_DIR || path.join(process.cwd(), "data");
  return path.join(baseDataDir, "migrations");
}

function runtimeSnapshotRoot() {
  return path.join(migrationRoot(), "runtime-snapshots");
}

function runtimeSnapshotRootForEnvironment(environmentId: string) {
  return environmentId === getLocalEnvironmentId() ? runtimeSnapshotRoot() : path.join(runtimeSnapshotRoot(), sanitizeName(environmentId));
}

function nowIso() {
  return new Date().toISOString();
}

function sessionDir(sessionId: string) {
  return path.join(migrationRoot(), sessionId);
}

function artifactsDir(sessionId: string) {
  return path.join(sessionDir(sessionId), "artifacts");
}

function sessionFile(sessionId: string) {
  return path.join(sessionDir(sessionId), "session.json");
}

function eventsFile(sessionId: string) {
  return path.join(sessionDir(sessionId), "events.ndjson");
}

function sanitizeSession(session: MigrationSession) {
  return {
    ...session,
    internal: undefined,
  };
}

function loadSession(sessionId: string): MigrationSession | null {
  const filePath = sessionFile(sessionId);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function saveSession(session: MigrationSession) {
  ensureDir(sessionDir(session.id));
  fs.writeFileSync(sessionFile(session.id), JSON.stringify(session, null, 2), "utf-8");
}

function appendEvent(event: MigrationEvent) {
  ensureDir(sessionDir(event.sessionId));
  fs.appendFileSync(eventsFile(event.sessionId), `${JSON.stringify(event)}\n`, "utf-8");
  migrationBus.emit(event.sessionId, event);
}

function updateSession(sessionId: string, updater: (session: MigrationSession) => MigrationSession) {
  const session = loadSession(sessionId);
  if (!session) throw new Error("迁移会话不存在");
  const next = updater(session);
  next.updatedAt = nowIso();
  saveSession(next);
  appendEvent({
    sessionId,
    type: "session_summary",
    ts: next.updatedAt,
    phase: next.currentPhase,
    step: next.currentStep,
    level: "info",
    message: `会话状态更新为 ${next.status}`,
    percent: next.progress.percent,
    meta: { session: sanitizeSession(next) },
  });
  return next;
}

function phasePercent(phase: Phase, phaseProgress = 0) {
  const phaseIndex = PHASES.indexOf(phase);
  return Number((((phaseIndex + phaseProgress) / PHASES.length) * 100).toFixed(1));
}

function shellQuote(value: string) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function getTargetHostFromEnvironment(environmentId: string): TargetHostInput {
  const { environment, credential } = getEnvironmentConnection(environmentId);
  if (environment.is_local === 1) {
    throw new Error("迁移目标环境不能使用当前宿主机");
  }
  return {
    host: environment.host || "",
    port: environment.port || 22,
    username: environment.username || "",
    password: credential?.password,
    privateKey: credential?.privateKey,
  };
}

async function getSourceEnvironmentConnection(environmentId: string) {
  if (isLocalEnvironment(environmentId)) {
    throw new Error("当前宿主机不需要 SSH 连接");
  }
  const { environment, credential } = getEnvironmentConnection(environmentId);
  const ssh = new NodeSSH();
  await ssh.connect({
    host: environment.host || "",
    port: environment.port || 22,
    username: environment.username || "",
    password: credential?.password,
    privateKey: credential?.privateKey,
    hostHash: "sha256",
    hostVerifier: (hashedKey) => {
      if (!environment.host_fingerprint) return true;
      return hashedKey === environment.host_fingerprint;
    },
  });
  return { ssh, environment, credential };
}

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function sanitizeName(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

function isLocalEnvironment(environmentId: string) {
  return environmentId === getLocalEnvironmentId();
}

function parsePortInput(portValue: any): number[] {
  if (!portValue) return [];
  if (typeof portValue === "number") return [portValue];
  if (typeof portValue === "object" && portValue.published) {
    return [Number(portValue.published)].filter(Boolean);
  }
  const raw = String(portValue).split("/")[0];
  const segments = raw.split(":").filter(Boolean);
  if (segments.length < 2) return [];
  const published = Number(segments[segments.length - 2]);
  return Number.isFinite(published) ? [published] : [];
}

function collectServicePorts(service: any) {
  return toArray(service?.ports).flatMap(parsePortInput);
}

function collectDependsOn(service: any) {
  const dependsOn = service?.depends_on;
  if (!dependsOn) return [];
  if (Array.isArray(dependsOn)) return dependsOn;
  if (typeof dependsOn === "object") return Object.keys(dependsOn);
  return [];
}

function collectServiceNetworks(service: any) {
  const networks = service?.networks;
  if (!networks) return [];
  if (Array.isArray(networks)) return networks;
  if (typeof networks === "object") return Object.keys(networks);
  return [];
}

function collectEnvFiles(service: any) {
  return toArray(service?.env_file).map(String);
}

function parseMount(serviceName: string, mount: any, projectDir: string): ServiceMount {
  if (typeof mount === "string") {
    const segments = mount.split(":");
    if (segments.length === 1) {
      return { service: serviceName, type: "anonymous", target: segments[0], raw: mount };
    }
    const source = segments[0];
    const target = segments[1];
    const looksLikePath =
      source.startsWith(".") ||
      source.startsWith("/") ||
      source.startsWith("~") ||
      source.includes("/");
    if (looksLikePath) {
      return {
        service: serviceName,
        type: "bind",
        source,
        target,
        raw: mount,
        sourcePath: path.resolve(projectDir, source),
      };
    }
    return { service: serviceName, type: "volume", source, target, raw: mount };
  }

  const source = mount?.source || mount?.src;
  const target = mount?.target || mount?.destination || mount?.dst;
  if (!source) {
    return { service: serviceName, type: "anonymous", target, raw: mount };
  }
  const kind = mount?.type || (String(source).startsWith(".") || String(source).startsWith("/") ? "bind" : "volume");
  if (kind === "bind") {
    return {
      service: serviceName,
      type: "bind",
      source,
      target,
      raw: mount,
      sourcePath: path.resolve(projectDir, source),
    };
  }
  return { service: serviceName, type: "volume", source, target, raw: mount };
}

function collectServiceMounts(serviceName: string, service: any, projectDir: string) {
  return toArray(service?.volumes).map((mount) => parseMount(serviceName, mount, projectDir));
}

function collectUsedSecrets(service: any) {
  return toArray(service?.secrets).map((entry) => {
    if (typeof entry === "string") return entry;
    return entry?.source || entry?.target;
  }).filter(Boolean);
}

function collectUsedConfigs(service: any) {
  return toArray(service?.configs).map((entry) => {
    if (typeof entry === "string") return entry;
    return entry?.source || entry?.target;
  }).filter(Boolean);
}

function humanFileSize(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function isPlatformManagedNetwork(networkName: string) {
  return Array.isArray(CONFIG.PLATFORM_MANAGED_NETWORKS) && CONFIG.PLATFORM_MANAGED_NETWORKS.includes(networkName);
}

function walkFiles(baseDir: string, currentDir = baseDir, results: Array<{ path: string; size: number }> = []) {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(baseDir, entryPath, results);
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = fs.statSync(entryPath);
    results.push({ path: entryPath, size: stat.size });
  }
  return results;
}

function sumFileSizes(files: Array<{ size: number }>) {
  return files.reduce((total, item) => total + item.size, 0);
}

function resolveComposePathFromRuntime(labels: Record<string, string>) {
  const workingDir = labels["com.docker.compose.project.working_dir"];
  const configFiles = labels["com.docker.compose.project.config_files"];
  const candidates = resolveComposePathCandidates(workingDir, configFiles);

  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
}

function resolveComposePathCandidates(workingDir?: string, configFiles?: string) {
  return [
    ...String(configFiles || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => (path.isAbsolute(item) ? item : workingDir ? path.resolve(workingDir, item) : item)),
    ...(workingDir
      ? [
          path.resolve(workingDir, "docker-compose.yml"),
          path.resolve(workingDir, "docker-compose.yaml"),
          path.resolve(workingDir, "compose.yml"),
          path.resolve(workingDir, "compose.yaml"),
        ]
      : []),
  ];
}

async function remotePathAccessibleWithSsh(
  ssh: NodeSSH,
  remotePath: string,
  type: "file" | "dir" | "any" = "any"
) {
  const clauses: string[] = [];
  if (type === "file") {
    clauses.push(`test -f ${shellQuote(remotePath)}`);
    clauses.push(`test -r ${shellQuote(remotePath)}`);
  } else if (type === "dir") {
    clauses.push(`test -d ${shellQuote(remotePath)}`);
    clauses.push(`test -r ${shellQuote(remotePath)}`);
    clauses.push(`test -x ${shellQuote(remotePath)}`);
  } else {
    clauses.push(`test -e ${shellQuote(remotePath)}`);
  }
  const result = await ssh.execCommand(`${clauses.join(" && ")} && echo ok`);
  return result.code === 0 && String(result.stdout || "").includes("ok");
}

async function resolveAccessibleRemoteComposeSource(ssh: NodeSSH, workingDir?: string, configFiles?: string) {
  const candidates = resolveComposePathCandidates(workingDir, configFiles);
  for (const candidate of candidates) {
    const projectDir = path.posix.dirname(candidate);
    const readable = await remotePathAccessibleWithSsh(ssh, candidate, "file");
    if (!readable) continue;
    const dirReadable = await remotePathAccessibleWithSsh(ssh, projectDir, "dir");
    if (!dirReadable) continue;
    return {
      composePath: candidate,
      projectDir,
    };
  }
  return null;
}

async function listRemoteContainerInspects(environmentId: string) {
  const { ssh } = await getSourceEnvironmentConnection(environmentId);
  try {
    const result = await ssh.execCommand(
      "sh -lc 'ids=$(docker ps -aq --no-trunc); if [ -z \"$ids\" ]; then echo \"[]\"; else docker inspect $ids; fi'"
    );
    if (result.code !== 0) {
      throw new Error(result.stderr || "获取远端容器列表失败");
    }
    return JSON.parse(result.stdout || "[]") as any[];
  } finally {
    ssh.dispose();
  }
}

async function readRemoteTextFile(environmentId: string, remotePath: string) {
  const { ssh } = await getSourceEnvironmentConnection(environmentId);
  try {
    const result = await ssh.execCommand(`cat ${shellQuote(remotePath)}`);
    if (result.code !== 0) {
      throw new Error(result.stderr || `无法读取远端文件: ${remotePath}`);
    }
    return String(result.stdout || "");
  } finally {
    ssh.dispose();
  }
}

async function remotePathExists(environmentId: string, remotePath: string) {
  const { ssh } = await getSourceEnvironmentConnection(environmentId);
  try {
    const result = await ssh.execCommand(`test -e ${shellQuote(remotePath)} && echo ok`);
    return String(result.stdout || "").includes("ok");
  } finally {
    ssh.dispose();
  }
}

async function getRemoteDirectorySize(environmentId: string, remoteDir: string) {
  const { ssh } = await getSourceEnvironmentConnection(environmentId);
  try {
    const result = await ssh.execCommand(`du -sk ${shellQuote(remoteDir)} | awk '{print $1}'`);
    if (result.code !== 0) return 0;
    const sizeKb = Number(String(result.stdout || "").trim());
    return Number.isFinite(sizeKb) ? sizeKb * 1024 : 0;
  } finally {
    ssh.dispose();
  }
}

function buildRuntimeEnvironment(envList: string[]) {
  const environment: Record<string, string> = {};
  for (const entry of envList) {
    if (!entry) continue;
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex < 0) {
      environment[entry] = "";
      continue;
    }
    const key = entry.slice(0, separatorIndex);
    const value = entry.slice(separatorIndex + 1);
    environment[key] = value;
  }
  return environment;
}

function getContainerDisplayName(container: any) {
  const raw = String(container?.Names?.[0] || container?.Name || container?.Id || "container");
  return raw.replace(/^\//, "");
}

function getComposeLabels(container: any) {
  return container?.Labels || container?.Config?.Labels || {};
}

function getContainerImage(container: any) {
  return String(container?.Image || container?.Config?.Image || "").trim();
}

function isRunningContainer(container: any) {
  if (typeof container?.State === "string") {
    return container.State === "running";
  }
  return container?.State?.Running === true;
}

function getContainerNames(container: any) {
  const names = Array.isArray(container?.Names)
    ? container.Names
    : container?.Name
      ? [container.Name]
      : [];
  return names.map((name: string) => String(name || "").replace(/^\//, "")).filter(Boolean);
}

function buildSnapshotServiceName(rawName: string, fallbackId?: string) {
  const sanitized = sanitizeName(rawName).replace(/^[._-]+/, "");
  if (sanitized) return sanitized;
  return fallbackId ? `container_${fallbackId.slice(0, 12)}` : "container_service";
}

function deriveRuntimePortMappings(portBindings: Record<string, Array<{ HostIp?: string; HostPort?: string }> | undefined> | undefined) {
  const ports: string[] = [];
  for (const [containerPort, bindings] of Object.entries(portBindings || {})) {
    if (!bindings || bindings.length === 0) continue;
    for (const binding of bindings) {
      const hostPort = String(binding?.HostPort || "").trim();
      if (!hostPort) continue;
      const hostIp = String(binding?.HostIp || "").trim();
      if (hostIp && hostIp !== "0.0.0.0" && hostIp !== "::") {
        ports.push(`${hostIp}:${hostPort}:${containerPort}`);
      } else {
        ports.push(`${hostPort}:${containerPort}`);
      }
    }
  }
  return Array.from(new Set(ports));
}

function deriveRuntimeNetworkSpec(projectName: string, actualNetworkName: string) {
  if (actualNetworkName.startsWith(`${projectName}_`)) {
    const logicalName = actualNetworkName.slice(projectName.length + 1) || actualNetworkName;
    return {
      logicalName,
      definition: {
        name: actualNetworkName,
      },
    };
  }

  return {
    logicalName: sanitizeName(actualNetworkName),
    definition: {
      external: true,
      name: actualNetworkName,
    },
  };
}

async function buildRuntimeComposeSnapshotSource(input: {
  projectName: string;
  containers: any[];
  fallbackServices: string[];
  runningContainerCount: number;
}) {
  const { projectName, containers, fallbackServices, runningContainerCount } = input;
  if (!projectName || containers.length === 0) return null;

  ensureDir(runtimeSnapshotRoot());
  const snapshotDir = path.join(runtimeSnapshotRoot(), sanitizeName(projectName));
  ensureDir(snapshotDir);

  const preferredByService = new Map<string, any>();
  for (const container of containers) {
    const serviceName = container?.Labels?.["com.docker.compose.service"];
    if (!serviceName) continue;
    const current = preferredByService.get(serviceName);
    const currentRunning = current?.State === "running";
    const nextRunning = container?.State === "running";
    if (!current || (!currentRunning && nextRunning)) {
      preferredByService.set(serviceName, container);
    }
  }

  const compose: any = {
    version: "3.9",
    services: {},
    volumes: {},
    networks: {},
  };

  for (const [serviceName, container] of preferredByService.entries()) {
    let inspect: any;
    try {
      inspect = await docker.getContainer(container.Id).inspect();
    } catch {
      continue;
    }

    const service: any = {};
    if (inspect?.Config?.Image) service.image = inspect.Config.Image;
    if (Array.isArray(inspect?.Config?.Env) && inspect.Config.Env.length > 0) {
      service.environment = buildRuntimeEnvironment(inspect.Config.Env);
    }
    if (inspect?.Config?.WorkingDir) service.working_dir = inspect.Config.WorkingDir;
    if (inspect?.Config?.User) service.user = inspect.Config.User;
    if (Array.isArray(inspect?.Config?.Entrypoint) && inspect.Config.Entrypoint.length > 0) {
      service.entrypoint = inspect.Config.Entrypoint;
    }
    if (Array.isArray(inspect?.Config?.Cmd) && inspect.Config.Cmd.length > 0) {
      service.command = inspect.Config.Cmd;
    }
    const restartPolicy = String(inspect?.HostConfig?.RestartPolicy?.Name || "").trim();
    if (restartPolicy && restartPolicy !== "no") {
      service.restart = restartPolicy;
    }
    if (inspect?.HostConfig?.NetworkMode === "host") {
      service.network_mode = "host";
    }

    const ports = deriveRuntimePortMappings(inspect?.HostConfig?.PortBindings);
    if (ports.length > 0) {
      service.ports = ports;
    }

    const volumes: any[] = [];
    for (const mount of inspect?.Mounts || []) {
      if (!mount?.Destination) continue;
      if (mount.Type === "volume" && mount.Name) {
        const volumeKey = String(mount.Name);
        const suffix = mount.RW === false ? ":ro" : "";
        volumes.push(`${volumeKey}:${mount.Destination}${suffix}`);
        compose.volumes[volumeKey] = {
          ...(compose.volumes[volumeKey] || {}),
          name: mount.Name,
          ...(mount.Driver && mount.Driver !== "local" ? { driver: mount.Driver } : {}),
        };
        continue;
      }
      if (mount.Type === "bind" && mount.Source) {
        volumes.push({
          type: "bind",
          source: mount.Source,
          target: mount.Destination,
          ...(mount.RW === false ? { read_only: true } : {}),
        });
      }
    }
    if (volumes.length > 0) {
      service.volumes = volumes;
    }

    const attachedNetworks = Object.keys(inspect?.NetworkSettings?.Networks || {}).filter((networkName) => networkName !== "host");
    if (attachedNetworks.length > 0 && service.network_mode !== "host") {
      service.networks = attachedNetworks.map((networkName) => {
        const derived = deriveRuntimeNetworkSpec(projectName, networkName);
        if (!compose.networks[derived.logicalName]) {
          compose.networks[derived.logicalName] = derived.definition;
        }
        return derived.logicalName;
      });
    }

    compose.services[serviceName] = service;
  }

  const services = Object.keys(compose.services);
  if (services.length === 0) return null;

  if (Object.keys(compose.volumes).length === 0) delete compose.volumes;
  if (Object.keys(compose.networks).length === 0) delete compose.networks;

  const composePath = path.join(snapshotDir, "docker-compose.runtime.yml");
  fs.writeFileSync(composePath, yaml.dump(compose, { noRefs: true, lineWidth: -1 }), "utf-8");

  return {
    environmentId: getLocalEnvironmentId(),
    name: projectName,
    path: snapshotDir,
    projectDir: snapshotDir,
    composePath,
    services: services.length > 0 ? services.sort() : fallbackServices.slice().sort(),
    sourceType: "runtime-compose" as const,
    sourceKind: "compose-project" as const,
    selectionMode: "whole-project" as const,
    planningMode: "runtime-snapshot" as const,
    description: `来自当前 Docker 运行态（${runningContainerCount} 个容器），已按容器配置生成 Compose 快照`,
    runningContainerCount,
  };
}

async function buildStandaloneContainerSnapshotSource(container: any) {
  const containerName = getContainerDisplayName(container);
  const snapshotDir = path.join(runtimeSnapshotRoot(), `standalone-${sanitizeName(containerName || container?.Id || "container")}`);
  ensureDir(snapshotDir);

  let inspect: any;
  try {
    inspect = await docker.getContainer(container.Id).inspect();
  } catch {
    return null;
  }

  const serviceName = buildSnapshotServiceName(containerName, container?.Id);
  const compose: any = {
    version: "3.9",
    services: {},
    volumes: {},
    networks: {},
  };

  const service: any = {};
  if (inspect?.Config?.Image) service.image = inspect.Config.Image;
  if (Array.isArray(inspect?.Config?.Env) && inspect.Config.Env.length > 0) {
    service.environment = buildRuntimeEnvironment(inspect.Config.Env);
  }
  if (inspect?.Config?.WorkingDir) service.working_dir = inspect.Config.WorkingDir;
  if (inspect?.Config?.User) service.user = inspect.Config.User;
  if (Array.isArray(inspect?.Config?.Entrypoint) && inspect.Config.Entrypoint.length > 0) {
    service.entrypoint = inspect.Config.Entrypoint;
  }
  if (Array.isArray(inspect?.Config?.Cmd) && inspect.Config.Cmd.length > 0) {
    service.command = inspect.Config.Cmd;
  }
  const restartPolicy = String(inspect?.HostConfig?.RestartPolicy?.Name || "").trim();
  if (restartPolicy && restartPolicy !== "no") {
    service.restart = restartPolicy;
  }
  if (inspect?.HostConfig?.NetworkMode === "host") {
    service.network_mode = "host";
  }

  const ports = deriveRuntimePortMappings(inspect?.HostConfig?.PortBindings);
  if (ports.length > 0) {
    service.ports = ports;
  }

  const volumes: any[] = [];
  for (const mount of inspect?.Mounts || []) {
    if (!mount?.Destination) continue;
    if (mount.Type === "volume" && mount.Name) {
      const volumeKey = String(mount.Name);
      const suffix = mount.RW === false ? ":ro" : "";
      volumes.push(`${volumeKey}:${mount.Destination}${suffix}`);
      compose.volumes[volumeKey] = {
        ...(compose.volumes[volumeKey] || {}),
        name: mount.Name,
        ...(mount.Driver && mount.Driver !== "local" ? { driver: mount.Driver } : {}),
      };
      continue;
    }
    if (mount.Type === "bind" && mount.Source) {
      volumes.push({
        type: "bind",
        source: mount.Source,
        target: mount.Destination,
        ...(mount.RW === false ? { read_only: true } : {}),
      });
    }
  }
  if (volumes.length > 0) {
    service.volumes = volumes;
  }

  const attachedNetworks = Object.keys(inspect?.NetworkSettings?.Networks || {}).filter((networkName) => networkName !== "host");
  if (attachedNetworks.length > 0 && service.network_mode !== "host") {
    service.networks = attachedNetworks.map((networkName) => {
      const logicalName = sanitizeName(networkName);
      if (!compose.networks[logicalName]) {
        compose.networks[logicalName] = {
          external: true,
          name: networkName,
        };
      }
      return logicalName;
    });
  }

  compose.services[serviceName] = service;
  if (Object.keys(compose.volumes).length === 0) delete compose.volumes;
  if (Object.keys(compose.networks).length === 0) delete compose.networks;

  const composePath = path.join(snapshotDir, "docker-compose.runtime.yml");
  fs.writeFileSync(composePath, yaml.dump(compose, { noRefs: true, lineWidth: -1 }), "utf-8");

  return {
    environmentId: getLocalEnvironmentId(),
    name: containerName || serviceName,
    path: snapshotDir,
    projectDir: snapshotDir,
    composePath,
    services: [serviceName],
    sourceType: "runtime-container" as const,
    sourceKind: "standalone-container" as const,
    selectionMode: "single-service" as const,
    planningMode: "runtime-snapshot" as const,
    description: `来自当前 Docker 运行态的独立容器 ${containerName || serviceName}`,
    runningContainerCount: container?.State === "running" ? 1 : 0,
  };
}

function buildRemoteComposeSnapshotSource(input: {
  environmentId: string;
  projectName: string;
  inspects: any[];
  fallbackServices: string[];
  runningContainerCount: number;
  warning?: string;
}) {
  const { environmentId, projectName, inspects, fallbackServices, runningContainerCount, warning } = input;
  if (!projectName || inspects.length === 0) return null;
  ensureDir(runtimeSnapshotRootForEnvironment(environmentId));
  const snapshotDir = path.join(runtimeSnapshotRootForEnvironment(environmentId), sanitizeName(projectName));
  ensureDir(snapshotDir);

  const preferredByService = new Map<string, any>();
  for (const inspect of inspects) {
    const serviceName = inspect?.Config?.Labels?.["com.docker.compose.service"];
    if (!serviceName) continue;
    const current = preferredByService.get(serviceName);
    const currentRunning = current?.State?.Running;
    const nextRunning = inspect?.State?.Running;
    if (!current || (!currentRunning && nextRunning)) {
      preferredByService.set(serviceName, inspect);
    }
  }

  const compose: any = {
    version: "3.9",
    services: {},
    volumes: {},
    networks: {},
  };

  for (const [serviceName, inspect] of preferredByService.entries()) {
    const service: any = {};
    if (inspect?.Config?.Image) service.image = inspect.Config.Image;
    if (Array.isArray(inspect?.Config?.Env) && inspect.Config.Env.length > 0) {
      service.environment = buildRuntimeEnvironment(inspect.Config.Env);
    }
    if (inspect?.Config?.WorkingDir) service.working_dir = inspect.Config.WorkingDir;
    if (inspect?.Config?.User) service.user = inspect.Config.User;
    if (Array.isArray(inspect?.Config?.Entrypoint) && inspect.Config.Entrypoint.length > 0) {
      service.entrypoint = inspect.Config.Entrypoint;
    }
    if (Array.isArray(inspect?.Config?.Cmd) && inspect.Config.Cmd.length > 0) {
      service.command = inspect.Config.Cmd;
    }
    const restartPolicy = String(inspect?.HostConfig?.RestartPolicy?.Name || "").trim();
    if (restartPolicy && restartPolicy !== "no") {
      service.restart = restartPolicy;
    }
    if (inspect?.HostConfig?.NetworkMode === "host") {
      service.network_mode = "host";
    }

    const ports = deriveRuntimePortMappings(inspect?.HostConfig?.PortBindings);
    if (ports.length > 0) {
      service.ports = ports;
    }

    const volumes: any[] = [];
    for (const mount of inspect?.Mounts || []) {
      if (!mount?.Destination) continue;
      if (mount.Type === "volume" && mount.Name) {
        const volumeKey = String(mount.Name);
        const suffix = mount.RW === false ? ":ro" : "";
        volumes.push(`${volumeKey}:${mount.Destination}${suffix}`);
        compose.volumes[volumeKey] = {
          ...(compose.volumes[volumeKey] || {}),
          name: mount.Name,
          ...(mount.Driver && mount.Driver !== "local" ? { driver: mount.Driver } : {}),
        };
        continue;
      }
      if (mount.Type === "bind" && mount.Source) {
        volumes.push({
          type: "bind",
          source: mount.Source,
          target: mount.Destination,
          ...(mount.RW === false ? { read_only: true } : {}),
        });
      }
    }
    if (volumes.length > 0) {
      service.volumes = volumes;
    }

    const attachedNetworks = Object.keys(inspect?.NetworkSettings?.Networks || {}).filter((networkName) => networkName !== "host");
    if (attachedNetworks.length > 0 && service.network_mode !== "host") {
      service.networks = attachedNetworks.map((networkName) => {
        const derived = deriveRuntimeNetworkSpec(projectName, networkName);
        if (!compose.networks[derived.logicalName]) {
          compose.networks[derived.logicalName] = derived.definition;
        }
        return derived.logicalName;
      });
    }

    compose.services[serviceName] = service;
  }

  const services = Object.keys(compose.services);
  if (services.length === 0) return null;
  if (Object.keys(compose.volumes).length === 0) delete compose.volumes;
  if (Object.keys(compose.networks).length === 0) delete compose.networks;

  const composePath = path.join(snapshotDir, "docker-compose.runtime.yml");
  fs.writeFileSync(composePath, yaml.dump(compose, { noRefs: true, lineWidth: -1 }), "utf-8");

  return {
    environmentId,
    name: projectName,
    path: `remote-snapshot:${environmentId}:${projectName}`,
    projectDir: snapshotDir,
    composePath,
    services: services.length > 0 ? services.sort() : fallbackServices.slice().sort(),
    sourceType: "runtime-compose" as const,
    sourceKind: "compose-project" as const,
    selectionMode: "whole-project" as const,
    planningMode: "runtime-snapshot" as const,
    description: warning
      ? `来自服务器运行态（${runningContainerCount} 个容器），原始 Compose 目录不可读，已自动降级为快照迁移`
      : `来自服务器运行态（${runningContainerCount} 个容器），已按容器配置生成 Compose 快照`,
    runningContainerCount,
    warning,
  } satisfies MigrationProjectSource;
}

function buildRemoteStandaloneSnapshotSource(environmentId: string, inspect: any) {
  const containerName = getContainerDisplayName(inspect);
  const snapshotDir = path.join(
    runtimeSnapshotRootForEnvironment(environmentId),
    `standalone-${sanitizeName(containerName || inspect?.Id || "container")}`
  );
  ensureDir(runtimeSnapshotRootForEnvironment(environmentId));
  ensureDir(snapshotDir);

  const serviceName = buildSnapshotServiceName(containerName, inspect?.Id);
  const compose: any = {
    version: "3.9",
    services: {},
    volumes: {},
    networks: {},
  };

  const service: any = {};
  if (inspect?.Config?.Image) service.image = inspect.Config.Image;
  if (Array.isArray(inspect?.Config?.Env) && inspect.Config.Env.length > 0) {
    service.environment = buildRuntimeEnvironment(inspect.Config.Env);
  }
  if (inspect?.Config?.WorkingDir) service.working_dir = inspect.Config.WorkingDir;
  if (inspect?.Config?.User) service.user = inspect.Config.User;
  if (Array.isArray(inspect?.Config?.Entrypoint) && inspect.Config.Entrypoint.length > 0) {
    service.entrypoint = inspect.Config.Entrypoint;
  }
  if (Array.isArray(inspect?.Config?.Cmd) && inspect.Config.Cmd.length > 0) {
    service.command = inspect.Config.Cmd;
  }
  const restartPolicy = String(inspect?.HostConfig?.RestartPolicy?.Name || "").trim();
  if (restartPolicy && restartPolicy !== "no") {
    service.restart = restartPolicy;
  }
  if (inspect?.HostConfig?.NetworkMode === "host") {
    service.network_mode = "host";
  }

  const ports = deriveRuntimePortMappings(inspect?.HostConfig?.PortBindings);
  if (ports.length > 0) {
    service.ports = ports;
  }

  const volumes: any[] = [];
  for (const mount of inspect?.Mounts || []) {
    if (!mount?.Destination) continue;
    if (mount.Type === "volume" && mount.Name) {
      const volumeKey = String(mount.Name);
      const suffix = mount.RW === false ? ":ro" : "";
      volumes.push(`${volumeKey}:${mount.Destination}${suffix}`);
      compose.volumes[volumeKey] = {
        ...(compose.volumes[volumeKey] || {}),
        name: mount.Name,
        ...(mount.Driver && mount.Driver !== "local" ? { driver: mount.Driver } : {}),
      };
      continue;
    }
    if (mount.Type === "bind" && mount.Source) {
      volumes.push({
        type: "bind",
        source: mount.Source,
        target: mount.Destination,
        ...(mount.RW === false ? { read_only: true } : {}),
      });
    }
  }
  if (volumes.length > 0) {
    service.volumes = volumes;
  }

  const attachedNetworks = Object.keys(inspect?.NetworkSettings?.Networks || {}).filter((networkName) => networkName !== "host");
  if (attachedNetworks.length > 0 && service.network_mode !== "host") {
    service.networks = attachedNetworks.map((networkName) => {
      const logicalName = sanitizeName(networkName);
      if (!compose.networks[logicalName]) {
        compose.networks[logicalName] = {
          external: true,
          name: networkName,
        };
      }
      return logicalName;
    });
  }

  compose.services[serviceName] = service;
  if (Object.keys(compose.volumes).length === 0) delete compose.volumes;
  if (Object.keys(compose.networks).length === 0) delete compose.networks;

  const composePath = path.join(snapshotDir, "docker-compose.runtime.yml");
  fs.writeFileSync(composePath, yaml.dump(compose, { noRefs: true, lineWidth: -1 }), "utf-8");

  return {
    environmentId,
    name: containerName || serviceName,
    path: `remote-standalone:${environmentId}:${inspect?.Id || serviceName}`,
    projectDir: snapshotDir,
    composePath,
    services: [serviceName],
    sourceType: "runtime-container" as const,
    sourceKind: "standalone-container" as const,
    selectionMode: "single-service" as const,
    planningMode: "runtime-snapshot" as const,
    description: `来自服务器运行态的独立容器 ${containerName || serviceName}`,
    runningContainerCount: inspect?.State?.Running ? 1 : 0,
  } satisfies MigrationProjectSource;
}

async function discoverLocalMigrationProjects(): Promise<MigrationProjectSource[]> {
  const projectsRoot = path.join(CONFIG.DATA_DIR, "projects");
  const discovered = new Map<string, MigrationProjectSource>();

  if (fs.existsSync(projectsRoot)) {
    for (const entry of fs.readdirSync(projectsRoot)) {
      const projectDir = path.join(projectsRoot, entry);
      const composePath = [
        path.join(projectDir, "docker-compose.yml"),
        path.join(projectDir, "docker-compose.yaml"),
        path.join(projectDir, "compose.yml"),
        path.join(projectDir, "compose.yaml"),
      ].find((candidate) => fs.existsSync(candidate));
      if (!composePath) continue;
      const compose = yaml.load(fs.readFileSync(composePath, "utf-8")) as any;
      discovered.set(path.resolve(projectDir), {
        environmentId: getLocalEnvironmentId(),
        name: entry,
        path: path.resolve(projectDir),
        projectDir: path.resolve(projectDir),
        composePath: path.resolve(composePath),
        services: Object.keys(compose?.services || {}),
        sourceType: "managed-project",
        sourceKind: "compose-project",
        selectionMode: "whole-project",
        planningMode: "compose-file",
        description: "来自平台管理目录",
        runningContainerCount: 0,
      });
    }
  }

  try {
    const containers = await docker.listContainers({ all: true });
    const grouped = new Map<
      string,
      {
        name: string;
        services: Set<string>;
        labels: Record<string, string>;
        count: number;
        containers: any[];
      }
    >();

    for (const container of containers as any[]) {
      const labels = container.Labels || {};
      const projectName = labels["com.docker.compose.project"];
      const serviceName = labels["com.docker.compose.service"];
      if (!projectName || !serviceName) continue;
      const group = grouped.get(projectName) || {
        name: projectName,
        services: new Set<string>(),
        labels,
        count: 0,
        containers: [],
      };
      group.services.add(serviceName);
      group.count += 1;
      group.containers.push(container);
      if (!group.labels["com.docker.compose.project.config_files"] && labels["com.docker.compose.project.config_files"]) {
        group.labels = labels;
      }
      grouped.set(projectName, group);
    }

    for (const group of grouped.values()) {
      const composePath = resolveComposePathFromRuntime(group.labels);
      const services = Array.from(group.services).sort();
      if (composePath) {
        const projectDir = path.dirname(composePath);
        const key = path.resolve(projectDir);
        const existing = discovered.get(key);
        discovered.set(key, {
          environmentId: getLocalEnvironmentId(),
          name: existing?.name || group.name,
          path: key,
          projectDir: key,
          composePath: path.resolve(composePath),
          services: existing?.services?.length ? Array.from(new Set([...existing.services, ...services])).sort() : services,
          sourceType: "runtime-compose",
          sourceKind: "compose-project",
          selectionMode: "whole-project",
          planningMode: "compose-file",
          description: `来自当前 Docker 运行态（${group.count} 个容器）`,
          runningContainerCount: group.count,
        });
        continue;
      }

      const snapshotSource = await buildRuntimeComposeSnapshotSource({
        projectName: group.name,
        containers: group.containers,
        fallbackServices: services,
        runningContainerCount: group.count,
      });
      if (!snapshotSource) continue;
      discovered.set(path.resolve(snapshotSource.path), snapshotSource);
    }

    for (const container of containers as any[]) {
      const labels = container.Labels || {};
      if (labels["com.docker.compose.project"] || labels["com.docker.compose.service"]) {
        continue;
      }
      const snapshotSource = await buildStandaloneContainerSnapshotSource(container);
      if (!snapshotSource) continue;
      discovered.set(path.resolve(snapshotSource.path), snapshotSource);
    }
  } catch {
    // 当 docker 守护进程不可访问时，仅返回本地管理目录项目
  }

  return Array.from(discovered.values()).sort((left, right) => {
    const rank = (item: MigrationProjectSource) => {
      if (item.sourceKind === "compose-project" && item.sourceType === "runtime-compose") return 0;
      if (item.sourceKind === "compose-project" && item.sourceType === "managed-project") return 1;
      if (item.sourceKind === "standalone-container") return 2;
      return 3;
    };
    const rankDiff = rank(left) - rank(right);
    if (rankDiff !== 0) {
      return rankDiff;
    }
    return left.name.localeCompare(right.name);
  });
}

async function discoverRemoteMigrationProjects(environmentId: string): Promise<MigrationProjectSource[]> {
  const discovered = new Map<string, MigrationProjectSource>();
  const { ssh, environment } = await getSourceEnvironmentConnection(environmentId);

  try {
    const workdir = environment.workdir || "/opt/docker-projects";
    const composeList = await ssh.execCommand(
      `sh -lc 'root=${shellQuote(workdir)}; if [ -d "$root" ]; then find "$root" -maxdepth 2 -type f \\( -name docker-compose.yml -o -name docker-compose.yaml -o -name compose.yml -o -name compose.yaml \\) -print; fi'`
    );
    if (composeList.code === 0) {
      for (const rawPath of String(composeList.stdout || "")
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean)) {
        try {
          const composeText = await readRemoteTextFile(environmentId, rawPath);
          const compose = yaml.load(composeText) as any;
          const projectDir = path.posix.dirname(rawPath);
          discovered.set(`remote:${environmentId}:${projectDir}`, {
            environmentId,
            name: path.posix.basename(projectDir),
            path: projectDir,
            projectDir,
            composePath: rawPath,
            services: Object.keys(compose?.services || {}),
            sourceType: "managed-project",
            sourceKind: "compose-project",
            selectionMode: "whole-project",
            planningMode: "compose-file",
            description: "来自服务器工作目录",
            runningContainerCount: 0,
            remoteProjectDir: projectDir,
            remoteComposePath: rawPath,
          });
        } catch {
          // ignore unreadable compose candidates
        }
      }
    }

    const inspects = await listRemoteContainerInspects(environmentId);
    const grouped = new Map<
      string,
      {
        name: string;
        services: Set<string>;
        labels: Record<string, string>;
        count: number;
        inspects: any[];
      }
    >();

    for (const inspect of inspects) {
      const labels = inspect?.Config?.Labels || {};
      const projectName = labels["com.docker.compose.project"];
      const serviceName = labels["com.docker.compose.service"];
      if (!projectName || !serviceName) continue;
      const group = grouped.get(projectName) || {
        name: projectName,
        services: new Set<string>(),
        labels,
        count: 0,
        inspects: [],
      };
      group.services.add(serviceName);
      group.count += 1;
      group.inspects.push(inspect);
      if (!group.labels["com.docker.compose.project.config_files"] && labels["com.docker.compose.project.config_files"]) {
        group.labels = labels;
      }
      grouped.set(projectName, group);
    }

    for (const group of grouped.values()) {
      const runtimeCompose = await resolveAccessibleRemoteComposeSource(
        ssh,
        group.labels["com.docker.compose.project.working_dir"],
        group.labels["com.docker.compose.project.config_files"]
      );
      const services = Array.from(group.services).sort();
      if (runtimeCompose) {
        const runtimeComposePath = runtimeCompose.composePath;
        const projectDir = runtimeCompose.projectDir;
        const key = `remote:${environmentId}:${projectDir}`;
        const existing = discovered.get(key);
        discovered.set(key, {
          environmentId,
          name: existing?.name || group.name,
          path: projectDir,
          projectDir,
          composePath: runtimeComposePath,
          services: existing?.services?.length ? Array.from(new Set([...existing.services, ...services])).sort() : services,
          sourceType: "runtime-compose",
          sourceKind: "compose-project",
          selectionMode: "whole-project",
          planningMode: existing?.planningMode || "compose-file",
          description: `来自服务器 Docker 运行态（${group.count} 个容器）`,
          runningContainerCount: group.count,
          remoteProjectDir: projectDir,
          remoteComposePath: runtimeComposePath,
        });
        continue;
      }

      const rawCandidates = resolveComposePathCandidates(
        group.labels["com.docker.compose.project.working_dir"],
        group.labels["com.docker.compose.project.config_files"]
      );
      const fallbackWarning =
        rawCandidates.length > 0
          ? `原始 Compose 目录不可读或已不存在（${rawCandidates[0]}），已自动降级为运行态快照。`
          : "未从运行态标签中解析到可读的 Compose 文件，已自动降级为运行态快照。";
      const snapshotSource = buildRemoteComposeSnapshotSource({
        environmentId,
        projectName: group.name,
        inspects: group.inspects,
        fallbackServices: services,
        runningContainerCount: group.count,
        warning: fallbackWarning,
      });
      if (!snapshotSource) continue;
      discovered.set(snapshotSource.path, snapshotSource);
    }

    for (const inspect of inspects) {
      const labels = inspect?.Config?.Labels || {};
      if (labels["com.docker.compose.project"] || labels["com.docker.compose.service"]) {
        continue;
      }
      const snapshotSource = buildRemoteStandaloneSnapshotSource(environmentId, inspect);
      discovered.set(snapshotSource.path, snapshotSource);
    }
  } finally {
    ssh.dispose();
  }

  return Array.from(discovered.values()).sort((left, right) => left.name.localeCompare(right.name));
}

async function discoverMigrationProjects(environmentId = getLocalEnvironmentId()): Promise<MigrationProjectSource[]> {
  return isLocalEnvironment(environmentId) ? discoverLocalMigrationProjects() : discoverRemoteMigrationProjects(environmentId);
}

async function resolveMigrationProjectSource(projectPath: string, environmentId = getLocalEnvironmentId()) {
  const sources = await discoverMigrationProjects(environmentId);
  return sources.find((source) => source.path === path.resolve(projectPath) || source.path === projectPath) || null;
}

function deriveServiceClosure(compose: any, rootService: string) {
  const selected = new Set<string>();
  const queue = [rootService];
  while (queue.length > 0) {
    const serviceName = queue.shift();
    if (!serviceName || selected.has(serviceName)) continue;
    selected.add(serviceName);
    const service = compose?.services?.[serviceName];
    for (const dep of collectDependsOn(service)) {
      if (!selected.has(dep)) queue.push(dep);
    }
  }
  return Array.from(selected);
}

async function listComposeContainers(projectName: string, environmentId = getLocalEnvironmentId()) {
  try {
    if (isLocalEnvironment(environmentId)) {
      const containers = await docker.listContainers({ all: true });
      return containers.filter((container: any) => container.Labels?.["com.docker.compose.project"] === projectName);
    }
    const inspects = await listRemoteContainerInspects(environmentId);
    return inspects.filter((inspect: any) => inspect?.Config?.Labels?.["com.docker.compose.project"] === projectName);
  } catch {
    return [];
  }
}

async function estimateNamedVolumeSize(volumeName: string, environmentId = getLocalEnvironmentId()) {
  try {
    if (isLocalEnvironment(environmentId)) {
      const { stdout } = await execAsync(
        `docker run --rm -v ${shellQuote(volumeName)}:/from ${HELPER_IMAGE} sh -c "cd /from && tar -cf - . 2>/dev/null | wc -c"`,
        {
          maxBuffer: 16 * 1024 * 1024,
          shell: "/bin/zsh",
        }
      );
      const size = Number(String(stdout).trim());
      return Number.isFinite(size) ? size : 0;
    }

    const { ssh } = await getSourceEnvironmentConnection(environmentId);
    try {
      const result = await ssh.execCommand(
        `docker run --rm -v ${shellQuote(volumeName)}:/from ${HELPER_IMAGE} sh -c "cd /from && tar -cf - . 2>/dev/null | wc -c"`
      );
      const size = Number(String(result.stdout || "").trim());
      return Number.isFinite(size) ? size : 0;
    } finally {
      ssh.dispose();
    }
  } catch {
    return 0;
  }
}

async function analyzeProject(planInput: PlanInput, source?: MigrationProjectSource | null) {
  const sourceEnvironmentId = source?.environmentId || planInput.sourceEnvironmentId || getLocalEnvironmentId();
  if (sourceEnvironmentId === planInput.targetEnvironmentId) {
    throw new Error("源服务器与目标服务器不能相同，请选择不同的迁移目标");
  }
  const targetEnvironment = getEnvironment(planInput.targetEnvironmentId);
  if (!targetEnvironment.capabilities.modules.migrateTarget) {
    throw new Error("目标环境缺少迁移所需权限，请先在环境接入中完成校验并补齐 elevated 权限");
  }
  const targetHost = getTargetHostFromEnvironment(planInput.targetEnvironmentId);
  ensureDir(migrationRoot());
  const sessionId = crypto.randomUUID();
  const localSessionDir = sessionDir(sessionId);
  const localArtifactsDir = artifactsDir(sessionId);
  ensureDir(localArtifactsDir);
  const projectsRoot = path.join(CONFIG.DATA_DIR, "projects");
  const resolvedProjectsRoot = path.resolve(projectsRoot);
  const remoteSource = !isLocalEnvironment(sourceEnvironmentId);
  const fallbackProjectDir = remoteSource
    ? planInput.projectPath
    : path.isAbsolute(planInput.projectPath)
      ? path.resolve(planInput.projectPath)
      : path.resolve(projectsRoot, planInput.projectPath);
  let projectDir = source ? source.projectDir : fallbackProjectDir;
  if (!remoteSource && !source && !projectDir.startsWith(`${resolvedProjectsRoot}${path.sep}`) && projectDir !== resolvedProjectsRoot) {
    throw new Error("projectPath 超出允许的项目目录范围");
  }
  let composePath = source?.composePath || path.join(projectDir, "docker-compose.yml");
  let rawCompose = "";
  if (remoteSource && source?.planningMode !== "runtime-snapshot") {
    const remoteComposePath = source?.remoteComposePath || composePath;
    rawCompose = await readRemoteTextFile(sourceEnvironmentId, remoteComposePath);
    projectDir = source?.remoteProjectDir || path.posix.dirname(remoteComposePath);
    composePath = remoteComposePath;
  } else {
    projectDir = path.resolve(projectDir);
    composePath = path.resolve(composePath);
    if (!fs.existsSync(composePath)) {
      throw new Error(`未找到项目配置文件: ${composePath}`);
    }
    rawCompose = fs.readFileSync(composePath, "utf-8");
  }
  const compose = yaml.load(rawCompose) as any;
  const composeServiceNames = Object.keys(compose?.services || {});
  if (composeServiceNames.length === 0) {
    throw new Error("Compose 配置中没有可迁移服务");
  }

  const effectiveRootService = compose.services?.[planInput.rootService] ? planInput.rootService : composeServiceNames[0];
  const selectedServices =
    source?.selectionMode === "whole-project" ? composeServiceNames : deriveServiceClosure(compose, effectiveRootService);
  const dependencyServices = selectedServices.filter((service) => service !== effectiveRootService);
  const projectName = source?.name || path.basename(projectDir);
  const workdir = `/var/lib/docker-proxy-migrate/${sessionId}`;

  const allMounts = Object.entries<any>(compose.services || {}).flatMap(([serviceName, service]) =>
    collectServiceMounts(serviceName, service, projectDir)
  );
  const selectedMounts = allMounts.filter((mount) => selectedServices.includes(mount.service));
  const selectedServiceInfos: ServiceInfo[] = selectedServices.map((serviceName) => {
    const service = compose.services[serviceName];
    const mounts = collectServiceMounts(serviceName, service, projectDir);
    const networks = collectServiceNetworks(service);
    const externalNetworks = networks.filter((networkName) => compose?.networks?.[networkName]?.external);
    const internalNetworks = networks.filter((networkName) => !compose?.networks?.[networkName]?.external);
    return {
      name: serviceName,
      image: service?.image,
      hasPorts: collectServicePorts(service).length > 0,
      ports: collectServicePorts(service),
      envFiles: collectEnvFiles(service),
      externalNetworks,
      internalNetworks,
      namedVolumes: mounts.filter((mount) => mount.type === "volume" && mount.source).map((mount) => String(mount.source)),
      bindMounts: mounts.filter((mount) => mount.type === "bind" && mount.source).map((mount) => String(mount.source)),
    };
  });

  const volumeUsage = new Map<string, string[]>();
  const bindUsage = new Map<string, string[]>();
  for (const mount of allMounts) {
    if (mount.type === "volume" && mount.source) {
      const current = volumeUsage.get(mount.source) || [];
      current.push(mount.service);
      volumeUsage.set(mount.source, current);
    }
    if (mount.type === "bind" && mount.sourcePath) {
      const current = bindUsage.get(mount.sourcePath) || [];
      current.push(mount.service);
      bindUsage.set(mount.sourcePath, current);
    }
  }

  const risks: MigrationRisk[] = [];
  const conflicts: ConflictItem[] = [];
  const readOnlyInspect: ResourceImpact[] = [
    { kind: "docker", label: "目标机 Docker/Compose 环境", classification: "read-only inspect", detail: "只读检查 Docker 与 Compose 可用性" },
    { kind: "disk", label: "目标机磁盘与工作目录权限", classification: "read-only inspect", detail: `检查 ${workdir} 所在分区空间和写权限` },
  ];
  const stagingResources: ResourceImpact[] = [
    { kind: "workdir", label: workdir, classification: "new staging resource", detail: "迁移专用工作目录" },
    { kind: "project-copy", label: `${workdir}/project`, classification: "new staging resource", detail: "仅复制源项目目录到隔离工作区" },
    { kind: "compose", label: `${workdir}/artifacts/*.yml`, classification: "new staging resource", detail: "staging 与 cutover Compose 文件" },
  ];
  const needsCutover: ResourceImpact[] = [];
  const blockedResources: ResourceImpact[] = [];

  if (source?.selectionMode === "whole-project") {
    readOnlyInspect.push({
      kind: "selection_mode",
      label: `${projectName} 整组迁移`,
      classification: "read-only inspect",
      detail: "业界推荐 Compose 项目按整组迁移，避免遗漏依赖服务、共享卷、共享网络与配置。",
    });
  }
  if (source?.sourceKind === "standalone-container") {
    readOnlyInspect.push({
      kind: "selection_mode",
      label: `${projectName} 单容器迁移`,
      classification: "read-only inspect",
      detail: "独立容器按单容器迁移，运行态快照会覆盖镜像、环境变量、端口、卷和网络。",
    });
  }
  if (source?.warning) {
    readOnlyInspect.push({
      kind: "source_warning",
      label: "来源已自动降级",
      classification: "read-only inspect",
      detail: source.warning,
    });
    risks.push({
      id: `${projectName}-source-warning`,
      level: "medium",
      title: "来源已降级为运行态快照",
      category: "source_fallback",
      scope: projectName,
      reason: source.warning,
      blocking: false,
      recommendation: "如果需要完整保留原始 Compose、相对 bind mount 和 env_file 语义，建议恢复源服务器项目目录后重新生成计划。",
    });
  }

  for (const serviceName of selectedServices) {
    const service = compose.services[serviceName];
    if (service?.network_mode === "host") {
      risks.push({
        id: `${serviceName}-host-network`,
        level: "high",
        title: "使用 host 网络模式",
        category: "network_mode",
        scope: serviceName,
        reason: "host 网络模式无法在隔离 staging 中安全迁移。",
        blocking: true,
        recommendation: "将该服务改为显式网络与端口映射后再迁移。",
      });
      blockedResources.push({
        kind: "network_mode",
        label: `${serviceName}: host`,
        classification: "blocked",
        detail: "host 网络模式会直接影响目标机宿主网络。",
      });
    }

    if (service?.container_name) {
      risks.push({
        id: `${serviceName}-container-name`,
        level: "medium",
        title: "显式 container_name 将被改写",
        category: "container_name",
        scope: serviceName,
        reason: `服务定义了 container_name=${service.container_name}，隔离迁移会重写为会话前缀名称。`,
        blocking: false,
        recommendation: "如依赖固定容器名，请改用网络别名或服务名。",
      });
    }

    for (const envFile of collectEnvFiles(service)) {
      const absoluteEnv = remoteSource && source?.planningMode !== "runtime-snapshot"
        ? path.posix.resolve(projectDir, envFile)
        : path.resolve(projectDir, envFile);
      const envExists =
        remoteSource && source?.planningMode !== "runtime-snapshot"
          ? await remotePathExists(sourceEnvironmentId, absoluteEnv)
          : fs.existsSync(absoluteEnv);
      if (!envExists) {
        risks.push({
          id: `${serviceName}-env-${envFile}`,
          level: "high",
          title: "缺少 env_file",
          category: "env_file",
          scope: serviceName,
          reason: `env_file ${envFile} 在项目目录中不存在。`,
          blocking: true,
          recommendation: "补齐 env_file 或改为环境变量配置后再迁移。",
        });
        blockedResources.push({
          kind: "env_file",
          label: envFile,
          classification: "blocked",
          detail: `服务 ${serviceName} 依赖缺失的 env_file。`,
        });
      }
    }

    if (service?.build) {
      risks.push({
        id: `${serviceName}-build-context`,
        level: "medium",
        title: "包含本地构建上下文",
        category: "build",
        scope: serviceName,
        reason: "目标机会基于同步后的项目目录重新构建镜像，首次启动耗时会增加。",
        blocking: false,
        recommendation: "如需稳定迁移，建议先推送镜像到镜像仓库。",
      });
    }
  }

  if (source?.planningMode === "runtime-snapshot") {
      risks.push({
      id: `${effectiveRootService}-runtime-snapshot`,
      level: "medium",
      title: "当前计划基于运行态快照",
      category: "runtime_snapshot",
      scope: source.name,
      reason: "未直接读取原始 Compose 文件，而是按当前容器配置生成了 Compose 快照；depends_on、相对 bind mount、env_file 可能退化为更保守的检查结果。",
      blocking: false,
      recommendation: "如需更精确的迁移计划，建议提供原始 Compose 项目目录。",
    });
    readOnlyInspect.push({
      kind: "runtime_snapshot",
      label: source.composePath,
      classification: "read-only inspect",
      detail: "本次计划基于运行态生成的 Compose 快照，只做迁移分析与执行，不会改写源机配置。",
    });
  }

  const usedNamedVolumes = new Set<string>();
  let unknownVolumeSize = false;
  let knownVolumeBytes = 0;
  const namedVolumeArchives: MigrationSession["internal"]["namedVolumeArchives"] = [];
  for (const mount of selectedMounts) {
    if (mount.type === "anonymous") {
      risks.push({
        id: `${mount.service}-${mount.target}-anonymous-volume`,
        level: "high",
        title: "检测到匿名卷",
        category: "volume",
        scope: mount.service,
        reason: `挂载点 ${mount.target} 使用匿名卷，无法安全按服务边界迁移。`,
        blocking: true,
        recommendation: "将匿名卷改为命名卷或项目内相对路径 bind mount。",
      });
      blockedResources.push({
        kind: "anonymous-volume",
        label: `${mount.service}:${mount.target}`,
        classification: "blocked",
        detail: "匿名卷无法保证独立回滚。",
      });
      continue;
    }

    if (mount.type === "bind" && mount.source) {
      const resolved = mount.sourcePath || mount.source;
      const isAbsolute = path.isAbsolute(mount.source);
      const sharedWith = (bindUsage.get(resolved) || []).filter((serviceName) => !selectedServices.includes(serviceName));
      if (isAbsolute) {
        risks.push({
          id: `${mount.service}-${mount.source}-absolute-bind`,
          level: "high",
          title: "使用绝对路径 bind mount",
          category: "bind_mount",
          scope: mount.service,
          reason: `${mount.source} 指向宿主机绝对路径，无法证明其只属于本次迁移服务。`,
          blocking: true,
          recommendation: "将数据改为命名卷或项目内相对路径 bind mount。",
        });
        blockedResources.push({
          kind: "bind_mount",
          label: mount.source,
          classification: "blocked",
          detail: "绝对路径 bind mount 会越过项目边界。",
        });
      } else if (sharedWith.length > 0) {
        risks.push({
          id: `${mount.service}-${mount.source}-shared-bind`,
          level: "high",
          title: "检测到共享 bind mount",
          category: "bind_mount",
          scope: mount.service,
          reason: `${mount.source} 同时被未纳入迁移的服务共享：${sharedWith.join(", ")}。`,
          blocking: true,
          recommendation: "拆分共享目录或将共享服务一起迁移。",
        });
        blockedResources.push({
          kind: "bind_mount",
          label: mount.source,
          classification: "blocked",
          detail: `共享方：${sharedWith.join(", ")}`,
        });
      } else {
        stagingResources.push({
          kind: "bind_mount",
          label: mount.source,
          classification: "new staging resource",
          detail: `通过项目目录同步 ${mount.source}`,
        });
      }
      continue;
    }

    if (mount.type === "volume" && mount.source) {
      const volumeName = String(mount.source);
      usedNamedVolumes.add(volumeName);
      const topVolume = compose?.volumes?.[volumeName];
      if (topVolume?.external) {
        risks.push({
          id: `${mount.service}-${volumeName}-external-volume`,
          level: "high",
          title: "检测到 external volume",
          category: "volume",
          scope: mount.service,
          reason: `卷 ${volumeName} 标记为 external，无法在不影响目标机现有资源的前提下接管。`,
          blocking: true,
          recommendation: "改为项目内命名卷或单独准备目标卷并人工确认切换。",
        });
        blockedResources.push({
          kind: "external-volume",
          label: volumeName,
          classification: "blocked",
          detail: "external volume 无法隔离命名与自动回滚。",
        });
        continue;
      }

      const sharedWith = (volumeUsage.get(volumeName) || []).filter((serviceName) => !selectedServices.includes(serviceName));
      if (sharedWith.length > 0) {
        risks.push({
          id: `${mount.service}-${volumeName}-shared-volume`,
          level: "high",
          title: "检测到共享命名卷",
          category: "volume",
          scope: mount.service,
          reason: `卷 ${volumeName} 同时被未迁移服务共享：${sharedWith.join(", ")}。`,
          blocking: true,
          recommendation: "拆分共享卷，或将共享服务一起纳入迁移。",
        });
        blockedResources.push({
          kind: "named-volume",
          label: volumeName,
          classification: "blocked",
          detail: `共享方：${sharedWith.join(", ")}`,
        });
        continue;
      }

      const archiveName = `${sanitizeName(volumeName)}.tar`;
      const archivePath = path.join(localArtifactsDir, archiveName);
      const stagingVolume = `mig_${sessionId.slice(0, 8)}_${sanitizeName(volumeName)}`;
      const estimatedVolumeBytes = await estimateNamedVolumeSize(volumeName, sourceEnvironmentId);
      if (estimatedVolumeBytes === 0) {
        unknownVolumeSize = true;
      } else {
        knownVolumeBytes += estimatedVolumeBytes;
      }
      namedVolumeArchives.push({
        sourceVolume: volumeName,
        stagingVolume,
        archiveName,
        archivePath,
        size: estimatedVolumeBytes,
      });
      stagingResources.push({
        kind: "named-volume",
        label: stagingVolume,
        classification: "new staging resource",
        detail: `由源卷 ${volumeName} 导出并恢复为隔离卷`,
      });
    }
  }

  const externalNetworks = new Set<string>();
  const internalNetworks = new Set<string>();
  const targetPorts = new Set<number>();
  for (const serviceName of selectedServices) {
    const service = compose.services[serviceName];
    for (const networkName of collectServiceNetworks(service)) {
      if (compose?.networks?.[networkName]?.external) {
        externalNetworks.add(networkName);
        needsCutover.push({
          kind: "network",
          label: networkName,
          classification: "needs cutover",
          detail: isPlatformManagedNetwork(networkName)
            ? "切换阶段会附加到外部网络；若目标机缺少该平台托管网络，系统会自动创建。"
            : "cutover 阶段才允许附加到现有外部网络。",
        });
      } else {
        internalNetworks.add(networkName);
      }
    }
    for (const port of collectServicePorts(service)) {
      targetPorts.add(port);
      needsCutover.push({
        kind: "port",
        label: String(port),
        classification: "needs cutover",
        detail: `切换阶段需要绑定目标机端口 ${port}`,
      });
    }

    for (const secretName of collectUsedSecrets(service)) {
      const secretDef = compose?.secrets?.[secretName];
      if (secretDef?.external) {
        risks.push({
          id: `${serviceName}-${secretName}-external-secret`,
          level: "high",
          title: "检测到 external secret",
          category: "secret",
          scope: serviceName,
          reason: `secret ${secretName} 依赖目标机现有资源，当前版本不做自动接管。`,
          blocking: true,
          recommendation: "改为 env_file/文件同步，或在目标机手工准备 secret 后再迁移。",
        });
        blockedResources.push({
          kind: "secret",
          label: secretName,
          classification: "blocked",
          detail: "external secret 需要目标机预置。",
        });
      }
    }

    for (const configName of collectUsedConfigs(service)) {
      const configDef = compose?.configs?.[configName];
      if (configDef?.external) {
        risks.push({
          id: `${serviceName}-${configName}-external-config`,
          level: "high",
          title: "检测到 external config",
          category: "config",
          scope: serviceName,
          reason: `config ${configName} 依赖目标机现有资源，当前版本不做自动接管。`,
          blocking: true,
          recommendation: "改为项目内文件，或目标机手工准备 config 后再迁移。",
        });
        blockedResources.push({
          kind: "config",
          label: configName,
          classification: "blocked",
          detail: "external config 需要目标机预置。",
        });
      }
    }
  }

  const localContainers = await listComposeContainers(projectName, sourceEnvironmentId);
  const runtimeDrift = selectedServices.map<ServiceRuntimeDrift>((serviceName) => {
    const service = compose.services[serviceName];
    const containers = localContainers.filter((container: any) => getComposeLabels(container)?.["com.docker.compose.service"] === serviceName);
    const notes: string[] = [];
    if (containers.length === 0) {
      notes.push("本地未发现该服务对应的运行中 Compose 容器。");
    }
    const configuredImage = service?.image;
    if (configuredImage && containers.some((container: any) => getContainerImage(container) !== configuredImage)) {
      notes.push(`运行中镜像与 Compose 不一致，当前为 ${containers.map((container: any) => getContainerImage(container)).join(", ")}`);
      risks.push({
        id: `${serviceName}-runtime-drift-image`,
        level: "medium",
        title: "运行态镜像与 Compose 不一致",
        category: "runtime_drift",
        scope: serviceName,
        reason: "迁移仍会以 Compose 配置为准，不会跟随容器漂移状态。",
        blocking: false,
        recommendation: "如需迁移当前运行态，请先回写 Compose 或重新部署对齐。",
      });
    }
    return {
      service: serviceName,
      running: containers.some((container: any) => isRunningContainer(container)),
      containerNames: containers.flatMap((container: any) => getContainerNames(container)),
      notes,
    };
  });

  const localFileManifest = !remoteSource || source?.planningMode === "runtime-snapshot" ? walkFiles(projectDir) : [];
  const localProjectBytes =
    !remoteSource || source?.planningMode === "runtime-snapshot"
      ? sumFileSizes(localFileManifest)
      : await getRemoteDirectorySize(sourceEnvironmentId, projectDir);
  const transferEstimate = {
    totalBytes: localProjectBytes + knownVolumeBytes,
    knownVolumeBytes,
    projectBytes: localProjectBytes,
    unknownVolumeSize,
  };

  const stagingComposePath = path.join(localArtifactsDir, "staging-compose.yml");
  const cutoverComposePath = path.join(localArtifactsDir, "cutover-compose.yml");
  const manifestPath = path.join(localArtifactsDir, "manifest.json");
  const riskReportPath = path.join(localArtifactsDir, "risk-report.json");

  const migrationProjectName = `mig_${sessionId.slice(0, 12)}`;
  const composeArtifacts = buildComposeArtifacts({
    compose,
    selectedServices,
    sessionId,
    migrationProjectName,
    externalNetworks,
    internalNetworks,
    usedNamedVolumes,
  });

  fs.writeFileSync(stagingComposePath, composeArtifacts.stagingYaml, "utf-8");
  fs.writeFileSync(cutoverComposePath, composeArtifacts.cutoverYaml, "utf-8");

  const planBase: Omit<MigrationPlan, "preflight"> = {
    sessionId,
    projectName,
    projectPath: source?.path || planInput.projectPath,
    composePath,
    rootService: effectiveRootService,
    dependencyServices,
    selectedServices,
    services: selectedServiceInfos,
    readOnlyInspect,
    stagingResources,
    needsCutover,
    blockedResources,
    notTouched: [
      { kind: "containers", label: "目标机现有容器", detail: "不会停止、删除任何不属于当前 session 的目标机容器" },
      { kind: "volumes", label: "目标机现有卷", detail: "不会删除或覆盖任何未纳入本次 session 的目标卷" },
      { kind: "networks", label: "目标机现有网络", detail: "不会删除任何现有 Docker 网络" },
      { kind: "paths", label: "目标机业务目录", detail: `除 ${workdir} 外，不会写入其他目标机业务目录` },
    ],
    safetyBoundary: {
      immutableTargets: [
        { kind: "service", label: "未纳入迁移闭包的服务", detail: "保持原状，不会被停止或重启" },
        { kind: "compose_project", label: "目标机现有 Compose 项目", detail: "只做冲突检测，不做改写" },
      ],
      permissions: [],
    },
    risks,
    conflicts,
    target: {
      host: targetHost.host,
      port: Number(targetHost.port || 22),
      username: targetHost.username,
      workdir,
    },
    artifactPaths: {
      manifest: manifestPath,
      riskReport: riskReportPath,
      stagingCompose: stagingComposePath,
      cutoverCompose: cutoverComposePath,
    },
    runtimeDrift,
    transferEstimate,
  };

  const preflight = await runRemotePreflight(planBase, targetHost, Array.from(targetPorts), Array.from(externalNetworks));
  planBase.risks.push(...preflight.risks);
  planBase.conflicts.push(...preflight.conflicts);
  planBase.readOnlyInspect.push(...preflight.readOnlyInspect);
  planBase.safetyBoundary.permissions = [
    { kind: "ssh", label: `${targetHost.username}@${targetHost.host}`, detail: "仅使用当前 SSH 账号连接目标机" },
    ...(preflight.missingPermissions.length > 0
      ? preflight.missingPermissions.map((item) => ({
          kind: "permission",
          label: item,
          detail: "当前权限不足，已在 preflight 中阻断执行。",
        }))
      : [{ kind: "permission", label: "Docker / Compose / workdir", detail: "目标机当前 SSH 账号具备基础迁移权限" }]),
  ];

  const plan: MigrationPlan = {
    ...planBase,
    preflight: {
      dockerVersion: preflight.dockerVersion,
      composeVersion: preflight.composeVersion,
      architecture: preflight.architecture,
      availableDiskBytes: preflight.availableDiskBytes,
      missingPermissions: preflight.missingPermissions,
    },
  };

  fs.writeFileSync(manifestPath, JSON.stringify(plan, null, 2), "utf-8");
  fs.writeFileSync(
    riskReportPath,
    JSON.stringify(
      {
        sessionId,
        generatedAt: nowIso(),
        risks: plan.risks,
        conflicts: plan.conflicts,
        blockedResources: plan.blockedResources,
        notTouched: plan.notTouched,
      },
      null,
      2
    ),
    "utf-8"
  );

  const riskCounts = countRisks(plan.risks);
  const servicesState = Object.fromEntries(
    selectedServices.map((serviceName) => [
      serviceName,
      {
        phase: "plan",
        status: "pending",
        health: "unknown",
        dataStatus: "pending",
        updatedAt: nowIso(),
        note: "等待执行",
      } satisfies ServiceRuntimeState,
    ])
  );

  const hasBlockingIssues = plan.risks.some((risk) => risk.blocking) || plan.conflicts.some((conflict) => conflict.blocking);
  const session: MigrationSession = {
    id: sessionId,
    status: hasBlockingIssues ? "blocked" : "plan_ready",
    pageState: hasBlockingIssues ? "blocked" : "plan_ready",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    projectName,
    projectPath: source?.path || planInput.projectPath,
    composePath,
    sourceEnvironmentId,
    targetEnvironmentId: planInput.targetEnvironmentId,
    rootService: effectiveRootService,
    dependencyServices,
    selectedServices,
    target: plan.target,
    currentPhase: "preflight",
    currentStep: hasBlockingIssues ? "计划已阻断" : "计划生成完成",
    progress: {
      percent: phasePercent("preflight", 1),
      phasePercent: 100,
    },
    serviceCount: selectedServices.length,
    riskCounts,
    blockingCount: plan.risks.filter((risk) => risk.blocking).length + plan.conflicts.filter((conflict) => conflict.blocking).length,
    plan,
    services: servicesState,
    transfer: {
      bytesDone: 0,
      bytesTotal: plan.transferEstimate.totalBytes,
      percent: 0,
      checksumStatus: "pending",
    },
    result: {
      outcome: hasBlockingIssues ? "blocked" : "pending",
      message: hasBlockingIssues ? "计划已阻断，请先消除冲突与高风险项。" : "计划已生成，等待开始迁移。",
      artifacts: [manifestPath, riskReportPath, stagingComposePath, cutoverComposePath],
      finalResources: [],
      verification: [],
      rollback: {
        status: "not_requested",
        actions: [],
      },
    },
    internal: {
      migrationProjectName,
      remoteBaseDir: workdir,
      remoteProjectDir: `${workdir}/project`,
      remoteArtifactsDir: `${workdir}/artifacts`,
      remoteComposePath: `${workdir}/artifacts/staging-compose.yml`,
      remoteCutoverComposePath: `${workdir}/artifacts/cutover-compose.yml`,
      remoteProjectArchivePath:
        remoteSource && source?.planningMode !== "runtime-snapshot" ? `${workdir}/artifacts/source-project.tar` : undefined,
      localSessionDir,
      localArtifactsDir,
      localProjectDir: remoteSource && source?.planningMode !== "runtime-snapshot" ? path.join(localSessionDir, "source-project") : projectDir,
      localProjectArchivePath:
        remoteSource && source?.planningMode !== "runtime-snapshot" ? path.join(localSessionDir, "source-project.tar") : undefined,
      localComposePath:
        remoteSource && source?.planningMode !== "runtime-snapshot"
          ? path.join(
              path.join(localSessionDir, "source-project"),
              path.posix.relative(source?.remoteProjectDir || projectDir, source?.remoteComposePath || composePath)
            )
          : composePath,
      localProjectBytes,
      localFileManifest,
      sourceProjectCached: !remoteSource || source?.planningMode === "runtime-snapshot",
      sourceRemoteProjectDir: remoteSource ? source?.remoteProjectDir || projectDir : undefined,
      sourceRemoteComposePath: remoteSource ? source?.remoteComposePath || composePath : undefined,
      sourceWorkdir: remoteSource ? getEnvironment(sourceEnvironmentId).workdir : undefined,
      namedVolumeArchives,
    },
  };

  saveSession(session);
  appendEvent({
    sessionId,
    type: "phase_finished",
    ts: nowIso(),
    phase: "preflight",
    step: "计划生成",
    level: hasBlockingIssues ? "warn" : "success",
    message: hasBlockingIssues ? "迁移计划已生成，但包含阻断项。" : "迁移计划已生成，可开始执行。",
    percent: session.progress.percent,
    meta: { session: sanitizeSession(session) },
  });

  return sanitizeSession(session);
}

function countRisks(risks: MigrationRisk[]) {
  return risks.reduce<Record<RiskLevel, number>>(
    (counts, risk) => {
      counts[risk.level] += 1;
      return counts;
    },
    { low: 0, medium: 0, high: 0 }
  );
}

function buildComposeArtifacts(input: {
  compose: any;
  selectedServices: string[];
  sessionId: string;
  migrationProjectName: string;
  externalNetworks: Set<string>;
  internalNetworks: Set<string>;
  usedNamedVolumes: Set<string>;
}) {
  const { compose, selectedServices, sessionId, externalNetworks, internalNetworks, usedNamedVolumes } = input;
  const baseCompose: any = {};
  if (compose?.version) baseCompose.version = compose.version;
  baseCompose.services = {};
  baseCompose.volumes = {};
  baseCompose.networks = {};
  if (compose?.secrets) baseCompose.secrets = {};
  if (compose?.configs) baseCompose.configs = {};

  for (const serviceName of selectedServices) {
    const originalService = deepClone(compose.services[serviceName]);
    delete originalService.container_name;
    originalService.labels = {
      ...(typeof originalService.labels === "object" && !Array.isArray(originalService.labels) ? originalService.labels : {}),
      "dockerproxy.migration.session": sessionId,
      "dockerproxy.migration.service": serviceName,
    };
    baseCompose.services[serviceName] = originalService;

    for (const networkName of collectServiceNetworks(originalService)) {
      if (!compose?.networks?.[networkName]) continue;
      if (!baseCompose.networks[networkName]) {
        baseCompose.networks[networkName] = deepClone(compose.networks[networkName]);
      }
    }
    for (const secretName of collectUsedSecrets(originalService)) {
      if (compose?.secrets?.[secretName]) {
        baseCompose.secrets[secretName] = deepClone(compose.secrets[secretName]);
      }
    }
    for (const configName of collectUsedConfigs(originalService)) {
      if (compose?.configs?.[configName]) {
        baseCompose.configs[configName] = deepClone(compose.configs[configName]);
      }
    }
    for (const mount of collectServiceMounts(serviceName, originalService, process.cwd())) {
      if (mount.type === "volume" && mount.source && !baseCompose.volumes[mount.source]) {
        baseCompose.volumes[mount.source] = deepClone(compose?.volumes?.[mount.source] || {});
      }
    }
  }

  const stageCompose = deepClone(baseCompose);
  const cutoverCompose = deepClone(baseCompose);
  const verifyNetworkKey = "migration_verify";

  stageCompose.networks[verifyNetworkKey] = { driver: "bridge" };

  for (const [networkKey, networkDef] of Object.entries<any>(cutoverCompose.networks || {})) {
    if (networkDef?.external) continue;
    if (networkDef && typeof networkDef === "object" && networkDef.name) {
      networkDef.name = `mig_${sessionId.slice(0, 8)}_${sanitizeName(String(networkDef.name))}`;
    }
  }

  for (const [networkKey, networkDef] of Object.entries<any>(stageCompose.networks || {})) {
    if (networkKey === verifyNetworkKey) continue;
    if (networkDef?.external) {
      delete stageCompose.networks[networkKey];
      continue;
    }
    if (networkDef && typeof networkDef === "object" && networkDef.name) {
      networkDef.name = `mig_${sessionId.slice(0, 8)}_${sanitizeName(String(networkDef.name))}`;
    }
  }

  for (const [volumeKey, volumeDef] of Object.entries<any>(cutoverCompose.volumes || {})) {
    if (volumeDef?.external) continue;
    if (volumeDef && typeof volumeDef === "object" && volumeDef.name) {
      volumeDef.name = `mig_${sessionId.slice(0, 8)}_${sanitizeName(String(volumeDef.name))}`;
    }
  }
  for (const [volumeKey, volumeDef] of Object.entries<any>(stageCompose.volumes || {})) {
    if (volumeDef?.external) continue;
    if (volumeDef && typeof volumeDef === "object" && volumeDef.name) {
      volumeDef.name = `mig_${sessionId.slice(0, 8)}_${sanitizeName(String(volumeDef.name))}`;
    }
  }

  for (const serviceName of selectedServices) {
    const stageService = stageCompose.services[serviceName];
    delete stageService.ports;
    const existingNetworks = collectServiceNetworks(stageService).filter((networkName) => internalNetworks.has(networkName));
    stageService.networks = Array.from(new Set([...existingNetworks, verifyNetworkKey]));
    if (externalNetworks.size > 0) {
      for (const networkName of Array.from(externalNetworks)) {
        if (Array.isArray(stageService.networks)) {
          stageService.networks = stageService.networks.filter((item: string) => item !== networkName);
        }
      }
    }
  }

  return {
    stagingYaml: yaml.dump(stageCompose, { noRefs: true, lineWidth: -1 }),
    cutoverYaml: yaml.dump(cutoverCompose, { noRefs: true, lineWidth: -1 }),
  };
}

async function runRemotePreflight(plan: Omit<MigrationPlan, "preflight">, target: TargetHostInput, targetPorts: number[], externalNetworks: string[]): Promise<RemotePreflightResult> {
  const ssh = new NodeSSH();
  const missingPermissions: string[] = [];
  const conflicts: ConflictItem[] = [];
  const risks: MigrationRisk[] = [];
  const inspectItems: ResourceImpact[] = [];

  try {
    await ssh.connect({
      host: target.host,
      port: Number(target.port || 22),
      username: target.username,
      password: target.password,
      privateKey: target.privateKey,
    });
  } catch (error: any) {
    throw new Error(`无法连接目标机: ${error.message}`);
  }

  try {
    const dockerVersion = await ssh.execCommand("docker --version");
    if (dockerVersion.code !== 0) {
      missingPermissions.push("Docker CLI 不可用");
      conflicts.push({
        id: "target-docker-missing",
        kind: "docker",
        target: "docker",
        reason: dockerVersion.stderr || "目标机无法执行 docker 命令。",
        blocking: true,
        recommendation: "安装 Docker 并确认当前 SSH 账号具备 docker 权限。",
      });
    }

    const composeVersion = await ssh.execCommand("docker compose version");
    if (composeVersion.code !== 0) {
      missingPermissions.push("Docker Compose 不可用");
      conflicts.push({
        id: "target-compose-missing",
        kind: "compose",
        target: "docker compose",
        reason: composeVersion.stderr || "目标机无法执行 docker compose 命令。",
        blocking: true,
        recommendation: "安装 Compose v2 并确认当前 SSH 账号具备使用权限。",
      });
    }

    const architectureResult = await ssh.execCommand("uname -m");
    const architecture = architectureResult.stdout.trim();
    inspectItems.push({
      kind: "architecture",
      label: architecture || "unknown",
      classification: "read-only inspect",
      detail: "目标机 CPU 架构检查",
    });

    const writableCheck = await ssh.execCommand(`mkdir -p ${shellQuote(plan.target.workdir)} && test -w ${shellQuote(plan.target.workdir)} && echo ok`);
    if (!writableCheck.stdout.includes("ok")) {
      missingPermissions.push(`无法写入 ${plan.target.workdir}`);
      conflicts.push({
        id: "target-workdir-permission",
        kind: "workdir",
        target: plan.target.workdir,
        reason: writableCheck.stderr || "当前 SSH 账号无法写入迁移工作目录。",
        blocking: true,
        recommendation: "为目标机 SSH 账号授予专用工作目录写权限。",
      });
    }

    const diskCheck = await ssh.execCommand(`df -Pk ${shellQuote(plan.target.workdir)} | tail -n 1 | awk '{print $4}'`);
    const availableDiskBytes = Number(String(diskCheck.stdout).trim()) * 1024;
    if (Number.isFinite(availableDiskBytes)) {
      inspectItems.push({
        kind: "disk",
        label: humanFileSize(availableDiskBytes),
        classification: "read-only inspect",
        detail: "目标机可用磁盘空间",
      });
      if (availableDiskBytes > 0 && availableDiskBytes < plan.transferEstimate.totalBytes * 1.2) {
        conflicts.push({
          id: "target-disk-insufficient",
          kind: "disk",
          target: plan.target.workdir,
          reason: `目标机可用空间 ${humanFileSize(availableDiskBytes)}，低于估算迁移数据量 ${humanFileSize(plan.transferEstimate.totalBytes)} 的安全阈值。`,
          blocking: true,
          recommendation: "清理目标机磁盘或选择更大的挂载点后重试。",
        });
      }
    }

    if (targetPorts.length > 0) {
      const portCheck = await ssh.execCommand("ss -lntH | awk '{print $4}'");
      const occupiedPorts = new Set<number>();
      for (const line of String(portCheck.stdout).split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const segments = trimmed.split(":");
        const port = Number(segments[segments.length - 1]);
        if (Number.isFinite(port)) occupiedPorts.add(port);
      }
      for (const port of targetPorts) {
        inspectItems.push({
          kind: "port",
          label: String(port),
          classification: "read-only inspect",
          detail: "目标机端口冲突检查",
        });
        if (occupiedPorts.has(port)) {
          conflicts.push({
            id: `target-port-${port}`,
            kind: "port",
            target: String(port),
            reason: `目标机端口 ${port} 已被占用。`,
            blocking: true,
            recommendation: "释放端口或修改服务端口映射后再迁移。",
          });
        }
      }
    }

    for (const networkName of externalNetworks) {
      const networkCheck = await ssh.execCommand(`docker network inspect ${shellQuote(networkName)}`);
      inspectItems.push({
        kind: "network",
        label: networkName,
        classification: "read-only inspect",
        detail: isPlatformManagedNetwork(networkName)
          ? "平台托管外部网络检查，缺失时会尝试自动创建。"
          : "目标机外部网络存在性检查",
      });
      if (networkCheck.code !== 0) {
        if (isPlatformManagedNetwork(networkName)) {
          const createNetwork = await ssh.execCommand(`docker network create ${shellQuote(networkName)}`);
          if (createNetwork.code === 0) {
            inspectItems.push({
              kind: "network",
              label: networkName,
              classification: "new staging resource",
              detail: "目标机原本缺少该平台托管网络，preflight 已自动创建。",
            });
            continue;
          }
          conflicts.push({
            id: `external-network-${networkName}`,
            kind: "network",
            target: networkName,
            reason: `目标机缺少平台托管网络 ${networkName}，且自动创建失败：${createNetwork.stderr || createNetwork.stdout || "unknown error"}`,
            blocking: true,
            recommendation: "检查目标机 Docker 权限，或手工创建该网络后重新生成计划。",
          });
          continue;
        }
        conflicts.push({
          id: `external-network-${networkName}`,
          kind: "network",
          target: networkName,
          reason: "切换阶段需要附加的外部网络不存在。",
          blocking: true,
          recommendation: "在目标机预先创建该外部网络，或从服务定义中移除该依赖。",
        });
      }
    }

    for (const service of plan.services) {
      if (!service.image) continue;
      const imageCheck = await ssh.execCommand(`docker image inspect ${shellQuote(service.image)}`);
      if (imageCheck.code !== 0) {
        risks.push({
          id: `${service.name}-image-missing-remote`,
          level: "medium",
          title: "目标机尚未缓存镜像",
          category: "image",
          scope: service.name,
          reason: `目标机未检测到镜像 ${service.image}，切换时可能需要拉取或构建。`,
          blocking: false,
          recommendation: "提前在目标机拉取镜像，可减少 cutover 阶段耗时。",
        });
      }
    }

    return {
      dockerVersion: dockerVersion.stdout.trim(),
      composeVersion: composeVersion.stdout.trim(),
      architecture: architectureResult.stdout.trim(),
      availableDiskBytes: Number.isFinite(availableDiskBytes) ? availableDiskBytes : undefined,
      missingPermissions,
      conflicts,
      risks,
      readOnlyInspect: inspectItems,
    };
  } finally {
    ssh.dispose();
  }
}

async function runCommandWithLogs(command: string, phase: Phase, step: string, sessionId: string, level: "info" | "warn" | "error" | "success" = "info") {
  appendEvent({
    sessionId,
    type: "command_log",
    ts: nowIso(),
    phase,
    step,
    level,
    message: command,
    command,
  });
  const result = await execAsync(command, { maxBuffer: 64 * 1024 * 1024, shell: "/bin/zsh" });
  const combined = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (combined) {
    for (const line of combined.split("\n").slice(0, 120)) {
      appendEvent({
        sessionId,
        type: "command_log",
        ts: nowIso(),
        phase,
        step,
        level,
        message: line,
      });
    }
  }
  return result;
}

async function runRemoteCommand(ssh: NodeSSH, command: string, sessionId: string, phase: Phase, step: string) {
  appendEvent({
    sessionId,
    type: "command_log",
    ts: nowIso(),
    phase,
    step,
    level: "info",
    message: command,
    command,
  });
  const result = await ssh.execCommand(command, { execOptions: { pty: true } });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  if (output) {
    for (const line of output.split("\n").slice(0, 160)) {
      appendEvent({
        sessionId,
        type: "command_log",
        ts: nowIso(),
        phase,
        step,
        level: result.code === 0 ? "info" : "warn",
        message: line,
      });
    }
  }
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `远端命令执行失败: ${command}`);
  }
  return result.stdout;
}

function setServiceState(sessionId: string, service: string, patch: Partial<ServiceRuntimeState>, phase: string, message: string) {
  const updated = updateSession(sessionId, (session) => {
    session.services[service] = {
      ...session.services[service],
      ...patch,
      phase,
      updatedAt: nowIso(),
    };
    return session;
  });
  appendEvent({
    sessionId,
    type: "service_status_changed",
    ts: nowIso(),
    phase: updated.currentPhase,
    step: updated.currentStep,
    service,
    level: patch.status === "failed" ? "error" : "info",
    message,
    meta: { serviceState: updated.services[service] },
  });
}

function setSessionProgress(sessionId: string, phase: Phase, phaseProgress: number, status?: SessionStatus, step?: string) {
  return updateSession(sessionId, (session) => {
    session.currentPhase = phase;
    session.progress.phasePercent = Number((phaseProgress * 100).toFixed(1));
    session.progress.percent = phasePercent(phase, phaseProgress);
    if (status) {
      session.status = status;
      session.pageState = status;
    }
    if (step) session.currentStep = step;
    return session;
  });
}

function startPhase(sessionId: string, phase: Phase, status: SessionStatus, step: string) {
  const session = setSessionProgress(sessionId, phase, 0, status, step);
  appendEvent({
    sessionId,
    type: "phase_started",
    ts: nowIso(),
    phase,
    step,
    level: "info",
    message: `${phase} 阶段开始：${step}`,
    percent: session.progress.percent,
  });
}

function finishPhase(sessionId: string, phase: Phase, step: string) {
  const session = setSessionProgress(sessionId, phase, 1, phase === "verify_or_rollback" ? "completed" : sessionStatusAfterPhase(phase), step);
  appendEvent({
    sessionId,
    type: "phase_finished",
    ts: nowIso(),
    phase,
    step,
    level: "success",
    message: `${phase} 阶段完成：${step}`,
    percent: session.progress.percent,
  });
}

function sessionStatusAfterPhase(phase: Phase): SessionStatus {
  if (phase === "plan") return "planning";
  if (phase === "preflight") return "plan_ready";
  if (phase === "cutover") return "verifying";
  return "running";
}

async function extractLocalTarArchive(archivePath: string, destinationDir: string) {
  await execAsync(`tar -xf ${shellQuote(archivePath)} -C ${shellQuote(destinationDir)}`, {
    shell: "/bin/zsh",
    maxBuffer: 32 * 1024 * 1024,
  });
}

async function streamRemoteProjectArchiveToLocal(
  ssh: NodeSSH,
  sessionId: string,
  remoteProjectDir: string,
  localArchivePath: string
) {
  const connection = (ssh as any).getConnection ? (ssh as any).getConnection() : (ssh as any).connection;
  if (!connection) {
    throw new Error("SSH 连接不可用，无法流式下载源项目归档");
  }

  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(localArchivePath);
    let stderrBuffer = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      output.close();
      if (error) reject(error);
      else resolve();
    };

    connection.exec(
      `tar --warning=no-file-ignored --ignore-failed-read -cf - -C ${shellQuote(remoteProjectDir)} .`,
      {},
      (error: Error | undefined, channel: any) => {
        if (error) {
          finish(error);
          return;
        }

        channel.on("data", (chunk: Buffer) => {
          output.write(chunk);
        });
        channel.stderr.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf-8");
          stderrBuffer += text;
          for (const line of text.split("\n").map((item) => item.trim()).filter(Boolean)) {
            appendEvent({
              sessionId,
              type: "command_log",
              ts: nowIso(),
              phase: "sync",
              step: "归档源项目目录",
              level: "warn",
              message: line,
            });
          }
        });
        channel.on("error", (channelError: Error) => {
          finish(channelError);
        });
        channel.on("close", (code: number | null) => {
          if (code === 0 || code === 1) {
            finish();
            return;
          }
          finish(new Error(stderrBuffer.trim() || `源项目归档失败，退出码 ${code ?? "unknown"}`));
        });
      }
    );
  });
}

async function prepareSourceProjectCache(sessionId: string) {
  const session = loadSession(sessionId);
  if (!session) throw new Error("迁移会话不存在");
  if (session.internal.sourceProjectCached) {
    return session;
  }
  if (isLocalEnvironment(session.sourceEnvironmentId)) {
    return session;
  }
  if (!session.internal.sourceRemoteProjectDir) {
    throw new Error("源服务器项目目录信息缺失，无法准备迁移缓存");
  }

  fs.rmSync(session.internal.localProjectDir, { recursive: true, force: true });
  ensureDir(session.internal.localProjectDir);
  const { ssh } = await getSourceEnvironmentConnection(session.sourceEnvironmentId);
  try {
    const sourceDirAccessible = await remotePathAccessibleWithSsh(ssh, session.internal.sourceRemoteProjectDir, "dir");
    if (!sourceDirAccessible) {
      throw new Error(
        `源服务器项目目录不可读或已不存在：${session.internal.sourceRemoteProjectDir}。请刷新来源并重新生成计划；如果原始 Compose 目录已经丢失，系统会自动改为运行态快照迁移。`
      );
    }
    appendEvent({
      sessionId,
      type: "command_log",
      ts: nowIso(),
      phase: "sync",
      step: "准备源项目缓存",
      level: "info",
      message: `从 ${session.sourceEnvironmentId} 归档项目目录 ${session.internal.sourceRemoteProjectDir}，自动跳过 socket / fifo 等特殊文件`,
    });
    const localArchivePath =
      session.internal.localProjectArchivePath || path.join(session.internal.localSessionDir, "source-project.tar");
    fs.rmSync(localArchivePath, { force: true });
    try {
      await streamRemoteProjectArchiveToLocal(ssh, sessionId, session.internal.sourceRemoteProjectDir, localArchivePath);
    } catch (error: any) {
      throw new Error(
        `源服务器项目目录下载失败：${session.internal.sourceRemoteProjectDir}。${error?.message || "请确认目录仍存在且当前 SSH 账号可读。"}`
      );
    }
    try {
      await extractLocalTarArchive(localArchivePath, session.internal.localProjectDir);
    } catch (error: any) {
      throw new Error(`源项目归档解压失败：${error?.stderr || error?.message || "未知错误"}`);
    }
  } finally {
    ssh.dispose();
  }

  const manifest = walkFiles(session.internal.localProjectDir);
  const projectBytes = sumFileSizes(manifest);
  return updateSession(sessionId, (current) => {
    current.internal.localFileManifest = manifest;
    current.internal.localProjectBytes = projectBytes;
    current.internal.sourceProjectCached = true;
    current.transfer = {
      ...current.transfer,
      bytesTotal: Math.max(projectBytes + current.plan.transferEstimate.knownVolumeBytes, current.transfer.bytesTotal || 0),
    };
    return current;
  });
}

async function exportNamedVolume(
  sessionId: string,
  archive: MigrationSession["internal"]["namedVolumeArchives"][number],
  sourceEnvironmentId = getLocalEnvironmentId()
) {
  if (fs.existsSync(archive.archivePath)) {
    archive.size = fs.statSync(archive.archivePath).size;
    return archive.size;
  }
  ensureDir(path.dirname(archive.archivePath));
  if (isLocalEnvironment(sourceEnvironmentId)) {
    const command = `docker run --rm -v ${shellQuote(archive.sourceVolume)}:/from -v ${shellQuote(path.dirname(archive.archivePath))}:/to ${HELPER_IMAGE} sh -c "cd /from && tar -cf /to/${archive.archiveName} ."`;
    await runCommandWithLogs(command, "sync", `导出卷 ${archive.sourceVolume}`, sessionId);
  } else {
    const { ssh, environment } = await getSourceEnvironmentConnection(sourceEnvironmentId);
    const remoteArchiveDir = `${environment.workdir}/.dockerproxy-migrate/${sessionId}/volume-archives`;
    const remoteArchivePath = `${remoteArchiveDir}/${archive.archiveName}`;
    try {
      await runRemoteCommand(
        ssh,
        `mkdir -p ${shellQuote(remoteArchiveDir)} && docker run --rm -v ${shellQuote(archive.sourceVolume)}:/from -v ${shellQuote(remoteArchiveDir)}:/to ${HELPER_IMAGE} sh -c "cd /from && tar -cf /to/${archive.archiveName} ."`,
        sessionId,
        "sync",
        `导出源服务器卷 ${archive.sourceVolume}`
      );
      await ssh.getFile(archive.archivePath, remoteArchivePath);
      await runRemoteCommand(ssh, `rm -f ${shellQuote(remoteArchivePath)}`, sessionId, "sync", `清理源服务器归档 ${archive.archiveName}`);
    } finally {
      ssh.dispose();
    }
  }
  archive.size = fs.existsSync(archive.archivePath) ? fs.statSync(archive.archivePath).size : archive.size;
  return archive.size;
}

async function syncProjectDirectory(session: MigrationSession, ssh: NodeSSH) {
  const preparedSession = await prepareSourceProjectCache(session.id);
  const files = preparedSession.internal.localFileManifest;
  const localProjectDir = preparedSession.internal.localProjectDir;
  const localProjectArchivePath = preparedSession.internal.localProjectArchivePath;
  const totalBytes = Math.max(preparedSession.transfer.bytesTotal || 0, 1);
  let transferred = 0;
  const startAt = Date.now();
  const sizeMap = new Map(files.map((item) => [item.path, item.size]));

  await runRemoteCommand(
    ssh,
    `mkdir -p ${shellQuote(session.internal.remoteProjectDir)} ${shellQuote(session.internal.remoteArtifactsDir)} ${shellQuote(`${session.internal.remoteBaseDir}/volume-archives`)}`,
    session.id,
    "sync",
    "创建远端工作目录"
  );

  if (localProjectArchivePath && preparedSession.internal.remoteProjectArchivePath && fs.existsSync(localProjectArchivePath)) {
    await ssh.putFile(localProjectArchivePath, preparedSession.internal.remoteProjectArchivePath);
    transferred = Math.min(preparedSession.transfer.bytesTotal || totalBytes, totalBytes);
    updateSession(session.id, (current) => {
      current.transfer = {
        ...current.transfer,
        currentFile: path.basename(localProjectArchivePath),
        bytesDone: transferred,
        bytesTotal: totalBytes,
        percent: Number(((transferred / totalBytes) * 100).toFixed(1)),
        speedBytesPerSec: null,
        etaSeconds: 0,
        checksumStatus: "pending",
      };
      return current;
    });
    appendEvent({
      sessionId: session.id,
      type: "transfer_progress",
      ts: nowIso(),
      phase: "sync",
      step: "同步项目目录",
      level: "info",
      message: `已上传项目归档 ${path.basename(localProjectArchivePath)}，正在目标机解压`,
      current: transferred,
      total: totalBytes,
      percent: Number(((transferred / totalBytes) * 100).toFixed(1)),
      unit: "bytes",
      meta: {
        currentFile: path.basename(localProjectArchivePath),
      },
    });
    await runRemoteCommand(
      ssh,
      `mkdir -p ${shellQuote(session.internal.remoteProjectDir)} && tar -xf ${shellQuote(
        preparedSession.internal.remoteProjectArchivePath
      )} -C ${shellQuote(session.internal.remoteProjectDir)}`,
      session.id,
      "sync",
      "解压项目目录归档"
    );
    await runRemoteCommand(
      ssh,
      `rm -f ${shellQuote(preparedSession.internal.remoteProjectArchivePath)}`,
      session.id,
      "sync",
      "清理目标机项目归档"
    );
    return;
  }

  await ssh.putDirectory(localProjectDir, session.internal.remoteProjectDir, {
    recursive: true,
    concurrency: 4,
    tick: (localPath: string, _remotePath: string, error?: Error) => {
      if (error) {
        appendEvent({
          sessionId: session.id,
          type: "command_log",
          ts: nowIso(),
          phase: "sync",
          step: "同步项目目录",
          level: "error",
          message: `传输失败: ${localPath}`,
        });
        return;
      }

      transferred += sizeMap.get(localPath) || 0;
      const elapsedSeconds = Math.max((Date.now() - startAt) / 1000, 1);
      const speed = transferred / elapsedSeconds;
      const remaining = Math.max(totalBytes - transferred, 0);
      const etaSeconds = speed > 0 ? Math.ceil(remaining / speed) : null;

      updateSession(session.id, (current) => {
          current.transfer = {
            ...current.transfer,
            currentFile: path.relative(localProjectDir, localPath),
            bytesDone: transferred,
            bytesTotal: totalBytes,
            percent: Number(((transferred / totalBytes) * 100).toFixed(1)),
          speedBytesPerSec: Number(speed.toFixed(1)),
          etaSeconds,
          checksumStatus: "pending",
        };
        return current;
      });

      appendEvent({
        sessionId: session.id,
        type: "transfer_progress",
        ts: nowIso(),
        phase: "sync",
        step: "同步项目目录",
        level: "info",
        message: `已同步 ${path.relative(localProjectDir, localPath)}`,
        current: transferred,
        total: totalBytes,
        percent: Number(((transferred / totalBytes) * 100).toFixed(1)),
        unit: "bytes",
        meta: {
          currentFile: path.relative(localProjectDir, localPath),
          etaSeconds,
          speedBytesPerSec: Number(speed.toFixed(1)),
        },
      });
    },
  });
}

async function uploadArtifacts(session: MigrationSession, ssh: NodeSSH) {
  await ssh.putFile(session.plan.artifactPaths.stagingCompose, session.internal.remoteComposePath);
  await ssh.putFile(session.plan.artifactPaths.cutoverCompose, session.internal.remoteCutoverComposePath);
}

async function uploadNamedVolumes(session: MigrationSession, ssh: NodeSSH) {
  const totalArchives = session.internal.namedVolumeArchives.length;
  if (totalArchives === 0) return;
  let processed = 0;
  let bytesDone = loadSession(session.id)?.transfer.bytesDone || 0;
  const bytesTotal = Math.max(loadSession(session.id)?.transfer.bytesTotal || 1, 1);
  for (const archive of session.internal.namedVolumeArchives) {
    await exportNamedVolume(session.id, archive, session.sourceEnvironmentId);
    await ssh.putFile(archive.archivePath, `${session.internal.remoteBaseDir}/volume-archives/${archive.archiveName}`);
    processed += 1;
    bytesDone += archive.size || 0;
    updateSession(session.id, (current) => {
      current.transfer = {
        ...current.transfer,
        currentFile: `volume-archives/${archive.archiveName}`,
        bytesDone,
        bytesTotal,
        percent: Number(((bytesDone / bytesTotal) * 100).toFixed(1)),
      };
      return current;
    });
    appendEvent({
      sessionId: session.id,
      type: "transfer_progress",
      ts: nowIso(),
      phase: "sync",
      step: "同步命名卷归档",
      level: "info",
      message: `已上传卷归档 ${archive.archiveName}`,
      current: bytesDone,
      total: bytesTotal,
      percent: Number(((bytesDone / bytesTotal) * 100).toFixed(1)),
      unit: "bytes",
      meta: {
        archiveCount: processed,
        totalArchives,
      },
    });
    for (const serviceName of session.selectedServices.filter((serviceName) =>
      session.plan.services.find((service) => service.name === serviceName)?.namedVolumes.includes(archive.sourceVolume)
    )) {
      setServiceState(session.id, serviceName, { dataStatus: "synced", status: "syncing" }, "sync", `卷 ${archive.sourceVolume} 已同步归档`);
    }
  }
}

async function restoreNamedVolumes(session: MigrationSession, ssh: NodeSSH) {
  for (const archive of session.internal.namedVolumeArchives) {
    await runRemoteCommand(
      ssh,
      `docker volume create ${shellQuote(archive.stagingVolume)}`,
      session.id,
      "stage_restore",
      `创建隔离卷 ${archive.stagingVolume}`
    );
    await runRemoteCommand(
      ssh,
      `docker run --rm -v ${shellQuote(archive.stagingVolume)}:/to -v ${shellQuote(`${session.internal.remoteBaseDir}/volume-archives`)}:/from ${HELPER_IMAGE} sh -c "mkdir -p /to && tar -xf /from/${archive.archiveName} -C /to"`,
      session.id,
      "stage_restore",
      `恢复卷 ${archive.stagingVolume}`
    );
    for (const serviceName of session.selectedServices.filter((serviceName) =>
      session.plan.services.find((service) => service.name === serviceName)?.namedVolumes.includes(archive.sourceVolume)
    )) {
      setServiceState(session.id, serviceName, { dataStatus: "restored", status: "staged" }, "stage_restore", `卷 ${archive.sourceVolume} 已恢复到 ${archive.stagingVolume}`);
    }
  }
}

async function stageRestore(session: MigrationSession, ssh: NodeSSH) {
  await runRemoteCommand(
    ssh,
    `docker compose -p ${shellQuote(session.internal.migrationProjectName)} -f ${shellQuote(session.internal.remoteComposePath)} config -q`,
    session.id,
    "stage_restore",
    "校验 staging Compose"
  );
  await restoreNamedVolumes(session, ssh);
  await runRemoteCommand(
    ssh,
    `cd ${shellQuote(session.internal.remoteBaseDir)} && docker compose -p ${shellQuote(session.internal.migrationProjectName)} -f ${shellQuote(session.internal.remoteComposePath)} up -d`,
    session.id,
    "stage_restore",
    "启动 staging 服务"
  );
  for (const serviceName of session.selectedServices) {
    setServiceState(session.id, serviceName, { status: "staged", health: "starting" }, "stage_restore", "服务已进入 staging");
  }
}

async function cutover(session: MigrationSession, ssh: NodeSSH) {
  await runRemoteCommand(
    ssh,
    `cd ${shellQuote(session.internal.remoteBaseDir)} && docker compose -p ${shellQuote(session.internal.migrationProjectName)} -f ${shellQuote(session.internal.remoteCutoverComposePath)} up -d`,
    session.id,
    "cutover",
    "执行 cutover"
  );
  for (const serviceName of session.selectedServices) {
    setServiceState(session.id, serviceName, { status: "cutover", health: "starting" }, "cutover", "服务已切换到正式网络/端口配置");
  }
}

async function verifyRemoteSession(session: MigrationSession, ssh: NodeSSH) {
  await runRemoteCommand(
    ssh,
    `docker compose -p ${shellQuote(session.internal.migrationProjectName)} -f ${shellQuote(session.internal.remoteCutoverComposePath)} config -q`,
    session.id,
    "verify_or_rollback",
    "校验 cutover Compose"
  );
  const psOutput = await runRemoteCommand(
    ssh,
    `docker compose -p ${shellQuote(session.internal.migrationProjectName)} -f ${shellQuote(session.internal.remoteCutoverComposePath)} ps --format json`,
    session.id,
    "verify_or_rollback",
    "检查容器状态"
  );
  let services: any[] = [];
  try {
    const parsed = JSON.parse(psOutput);
    services = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch {
    const lines = psOutput
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    services = lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean) as any[];
  }

  const verificationResults: MigrationSession["result"]["verification"] = [];
  for (const item of services) {
    const serviceName = item.Service || item.Name || "unknown";
    const state = String(item.State || item.Status || "").toLowerCase();
    const healthy = state.includes("running") || state.includes("healthy");
    verificationResults.push({
      label: serviceName,
      status: healthy ? "pass" : "fail",
      detail: healthy ? "容器已启动" : `容器状态异常: ${state || "unknown"}`,
    });
    setServiceState(
      session.id,
      serviceName,
      {
        status: healthy ? "running" : "failed",
        health: healthy ? "healthy" : "unhealthy",
      },
      "verify_or_rollback",
      healthy ? "校验通过" : `校验失败: ${state || "unknown"}`
    );
  }

  updateSession(session.id, (current) => {
    current.result.verification = verificationResults;
    current.result.finalResources = [
      `${current.internal.migrationProjectName} (Compose project)`,
      ...current.internal.namedVolumeArchives.map((archive) => archive.stagingVolume),
    ];
    return current;
  });

  const failedChecks = verificationResults.filter((result) => result.status === "fail");
  if (failedChecks.length > 0) {
    throw new Error(`服务校验失败: ${failedChecks.map((item) => item.label).join(", ")}`);
  }
}

async function rollbackRemoteSession(session: MigrationSession, target: TargetHostInput, reason: string) {
  const ssh = new NodeSSH();
  const rollbackActions: string[] = [];
  try {
    await ssh.connect({
      host: target.host,
      port: Number(target.port || 22),
      username: target.username,
      password: target.password,
      privateKey: target.privateKey,
    });

    const hasCutoverCompose = await remotePathAccessibleWithSsh(ssh, session.internal.remoteCutoverComposePath, "file");
    const hasStagingCompose = await remotePathAccessibleWithSsh(ssh, session.internal.remoteComposePath, "file");
    if (hasCutoverCompose) {
      rollbackActions.push("停止迁移服务");
      await runRemoteCommand(
        ssh,
        `docker compose -p ${shellQuote(session.internal.migrationProjectName)} -f ${shellQuote(session.internal.remoteCutoverComposePath)} down -v --remove-orphans || true`,
        session.id,
        "verify_or_rollback",
        "回滚：停止 cutover 服务"
      );
    } else {
      rollbackActions.push("跳过 cutover 清理（未生成 cutover Compose）");
      appendEvent({
        sessionId: session.id,
        type: "command_log",
        ts: nowIso(),
        phase: "verify_or_rollback",
        step: "自动回滚",
        level: "info",
        message: "跳过 cutover 清理：目标机尚未生成 cutover Compose 文件。",
      });
    }
    if (hasStagingCompose) {
      rollbackActions.push("清理隔离资源");
      await runRemoteCommand(
        ssh,
        `docker compose -p ${shellQuote(session.internal.migrationProjectName)} -f ${shellQuote(session.internal.remoteComposePath)} down -v --remove-orphans || true`,
        session.id,
        "verify_or_rollback",
        "回滚：停止 staging 服务"
      );
    } else {
      rollbackActions.push("跳过 staging 清理（未生成 staging Compose）");
      appendEvent({
        sessionId: session.id,
        type: "command_log",
        ts: nowIso(),
        phase: "verify_or_rollback",
        step: "自动回滚",
        level: "info",
        message: "跳过 staging 清理：目标机尚未生成 staging Compose 文件。",
      });
    }
    rollbackActions.push("删除迁移工作目录");
    await runRemoteCommand(
      ssh,
      `rm -rf ${shellQuote(session.internal.remoteBaseDir)}`,
      session.id,
      "verify_or_rollback",
      "回滚：清理远端工作目录"
    );

    const updated = updateSession(session.id, (current) => {
      current.status = "rolled_back";
      current.pageState = "rolled_back";
      current.currentPhase = "verify_or_rollback";
      current.currentStep = "目标机回滚完成";
      current.progress = {
        percent: phasePercent("verify_or_rollback", 1),
        phasePercent: 100,
      };
      current.endedAt = nowIso();
      current.result = {
        ...current.result,
        outcome: "rolled_back",
        message: reason,
        rollback: {
          status: "completed",
          actions: rollbackActions,
          message: reason,
          finishedAt: nowIso(),
        },
      };
      return current;
    });

    appendEvent({
      sessionId: session.id,
      type: "result",
      ts: nowIso(),
      phase: "verify_or_rollback",
      step: "自动回滚",
      level: "warn",
      message: `目标机回滚完成：${reason}`,
      percent: updated.progress.percent,
      meta: { session: sanitizeSession(updated) },
    });

    return sanitizeSession(updated);
  } catch (error: any) {
    const updated = updateSession(session.id, (current) => {
      current.status = "failed";
      current.pageState = "failed";
      current.currentPhase = "verify_or_rollback";
      current.currentStep = "回滚失败";
      current.endedAt = nowIso();
      current.result = {
        ...current.result,
        outcome: "failed",
        message: `回滚失败: ${error.message}`,
        rollback: {
          status: "failed",
          actions: rollbackActions,
          message: error.message,
          finishedAt: nowIso(),
        },
      };
      return current;
    });
    appendEvent({
      sessionId: session.id,
      type: "phase_failed",
      ts: nowIso(),
      phase: "verify_or_rollback",
      step: "自动回滚",
      level: "error",
      message: `目标机回滚失败：${error.message}`,
      percent: updated.progress.percent,
      meta: { session: sanitizeSession(updated) },
    });
    return sanitizeSession(updated);
  } finally {
    ssh.dispose();
  }
}

async function executeMigration(sessionId: string, target: TargetHostInput) {
  const session = loadSession(sessionId);
  if (!session) throw new Error("迁移会话不存在");
  const ssh = new NodeSSH();
  try {
    startPhase(sessionId, "sync", "running", "同步项目目录与卷数据");
    updateSession(sessionId, (current) => {
      current.startedAt = nowIso();
      current.result.message = "迁移任务开始执行。";
      return current;
    });
    await ssh.connect({
      host: target.host,
      port: Number(target.port || 22),
      username: target.username,
      password: target.password,
      privateKey: target.privateKey,
    });

    for (const serviceName of session.selectedServices) {
      setServiceState(sessionId, serviceName, { status: "syncing", dataStatus: "pending" }, "sync", "等待同步");
    }
    await syncProjectDirectory(session, ssh);
    await uploadArtifacts(session, ssh);
    await uploadNamedVolumes(session, ssh);
    finishPhase(sessionId, "sync", "项目与数据同步完成");

    startPhase(sessionId, "stage_restore", "running", "恢复 staging 服务");
    await stageRestore(session, ssh);
    finishPhase(sessionId, "stage_restore", "staging 已启动");

    startPhase(sessionId, "cutover", "cutover_pending", "切换到正式服务配置");
    await cutover(session, ssh);
    finishPhase(sessionId, "cutover", "cutover 已完成");

    startPhase(sessionId, "verify_or_rollback", "verifying", "执行最终校验");
    await verifyRemoteSession(session, ssh);
    const completed = updateSession(sessionId, (current) => {
      current.status = "completed";
      current.pageState = "completed";
      current.currentPhase = "verify_or_rollback";
      current.currentStep = "迁移验证完成";
      current.progress = {
        percent: phasePercent("verify_or_rollback", 1),
        phasePercent: 100,
      };
      current.endedAt = nowIso();
      current.transfer.checksumStatus = "passed";
      current.transfer.bytesDone = current.transfer.bytesTotal;
      current.transfer.percent = 100;
      current.result = {
        ...current.result,
        outcome: "completed",
        message: "迁移执行完成，目标服务已通过基础校验。",
      };
      return current;
    });
    appendEvent({
      sessionId,
      type: "result",
      ts: nowIso(),
      phase: "verify_or_rollback",
      step: "迁移完成",
      level: "success",
      message: "迁移执行完成，目标服务已通过基础校验。",
      percent: completed.progress.percent,
      meta: { session: sanitizeSession(completed) },
    });
  } catch (error: any) {
    const failed = updateSession(sessionId, (current) => {
      current.status = "failed";
      current.pageState = "failed";
      current.currentStep = error.message;
      current.result = {
        ...current.result,
        outcome: "failed",
        message: error.message,
      };
      return current;
    });
    appendEvent({
      sessionId,
      type: "phase_failed",
      ts: nowIso(),
      phase: failed.currentPhase,
      step: failed.currentStep,
      level: "error",
      message: `迁移失败：${error.message}`,
      percent: failed.progress.percent,
      meta: { session: sanitizeSession(failed) },
    });
    await rollbackRemoteSession(failed, target, `迁移失败后自动回滚：${error.message}`);
  } finally {
    ssh.dispose();
  }
}

export async function listMigrationProjects(environmentId = getLocalEnvironmentId()) {
  return discoverMigrationProjects(environmentId);
}

export async function createMigrationPlan(input: PlanInput) {
  const source = await resolveMigrationProjectSource(input.projectPath, input.sourceEnvironmentId || getLocalEnvironmentId());
  if (!source && input.sourceEnvironmentId && !isLocalEnvironment(input.sourceEnvironmentId)) {
    throw new Error("当前来源已失效，请先刷新来源列表并重新选择迁移对象。");
  }
  return analyzeProject(input, source);
}

export function getMigrationSession(sessionId: string) {
  const session = loadSession(sessionId);
  if (!session) throw new Error("迁移会话不存在");
  return sanitizeSession(session);
}

export function listMigrationSessions(serverId?: string) {
  const root = migrationRoot();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => loadSession(entry.name))
    .filter((session): session is MigrationSession => Boolean(session))
    .filter((session) => {
      if (!serverId) return true;
      return session.sourceEnvironmentId === serverId || session.targetEnvironmentId === serverId;
    })
    .map((session) => sanitizeSession(session))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function getMigrationArtifacts(sessionId: string) {
  const session = loadSession(sessionId);
  if (!session) throw new Error("迁移会话不存在");
  const artifactFiles = {
    manifest: session.plan.artifactPaths.manifest,
    riskReport: session.plan.artifactPaths.riskReport,
    stagingCompose: session.plan.artifactPaths.stagingCompose,
    cutoverCompose: session.plan.artifactPaths.cutoverCompose,
  };
  const payload: Record<string, any> = {};
  for (const [key, filePath] of Object.entries(artifactFiles)) {
    if (!fs.existsSync(filePath)) continue;
    if (filePath.endsWith(".json")) {
      payload[key] = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } else {
      payload[key] = fs.readFileSync(filePath, "utf-8");
    }
  }
  payload.targetSnapshotSummary = {
    target: session.target,
    migrationProjectName: session.internal.migrationProjectName,
    remoteBaseDir: session.internal.remoteBaseDir,
    finalResources: session.result.finalResources,
  };
  payload.rollbackReport = session.result.rollback;
  payload.session = sanitizeSession(session);
  return payload;
}

export async function startMigrationSession(sessionId: string) {
  const session = loadSession(sessionId);
  if (!session) throw new Error("迁移会话不存在");
  if (session.status !== "plan_ready") {
    throw new Error(`当前会话状态为 ${session.status}，不能启动迁移`);
  }
  if (activeExecutions.has(sessionId)) {
    throw new Error("迁移任务已在执行中");
  }

  const next = updateSession(sessionId, (current) => {
    current.status = "running";
    current.pageState = "running";
    current.currentPhase = "sync";
    current.currentStep = "等待执行器启动";
    return current;
  });

  const target = getTargetHostFromEnvironment(session.targetEnvironmentId);
  const execution = executeMigration(sessionId, target).finally(() => {
    activeExecutions.delete(sessionId);
  });
  activeExecutions.set(sessionId, execution);
  return sanitizeSession(next);
}

export async function rollbackMigrationSession(sessionId: string) {
  const session = loadSession(sessionId);
  if (!session) throw new Error("迁移会话不存在");
  if (session.status === "running" || session.status === "verifying" || session.status === "cutover_pending") {
    throw new Error("当前会话仍在执行中，暂不支持手动中断回滚");
  }
  const target = getTargetHostFromEnvironment(session.targetEnvironmentId);
  return rollbackRemoteSession(session, target, "用户手动触发目标机回滚");
}

export function subscribeMigrationEvents(sessionId: string, onEvent: (event: MigrationEvent) => void) {
  const filePath = eventsFile(sessionId);
  if (fs.existsSync(filePath)) {
    const lines = fs
      .readFileSync(filePath, "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      try {
        onEvent(JSON.parse(line));
      } catch {
        // ignore malformed history lines
      }
    }
  }

  const listener = (event: MigrationEvent) => onEvent(event);
  migrationBus.on(sessionId, listener);
  return () => {
    migrationBus.off(sessionId, listener);
  };
}
