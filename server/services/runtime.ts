import crypto from "crypto";
import fs from "fs";
import path from "path";
import { exec as execCallback } from "child_process";
import { promisify } from "util";
import { NodeSSH } from "node-ssh";
import { localDocker } from "./docker-client";
import { connectEnvironmentSsh, getEnvironment, getEnvironmentConnection, getLocalEnvironmentId, recordAuditLog } from "./platform";
import { CONFIG } from "../utils/config";
import { getDb } from "../db";

const execAsync = promisify(execCallback);

type RawInspect = any;

export type RuntimeMonitorSnapshot = {
  scope: "host" | "runtime";
  collector: "docker-host-helper" | "systeminformation" | "ssh-procfs";
  warning?: string;
  cpu: {
    manufacturer: string;
    brand: string;
    cores: number;
    load: number;
  };
  memory: {
    total: number;
    used: number;
    free: number;
  };
  os: {
    platform: string;
    distro: string;
    release: string;
    uptime: number;
  };
  disk: Array<{
    fs: string;
    size: number;
    used: number;
    use: number;
    mount: string;
  }>;
  network: {
    latency: number;
    rx_sec: number;
    tx_sec: number;
  };
};

type HostRawSnapshot = {
  ts: number;
  cpuTotal: number;
  cpuIdle: number;
  rxBytes: number;
  txBytes: number;
};

export type RuntimeLogEntry = {
  timestamp: string | null;
  stream: "stdout" | "stderr" | "combined";
  message: string;
  raw: string;
};

const remoteMonitorCache = new Map<string, HostRawSnapshot>();

function nowIso() {
  return new Date().toISOString();
}

function shellQuote(value: string) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function parseTimestampedLogLines(raw: string, stream: RuntimeLogEntry["stream"]) {
  return String(raw)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d{4}-\d{2}-\d{2}T\S+)\s(.*)$/);
      return {
        timestamp: match?.[1] || null,
        stream,
        message: match?.[2] || line,
        raw: line,
      } satisfies RuntimeLogEntry;
    });
}

function normalizeContainerPorts(ports: Record<string, Array<{ HostPort: string }> | null> | null | undefined) {
  const result: string[] = [];
  for (const [containerPort, mappings] of Object.entries(ports || {})) {
    if (!Array.isArray(mappings)) continue;
    for (const mapping of mappings) {
      if (!mapping?.HostPort) continue;
      result.push(`${mapping.HostPort}:${containerPort}`);
    }
  }
  return result;
}

