import si from "systeminformation";
import { docker } from "./docker";
import { collectRemoteMonitorSnapshot } from "./runtime";
import type { RuntimeMonitorSnapshot } from "./runtime";
import { getEnvironment, getLocalEnvironmentId } from "./platform";

const HELPER_IMAGE = "busybox:1.36.1";
const CACHE_TTL_MS = 2500;

type MonitorSnapshot = RuntimeMonitorSnapshot;

type HostRawSnapshot = {
  ts: number;
  cpuTotal: number;
  cpuIdle: number;
  rxBytes: number;
  txBytes: number;
};

let inflightHostSnapshot: Promise<MonitorSnapshot> | null = null;
let cachedHostSnapshot: MonitorSnapshot | null = null;
let cachedHostSnapshotAt = 0;
let previousHostRaw: HostRawSnapshot | null = null;

async function ensureHelperImage() {
  try {
    await docker.getImage(HELPER_IMAGE).inspect();
    return;
  } catch {
    // pull below
  }

  await new Promise<void>((resolve, reject) => {
    docker.pull(HELPER_IMAGE, (error, stream) => {
      if (error || !stream) {
        reject(error || new Error("无法拉取宿主机监控 helper 镜像"));
        return;
      }
      docker.modem.followProgress(stream, (followError: Error | null) => {
        if (followError) reject(followError);
        else resolve();
      });
    });
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

function parseHostCpu(rawCpuStat: string, rawCpuInfo: string, previous: HostRawSnapshot | null) {
  const cpuLine = String(rawCpuStat).split(/\r?\n/)[0] || "";
  const values = cpuLine
    .trim()
    .split(/\s+/)
    .slice(1)
    .map((item) => Number(item) || 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  const idle = (values[3] || 0) + (values[4] || 0);

  let load = cachedHostSnapshot?.cpu.load || 0;
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
  const targetLine = lines.find((line) => !line.startsWith("Filesystem")) || "";
  const parts = targetLine.trim().split(/\s+/);
  const size = Number(parts[1] || 0) * 1024;
  const used = Number(parts[2] || 0) * 1024;
  const use = Number(String(parts[4] || "0").replace("%", "")) || 0;
  const mount = parts[5] === "/hostfs" ? "/" : parts[5] || "/";

  return [
    {
      fs: parts[0] || "host-root",
      size,
      used,
      use,
      mount,
    },
  ];
}

async function collectHostSnapshotViaDocker(): Promise<MonitorSnapshot> {
  if (cachedHostSnapshot && Date.now() - cachedHostSnapshotAt < CACHE_TTL_MS) {
    return cachedHostSnapshot;
  }
  if (inflightHostSnapshot) {
    return inflightHostSnapshot;
  }

  inflightHostSnapshot = (async () => {
    await ensureHelperImage();

    const script = [
      "echo __CPU_STAT__",
      "sed -n '1p' /host/proc/stat",
      "echo __MEMINFO__",
      "cat /host/proc/meminfo",
      "echo __UPTIME__",
      "cat /host/proc/uptime",
      "echo __NETDEV__",
      "cat /host/proc/net/dev",
      "echo __OSRELEASE__",
      "cat /host/etc/os-release 2>/dev/null || true",
      "echo __DF__",
      "df -kP /hostfs 2>/dev/null || true",
      "echo __CPUINFO__",
      "cat /host/proc/cpuinfo",
    ].join(" && ");

    const container = await docker.createContainer({
      Image: HELPER_IMAGE,
      Tty: true,
      Cmd: ["sh", "-lc", script],
      HostConfig: {
        AutoRemove: true,
        NetworkMode: "none",
        Binds: ["/proc:/host/proc:ro", "/etc/os-release:/host/etc/os-release:ro", "/:/hostfs:ro"],
      },
    });

    try {
      await container.start();
      await container.wait();
      const logs = await container.logs({ stdout: true, stderr: true });
      const sections = parseSections(logs.toString("utf-8"));
      const nowTs = Date.now();
      const osRelease = parseKeyValueLines(sections.OSRELEASE);
      const cpuResult = parseHostCpu(sections.CPU_STAT, sections.CPUINFO, previousHostRaw);
      const networkResult = parseHostNetwork(sections.NETDEV, previousHostRaw, nowTs);
      const totalMemory = parseMeminfoValue(sections.MEMINFO, "MemTotal");
      const freeMemory = parseMeminfoValue(sections.MEMINFO, "MemAvailable");
      const uptime = Number(String(sections.UPTIME || "0").split(/\s+/)[0] || 0);

      previousHostRaw = {
        ts: nowTs,
        cpuTotal: cpuResult.cpuTotal,
        cpuIdle: cpuResult.cpuIdle,
        rxBytes: networkResult.rxBytes,
        txBytes: networkResult.txBytes,
      };

      cachedHostSnapshot = {
        scope: "host",
        collector: "docker-host-helper",
        cpu: cpuResult.cpu,
        memory: {
          total: totalMemory,
          used: Math.max(totalMemory - freeMemory, 0),
          free: freeMemory,
        },
        os: {
          platform: "linux",
          distro: osRelease.PRETTY_NAME || osRelease.NAME || "Host Linux",
          release: osRelease.VERSION_ID || "",
          uptime,
        },
        disk: parseHostDisk(sections.DF),
        network: networkResult.network,
      };
      cachedHostSnapshotAt = nowTs;
      return cachedHostSnapshot;
    } finally {
      inflightHostSnapshot = null;
      try {
        await container.remove({ force: true });
      } catch {
        // ignore auto-remove race
      }
    }
  })();

  return inflightHostSnapshot;
}

async function collectRuntimeSnapshot(): Promise<MonitorSnapshot> {
  const [cpu, mem, os, currentLoad, fsSize, networkStats, inetLatency] = await Promise.all([
    si.cpu(),
    si.mem(),
    si.osInfo(),
    si.currentLoad(),
    si.fsSize(),
    si.networkStats(),
    si.inetLatency("8.8.8.8"),
  ]);

  let rx_sec = 0;
  let tx_sec = 0;
  if (networkStats && networkStats.length > 0) {
    networkStats.forEach((net) => {
      rx_sec += net.rx_sec || 0;
      tx_sec += net.tx_sec || 0;
    });
  }

  return {
    scope: "runtime",
    collector: "systeminformation",
    warning: "当前回退为应用运行环境视角。若要稳定看到宿主机全量指标，需要允许宿主机指标采集 helper 访问宿主机文件系统。",
    cpu: {
      manufacturer: cpu.manufacturer,
      brand: cpu.brand,
      cores: cpu.cores,
      load: currentLoad.currentLoad,
    },
    memory: {
      total: mem.total,
      used: mem.active,
      free: mem.available,
    },
    os: {
      platform: os.platform,
      distro: os.distro,
      release: os.release,
      uptime: si.time().uptime,
    },
    disk: fsSize.map((disk) => ({
      fs: disk.fs,
      size: disk.size,
      used: disk.used,
      use: disk.use,
      mount: disk.mount,
    })),
    network: {
      latency: inetLatency,
      rx_sec,
      tx_sec,
    },
  };
}

export async function getMonitorSnapshot(environmentId = getLocalEnvironmentId()): Promise<MonitorSnapshot> {
  if (environmentId !== getLocalEnvironmentId()) {
    const environment = getEnvironment(environmentId);
    if (!environment.capabilities.inspect) {
      throw new Error("当前环境缺少 inspect 权限，无法读取监控信息");
    }
    return collectRemoteMonitorSnapshot(environmentId);
  }

  try {
    return await collectHostSnapshotViaDocker();
  } catch {
    return collectRuntimeSnapshot();
  }
}
