import React, { useEffect, useMemo, useState } from 'react';
import { Activity, CheckCircle2, HardDrive, PlugZap, RefreshCw, Server, ShieldCheck, TerminalSquare } from 'lucide-react';
import { JobSummary, ServerChannel, ServerSummary } from '../types';
import { Badge, Button, Card, EmptyState, PageHeader, SegmentedTabs, StatCard } from './ui/primitives';
import { Monitor } from './Monitor';
import { ServerContextBar } from './ServerContextBar';

type ServerOverviewProps = {
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
  servers: ServerSummary[];
  selectedServerId: string;
  onSelectServer: (serverId: string) => void;
  onOpenIntegrations: () => void;
  onOpenWorkloads: () => void;
  onOpenTasks: () => void;
};

function statusVariant(status: string) {
  if (status === 'ready' || status === 'connected' || status === 'completed') return 'success';
  if (status === 'warning' || status === 'running') return 'warning';
  if (status === 'error' || status === 'failed') return 'danger';
  return 'default';
}

export function ServerOverview({
  apiFetch,
  servers,
  selectedServerId,
  onSelectServer,
  onOpenIntegrations,
  onOpenWorkloads,
  onOpenTasks,
}: ServerOverviewProps) {
  const [activeDetailTab, setActiveDetailTab] = useState<'overview' | 'monitor' | 'workloads' | 'channels' | 'tasks'>('overview');
  const [channels, setChannels] = useState<ServerChannel[]>([]);
  const [tasks, setTasks] = useState<JobSummary[]>([]);
  const [loadingDetails, setLoadingDetails] = useState(false);

  const current = useMemo(
    () => servers.find((server) => server.id === selectedServerId) || servers[0] || null,
    [selectedServerId, servers]
  );

  const loadServerDetails = async () => {
    if (!current) return;
    setLoadingDetails(true);
    try {
      const [channelRes, taskRes] = await Promise.all([
        apiFetch(`/api/servers/${encodeURIComponent(current.id)}/channels`),
        apiFetch(`/api/servers/${encodeURIComponent(current.id)}/tasks`),
      ]);
      setChannels((await channelRes.json()) || []);
      setTasks((await taskRes.json()) || []);
    } catch (error) {
      console.error(error);
      setChannels([]);
      setTasks([]);
    } finally {
      setLoadingDetails(false);
    }
  };

  useEffect(() => {
    loadServerDetails();
  }, [current?.id]);

  const cards = servers;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Server}
        title="服务器概览"
        description="以服务器为主语查看宿主机状态、管理通道、工作负载和任务，而不是先进入 Docker 视角。"
        actions={
          <div className="flex gap-3">
            <Button variant="secondary" onClick={loadServerDetails}>
              <RefreshCw className={loadingDetails ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
              刷新详情
            </Button>
            <Button onClick={onOpenIntegrations}>
              <PlugZap className="h-4 w-4" />
              接入服务器
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2 2xl:grid-cols-3">
        {cards.map((server) => (
          <button
            key={server.id}
            type="button"
            onClick={() => onSelectServer(server.id)}
            className={`rounded-[1.5rem] border p-5 text-left transition ${
              server.id === current?.id
                ? 'border-[color:var(--brand-500)] bg-[var(--brand-soft)] shadow-[0_20px_36px_-28px_rgba(37,99,235,0.35)]'
                : 'border-[color:var(--border-subtle)] bg-[var(--surface-card)] hover:border-[color:var(--border-strong)] hover:bg-[var(--surface-card-strong)]'
            }`}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="truncate text-lg font-semibold text-[color:var(--text-primary)]">{server.displayName}</h3>
                  <Badge variant={statusVariant(server.status)}>{server.isLocal ? '当前宿主机' : '远端服务器'}</Badge>
                </div>
                <p className="mt-2 text-sm text-[color:var(--text-tertiary)]">{server.host}</p>
              </div>
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--surface-card-strong)] text-[var(--brand-500)]">
                <Server className="h-6 w-6" />
              </div>
            </div>

            <div className="mt-5 grid grid-cols-3 gap-3">
              <div className="rounded-2xl bg-[var(--surface-card-strong)] px-3 py-3">
                <p className="text-xs text-[color:var(--text-tertiary)]">CPU</p>
                <p className="mt-1 font-semibold text-[color:var(--text-primary)]">{server.metrics?.cpu?.toFixed(1) || '0.0'}%</p>
              </div>
              <div className="rounded-2xl bg-[var(--surface-card-strong)] px-3 py-3">
                <p className="text-xs text-[color:var(--text-tertiary)]">内存</p>
                <p className="mt-1 font-semibold text-[color:var(--text-primary)]">{server.metrics?.memoryPercent?.toFixed(1) || '0.0'}%</p>
              </div>
              <div className="rounded-2xl bg-[var(--surface-card-strong)] px-3 py-3">
                <p className="text-xs text-[color:var(--text-tertiary)]">磁盘</p>
                <p className="mt-1 font-semibold text-[color:var(--text-primary)]">{server.metrics?.diskPercent?.toFixed(1) || '0.0'}%</p>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-2 text-xs text-[color:var(--text-tertiary)]">
              <div className="flex items-center justify-between gap-3">
                <span>Docker Runtime</span>
                <span className="truncate text-right text-[color:var(--text-primary)]">{server.capabilities.dockerVersion || '不可用'}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>网关 / 证书</span>
                <span className="text-[color:var(--text-primary)]">
                  {server.gatewaySummary.active}/{server.gatewaySummary.total} · {server.gatewaySummary.certificates} 证书
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>权限层级</span>
                <span className="truncate text-right text-[color:var(--text-primary)]">{server.capabilities.permissions.join(' / ') || '无'}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>最近心跳</span>
                <span className="text-[color:var(--text-primary)]">
                  {server.lastHeartbeatAt ? new Date(server.lastHeartbeatAt).toLocaleString('zh-CN', { hour12: false }) : '暂无'}
                </span>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {server.channelSummary.map((channel) => (
                <span key={`${server.id}:${channel.kind}`}>
                  <Badge variant={statusVariant(channel.status)}>{channel.label}</Badge>
                </span>
              ))}
            </div>
          </button>
        ))}
      </div>

      {!current ? (
        <Card>
          <EmptyState icon={Server} title="暂无服务器" description="先接入至少一台服务器，平台首页才会展示探针卡片和详情。" />
        </Card>
      ) : (
        <>
          <ServerContextBar
            servers={servers}
            serverId={current.id}
            onChange={onSelectServer}
            title={current.displayName}
            subtitle="点击服务器卡片或上下文条切换主语，详情页不会再出现突兀的环境下拉。"
          />

          <SegmentedTabs
            value={activeDetailTab}
            onChange={(value) => setActiveDetailTab(value as 'overview' | 'monitor' | 'workloads' | 'channels' | 'tasks')}
            items={[
              { value: 'overview', label: '概览' },
              { value: 'monitor', label: '监控' },
              { value: 'workloads', label: '工作负载' },
              { value: 'channels', label: '通道' },
              { value: 'tasks', label: '任务' },
            ]}
          />

          {activeDetailTab === 'overview' && (
            <div className="space-y-5">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
                <StatCard label="Docker Runtime" value={current.capabilities.dockerVersion || '不可用'} detail={current.capabilities.composeVersion || '未检测到 Compose'} />
                <StatCard label="工作负载" value={`${current.workloadSummary.running}/${current.workloadSummary.total}`} detail={`${current.workloadSummary.composeProjects} 个 Compose 项目`} />
                <StatCard label="网关 / 证书" value={`${current.gatewaySummary.active}/${current.gatewaySummary.total}`} detail={`${current.gatewaySummary.certificates} 张证书 · ${current.gatewaySummary.routes} 条路由`} />
                <StatCard label="权限分层" value={current.capabilities.permissions.join(' / ') || '无'} detail={current.metrics?.collector || '等待采集'} />
              </div>

              <Card title="服务器摘要" subtitle="这里给出当前服务器的资源、通道和网关概况，进一步操作通过对应模块完成。">
                <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
                  <div className="rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--surface-card-strong)] p-4">
                    <div className="flex items-center gap-2 text-sm font-medium text-[color:var(--text-secondary)]">
                      <Activity className="h-4 w-4 text-[var(--brand-500)]" />
                      资源概况
                    </div>
                    <p className="mt-3 text-sm text-[color:var(--text-tertiary)]">
                      采集范围：{current.metrics?.scope === 'host' ? '宿主机视角' : '运行环境视角'} · {current.metrics?.collector || '未采集'}
                    </p>
                    <p className="mt-2 text-sm text-[color:var(--text-tertiary)]">
                      最近心跳：{current.lastHeartbeatAt ? new Date(current.lastHeartbeatAt).toLocaleString('zh-CN') : '暂无'}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--surface-card-strong)] p-4">
                    <div className="flex items-center gap-2 text-sm font-medium text-[color:var(--text-secondary)]">
                      <ShieldCheck className="h-4 w-4 text-emerald-500" />
                      网关与证书
                    </div>
                    <p className="mt-3 text-sm text-[color:var(--text-tertiary)]">
                      当前服务器下已启用 {current.gatewaySummary.active} 个网关，管理 {current.gatewaySummary.certificates} 张证书。
                    </p>
                  </div>
                  <div className="rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--surface-card-strong)] p-4">
                    <div className="flex items-center gap-2 text-sm font-medium text-[color:var(--text-secondary)]">
                      <TerminalSquare className="h-4 w-4 text-amber-500" />
                      管理通道
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {channels.map((channel) => (
                        <span key={channel.id}>
                          <Badge variant={statusVariant(channel.status)}>{channel.label}</Badge>
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </Card>
            </div>
          )}

          {activeDetailTab === 'monitor' && <Monitor apiFetch={apiFetch} serverId={current.id} />}

          {activeDetailTab === 'workloads' && (
            <Card
              title="工作负载摘要"
              subtitle="服务器详情只展示当前摘要和入口，完整容器操作与部署流程放在“工作负载”模块。"
              action={
                <Button onClick={onOpenWorkloads}>
                  <CheckCircle2 className="h-4 w-4" />
                  进入工作负载
                </Button>
              }
            >
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <StatCard label="运行中容器" value={String(current.workloadSummary.running)} detail={`总计 ${current.workloadSummary.total} 个容器`} />
                <StatCard label="Compose 项目" value={String(current.workloadSummary.composeProjects)} detail="按项目折叠展示" />
                <StatCard label="独立容器" value={String(current.workloadSummary.standalone)} detail="单容器直接管理" />
              </div>
            </Card>
          )}

          {activeDetailTab === 'channels' && (
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
              {channels.map((channel) => (
                <div key={channel.id}>
                  <Card title={channel.label} subtitle={channel.detail}>
                    <div className="space-y-3 text-sm text-[color:var(--text-secondary)]">
                      <div className="flex items-center justify-between">
                        <span>状态</span>
                        <Badge variant={statusVariant(channel.status)}>{channel.status}</Badge>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>sudo 模式</span>
                        <span>{channel.sudoMode || '-'}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>指纹</span>
                        <span className="truncate text-xs text-[color:var(--text-tertiary)]">{channel.fingerprint || '-'}</span>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {channel.permissions.map((permission) => (
                          <span key={`${channel.id}:${permission}`}>
                            <Badge variant="default">{permission}</Badge>
                          </span>
                        ))}
                      </div>
                    </div>
                  </Card>
                </div>
              ))}
            </div>
          )}

          {activeDetailTab === 'tasks' && (
            <Card
              title="最近任务"
              subtitle="部署、迁移、证书续签和服务器校验会统一沉淀到任务中心。"
              action={
                <Button variant="secondary" onClick={onOpenTasks}>
                  打开任务中心
                </Button>
              }
            >
              <div className="space-y-3">
                {tasks.slice(0, 6).map((task) => (
                  <div key={task.id} className="rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--surface-card-strong)] px-4 py-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="font-medium text-[color:var(--text-primary)]">{task.kind}</p>
                        <p className="mt-1 text-xs text-[color:var(--text-tertiary)]">{new Date(task.updatedAt).toLocaleString('zh-CN')}</p>
                      </div>
                      <Badge variant={statusVariant(task.status)}>{task.status}</Badge>
                    </div>
                  </div>
                ))}
                {tasks.length === 0 && <EmptyState icon={Activity} title="暂无任务" description="当前服务器还没有执行过部署、迁移或证书续签任务。" />}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