function normalizeContainerInfo(inspect: RawInspect) {
  return {
    id: String(inspect?.Id || "").slice(0, 12),
    name: String(inspect?.Name || "").replace(/^\//, ""),
    image: inspect?.Config?.Image || inspect?.Image || "",
    state: inspect?.State?.Running ? "running" : inspect?.State?.Status || "unknown",
    status: inspect?.State?.Health?.Status
      ? `${inspect?.State?.Status || "unknown"} (${inspect.State.Health.Status})`
      : inspect?.State?.Status || "unknown",
    ports: normalizeContainerPorts(inspect?.NetworkSettings?.Ports),
    sourceKind: inspect?.Config?.Labels?.["com.docker.compose.project"] ? "compose-project" : "standalone-container",
    composeProject: inspect?.Config?.Labels?.["com.docker.compose.project"] || undefined,
    composeService: inspect?.Config?.Labels?.["com.docker.compose.service"] || undefined,
  };
}

async function listLocalContainers() {
  const containers = await localDocker.listContainers({ all: true });
  const inspections = await Promise.all(containers.map((container) => localDocker.getContainer(container.Id).inspect()));
  return inspections.map(normalizeContainerInfo);
}

async function listRemoteContainers(environmentId: string) {
  const { ssh } = await connectEnvironmentSsh(environmentId);
  try {
    const result = await ssh.execCommand(
      "sh -lc 'ids=$(docker ps -aq --no-trunc); if [ -z \"$ids\" ]; then echo \"[]\"; else docker inspect $ids; fi'"
    );
    if (result.code !== 0) {
      throw new Error(result.stderr || "获取远端容器列表失败");
    }
    const data = JSON.parse(result.stdout || "[]") as RawInspect[];
    return data.map(normalizeContainerInfo);
  } finally {
    ssh.dispose();
  }
}

export async function listRuntimeContainers(environmentId = getLocalEnvironmentId()) {
  return environmentId === getLocalEnvironmentId() ? listLocalContainers() : listRemoteContainers(environmentId);
}

export async function containerAction(environmentId: string, id: string, action: string, actor = "admin") {
  if (environmentId === getLocalEnvironmentId()) {
    const container = localDocker.getContainer(id);
    switch (action) {
      case "start":
        await container.start();
        break;
      case "stop":
        await container.stop();
        break;
      case "restart":
        await container.restart();
        break;
      case "remove":
        await container.remove({ force: true });
        break;
      default:
        throw new Error("不支持的操作");
    }
  } else {
    const { ssh } = await connectEnvironmentSsh(environmentId);
    try {
      const commandMap: Record<string, string> = {
        start: `docker container start ${JSON.stringify(id)}`,
        stop: `docker container stop ${JSON.stringify(id)}`,
        restart: `docker container restart ${JSON.stringify(id)}`,
        remove: `docker container rm -f ${JSON.stringify(id)}`,
      };
      const command = commandMap[action];
      if (!command) throw new Error("不支持的操作");
      const result = await ssh.execCommand(command);
      if (result.code !== 0) throw new Error(result.stderr || "远端容器操作失败");
    } finally {
      ssh.dispose();
    }
  }

  recordAuditLog(actor, "docker.container.action", "environment", environmentId, "info", {
    containerId: id,
    action,
  });
}

export async function getContainerLogs(environmentId: string, id: string, structured = false) {
  if (environmentId === getLocalEnvironmentId()) {
    const result = await execAsync(`docker logs --timestamps --tail 100 ${shellQuote(id)}`, {
      shell: "/bin/zsh",
      maxBuffer: 4 * 1024 * 1024,
    }).catch((error: any) => ({
      stdout: String(error?.stdout || ""),
      stderr: String(error?.stderr || error?.message || ""),
    }));
    const entries = [
      ...parseTimestampedLogLines(result.stdout || "", "stdout"),
      ...parseTimestampedLogLines(result.stderr || "", "stderr"),
    ].sort((left, right) => String(left.timestamp || "").localeCompare(String(right.timestamp || "")));
    return structured ? entries : entries.map((entry) => entry.raw).join("\n");
  }

  const { ssh } = await connectEnvironmentSsh(environmentId);
  try {
    const result = await ssh.execCommand(`docker logs --timestamps --tail 100 ${JSON.stringify(id)}`);
    const entries = [
      ...parseTimestampedLogLines(result.stdout || "", "stdout"),
      ...parseTimestampedLogLines(result.stderr || "", "stderr"),
    ].sort((left, right) => String(left.timestamp || "").localeCompare(String(right.timestamp || "")));
    return structured ? entries : entries.map((entry) => entry.raw).join("\n");
  } finally {
    ssh.dispose();
  }
}

async function persistProjectRevision(environmentId: string, name: string, composeYaml: string, remarks?: string) {
  const db = getDb();
  const projectId = `project:${environmentId}:${name}`;
  const revisionId = crypto.randomUUID();
  const timestamp = nowIso();
  db.prepare(
    `INSERT INTO projects (id, environment_id, name, source, remarks, project_dir, current_revision_id, created_at, updated_at)
     VALUES (@id, @environmentId, @name, 'compose', @remarks, @projectDir, @revisionId, @createdAt, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       remarks = excluded.remarks,
       project_dir = excluded.project_dir,
       current_revision_id = excluded.current_revision_id,
       updated_at = excluded.updated_at`
  ).run({
    id: projectId,
    environmentId,
    name,
    remarks: remarks || null,
    projectDir: path.join(CONFIG.DATA_DIR, "projects", environmentId, name),
    revisionId,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  db.prepare(
    `INSERT INTO project_revisions (id, project_id, environment_id, compose_yaml, remarks, compose_path, created_at)
     VALUES (@id, @projectId, @environmentId, @composeYaml, @remarks, @composePath, @createdAt)`
  ).run({
    id: revisionId,
    projectId,
    environmentId,
    composeYaml,
    remarks: remarks || null,
    composePath: path.join(CONFIG.DATA_DIR, "projects", environmentId, name, "docker-compose.yml"),
    createdAt: timestamp,
  });
}

export async function deployComposeToEnvironment(
  environmentId: string,
  name: string,
  composeYaml: string,
  remarks?: string,
  actor = "admin"
) {
  const environment = getEnvironment(environmentId);
  const projectDir = path.join(CONFIG.DATA_DIR, "projects", environmentId, name);
  fs.mkdirSync(projectDir, { recursive: true });
  const composePath = path.join(projectDir, "docker-compose.yml");
  fs.writeFileSync(composePath, composeYaml, "utf-8");
  await persistProjectRevision(environmentId, name, composeYaml, remarks);

  if (environmentId === getLocalEnvironmentId()) {
    await execAsync("docker network inspect proxy_net >/dev/null 2>&1 || docker network create proxy_net", {
      shell: "/bin/zsh",
      maxBuffer: 4 * 1024 * 1024,
    });
    await execAsync(`docker compose -f "${composePath}" -p "${name}" up -d`, {
      shell: "/bin/zsh",
      maxBuffer: 4 * 1024 * 1024,
    });
  } else {
    const { ssh } = await connectEnvironmentSsh(environmentId);
    try {
      const remoteProjectDir = path.posix.join(environment.workdir, name);
      const remoteComposePath = path.posix.join(remoteProjectDir, "docker-compose.yml");
      await ssh.execCommand(`mkdir -p ${JSON.stringify(remoteProjectDir)}`);
      await ssh.putFile(composePath, remoteComposePath);
      const result = await ssh.execCommand(
        `sh -lc 'docker network inspect proxy_net >/dev/null 2>&1 || docker network create proxy_net; docker compose -f ${JSON.stringify(
          remoteComposePath
        )} -p ${JSON.stringify(name)} up -d'`
      );
      if (result.code !== 0) {
        throw new Error(result.stderr || "远端部署失败");
      }
    } finally {
      ssh.dispose();
    }
  }

  recordAuditLog(actor, "deploy.compose", "environment", environmentId, "info", {
    name,
    remarks: remarks || null,
  });
}

function parseSections(raw: string) {
  const sections: Record<string, string[]> = {};
  let current = "";
  for (const line of String(raw).split(/\r?\n/)) {
    const marker = line.match(/^__([A-Z0-9_]+)__$/);
    if (marker) {
      current = marker[1];
      if (!sections[current]) sections[current] = [];
      continue;
    }
    if (!current) continue;
    sections[current].push(line);
  }
  return Object.fromEntries(Object.entries(sections).map(([key, lines]) => [key, lines.join("\n").trim()]));
}

function parseKeyValueLines(raw: string) {
  const result: Record<string, string> = {};
  for (const line of String(raw).split(/\r?\n/)) {
    const match = line.match(/^([^=:\s]+)\s*[:=]\s*(.+)$/);
    if (!match) continue;
    result[match[1]] = match[2].replace(/^"/, "").replace(/"$/, "");
  }
  return result;
}

function parseMeminfoValue(raw: string, key: string) {
  const match = raw.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, "m"));
  if (!match) return 0;
  return Number(match[1]) * 1024;
}

function parseHostCpu(rawCpuStat: string, rawCpuInfo: string, previous: HostRawSnapshot | null, fallbackLoad = 0) {
  const cpuLine = String(rawCpuStat).split(/\r?\n/)[0] || "";
  const values = cpuLine
    .trim()
    .split(/\s+/)
    .slice(1)
    .map((item) => Number(item) || 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  const idle = (values[3] || 0) + (values[4] || 0);

  let load = fallbackLoad;
  if (previous && total > previous.cpuTotal) {
    const totalDelta = total - previous.cpuTotal;
    const idleDelta = idle - previous.cpuIdle;
    load = Number((Math.max(0, 1 - idleDelta / totalDelta) * 100).toFixed(1));
  }

  const cpuInfoLines = String(rawCpuInfo).split(/\r?\n/);
  const brandLine = cpuInfoLines.find((line) => line.toLowerCase().startsWith("model name")) || "";
  const brand = brandLine.split(":").slice(1).join(":").trim() || "Host CPU";
  const cores = cpuInfoLines.filter((line) => line.toLowerCase().startsWith("processor")).length || 1;
  const manufacturer = brand.split(" ")[0] || "Host";

  return {
    cpu: {
      manufacturer,
      brand,
      cores,
      load,
    },
    cpuTotal: total,
    cpuIdle: idle,
  };
}

function parseHostNetwork(rawNetDev: string, previous: HostRawSnapshot | null, nowTs: number) {
  let rxBytes = 0;
  let txBytes = 0;
  for (const line of String(rawNetDev).split(/\r?\n/).slice(2)) {
    const [iface, payload] = line.split(":");
    if (!iface || !payload) continue;
    const ifaceName = iface.trim();
    if (!ifaceName || ifaceName === "lo") continue;
    const fields = payload.trim().split(/\s+/).map((item) => Number(item) || 0);
    rxBytes += fields[0] || 0;
    txBytes += fields[8] || 0;
  }

  let rx_sec = 0;
  let tx_sec = 0;
  if (previous && nowTs > previous.ts) {
    const elapsedSeconds = Math.max((nowTs - previous.ts) / 1000, 1);
    rx_sec = Math.max(0, Math.round((rxBytes - previous.rxBytes) / elapsedSeconds));
    tx_sec = Math.max(0, Math.round((txBytes - previous.txBytes) / elapsedSeconds));
  }

  return {
    network: {
      latency: 0,
      rx_sec,
      tx_sec,
    },
    rxBytes,
    txBytes,
  };
}

function parseHostDisk(rawDf: string) {
  const lines = String(rawDf).split(/\r?\n/).filter(Boolean);
  return lines
    .filter((line) => !line.startsWith("Filesystem"))
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      return {
        fs: parts[0] || "root",
        size: Number(parts[1] || 0) * 1024,
        used: Number(parts[2] || 0) * 1024,
        use: Number(String(parts[4] || "0").replace("%", "")) || 0,
        mount: parts[5] || "/",
      };
    });
}

