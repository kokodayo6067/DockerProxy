import { getContainers } from "./docker";
import { listEnvironments, getEnvironment } from "./platform";
import { getMonitorSnapshot } from "./monitor";
import { getGatewayCertificates, listGateways, listServerGatewaySummaries } from "./gateways";
import { listJobs } from "./jobs";

function formatCollector(collector: string) {
  if (collector === "docker-host-helper") return "宿主机 helper";
  if (collector === "ssh-procfs") return "SSH /proc 采集";
  return "运行环境采集";
}

function formatChannelStatus(environment: ReturnType<typeof getEnvironment>) {
  if (environment.isLocal) return "embedded";
  if (environment.status === "ready") return "connected";
  if (environment.status === "warning") return "degraded";
  if (environment.status === "error") return "error";
  return "pending";
}

function getServerChannelsInternal(environmentId: string) {
  const environment = getEnvironment(environmentId);
  return [
    {
      id: `${environmentId}:ssh`,
      kind: "ssh",
      label: "SSH",
      status: formatChannelStatus(environment),
      detail: environment.isLocal
        ? "当前平台宿主机使用内建通道"
        : environment.lastError || environment.hostFingerprint || "已建立远端接入",
      fingerprint: environment.hostFingerprint,
      sudoMode: environment.capabilities.sudoMode,
      permissions: environment.capabilities.permissions,
      available: !environment.isLocal,
    },
    {
      id: `${environmentId}:tmcp`,
      kind: "tmcp",
      label: "TMCP",
      status: "not_configured",
      detail: "当前版本预留通道模型，尚未接入",
      permissions: [],
      available: false,
    },
    {
      id: `${environmentId}:agent`,
      kind: "agent",
      label: "Agent",
      status: "not_configured",
      detail: "当前版本预留通道模型，尚未接入",
      permissions: [],
      available: false,
    },
  ];
}

async function buildServerSummary(environmentId: string) {
  const environment = getEnvironment(environmentId);
  const gatewaySummary = listServerGatewaySummaries().get(environmentId) || {
    total: 0,
    active: 0,
    certificates: 0,
    routes: 0,
  };

  let metrics = null;
  try {
    metrics = await getMonitorSnapshot(environmentId);
  } catch {
    metrics = null;
  }

  let containerSummary = {
    total: 0,
    running: 0,
    composeProjects: 0,
    standalone: 0,
  };
  try {
    const containers = await getContainers(environmentId);
    containerSummary = {
      total: containers.length,
      running: containers.filter((container) => container.state === "running").length,
      composeProjects: new Set(containers.filter((container) => container.composeProject).map((container) => container.composeProject)).size,
      standalone: containers.filter((container) => container.sourceKind === "standalone-container").length,
    };
  } catch {
    // ignore container summary failure
  }

  return {
    ...environment,
    serverId: environment.id,
    serverType: environment.isLocal ? "local-host" : environment.source,
    metrics: metrics
      ? {
          cpu: Number((metrics.cpu.load || 0).toFixed(1)),
          memoryPercent: Number((((metrics.memory.used || 0) / (metrics.memory.total || 1)) * 100).toFixed(1)),
          diskPercent: Number((metrics.disk.find((disk) => disk.mount === "/")?.use || metrics.disk[0]?.use || 0).toFixed(1)),
          collector: formatCollector(metrics.collector),
          scope: metrics.scope,
          warning: metrics.warning,
        }
      : null,
    gatewaySummary,
    workloadSummary: containerSummary,
    channelSummary: getServerChannelsInternal(environmentId).map((channel) => ({
      kind: channel.kind,
      label: channel.label,
      status: channel.status,
    })),
    lastHeartbeatAt: environment.lastVerifiedAt || environment.updatedAt,
  };
}

export async function listServers() {
  const environments = listEnvironments();
  const summaries = await Promise.all(environments.map((environment) => buildServerSummary(environment.id)));
  return summaries;
}

export async function getServerSummary(serverId: string) {
  return buildServerSummary(serverId);
}

export async function getServerMetrics(serverId: string) {
  return getMonitorSnapshot(serverId);
}

export function getServerChannels(serverId: string) {
  return getServerChannelsInternal(serverId);
}

export function getServerTasks(serverId: string) {
  return listJobs(serverId);
}

export function getServerCertificates(serverId: string) {
  return listGateways(serverId).flatMap((gateway) => getGatewayCertificates(gateway.id));
}