export async function collectRemoteMonitorSnapshot(environmentId: string): Promise<RuntimeMonitorSnapshot> {
  const { ssh } = await connectEnvironmentSsh(environmentId);
  const startedAt = Date.now();
  try {
    const command = [
      "echo __CPU_STAT__",
      "sed -n '1p' /proc/stat",
      "echo __MEMINFO__",
      "cat /proc/meminfo",
      "echo __UPTIME__",
      "cat /proc/uptime",
      "echo __NETDEV__",
      "cat /proc/net/dev",
      "echo __OSRELEASE__",
      "cat /etc/os-release 2>/dev/null || true",
      "echo __DF__",
      "df -kP /",
      "echo __CPUINFO__",
      "cat /proc/cpuinfo",
    ].join(" && ");
    const result = await ssh.execCommand(`sh -lc ${JSON.stringify(command)}`);
    if (result.code !== 0) {
      throw new Error(result.stderr || "远端监控采集失败");
    }
    const sections = parseSections(result.stdout || "");
    const osRelease = parseKeyValueLines(sections.OSRELEASE);
    const previous = remoteMonitorCache.get(environmentId) || null;
    const nowTs = Date.now();
    const cpuResult = parseHostCpu(sections.CPU_STAT, sections.CPUINFO, previous);
    const networkResult = parseHostNetwork(sections.NETDEV, previous, nowTs);
    remoteMonitorCache.set(environmentId, {
      ts: nowTs,
      cpuTotal: cpuResult.cpuTotal,
      cpuIdle: cpuResult.cpuIdle,
      rxBytes: networkResult.rxBytes,
      txBytes: networkResult.txBytes,
    });

    return {
      scope: "host",
      collector: "ssh-procfs",
      cpu: cpuResult.cpu,
      memory: {
        total: parseMeminfoValue(sections.MEMINFO, "MemTotal"),
        free: parseMeminfoValue(sections.MEMINFO, "MemAvailable"),
        used: Math.max(
          parseMeminfoValue(sections.MEMINFO, "MemTotal") - parseMeminfoValue(sections.MEMINFO, "MemAvailable"),
          0
        ),
      },
      os: {
        platform: osRelease.ID || "linux",
        distro: osRelease.PRETTY_NAME || osRelease.NAME || "Linux",
        release: osRelease.VERSION_ID || "",
        uptime: Number(String(sections.UPTIME || "0").split(/\s+/)[0] || 0),
      },
      disk: parseHostDisk(sections.DF),
      network: {
        latency: Date.now() - startedAt,
        rx_sec: networkResult.network.rx_sec,
        tx_sec: networkResult.network.tx_sec,
      },
      warning: "当前通过 SSH 读取远端主机视角数据。",
    };
  } finally {
    ssh.dispose();
  }
}
