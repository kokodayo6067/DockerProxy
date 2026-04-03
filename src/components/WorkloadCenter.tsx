import React, { useEffect, useMemo, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { motion } from 'motion/react';
import { ChevronRight, FileCode, Play, RefreshCw, RotateCcw, Save, Search, Square, Terminal, Trash2 } from 'lucide-react';
import { cn } from '../lib/utils';
import { ContainerInfo, ContainerLogEntry, ServerSummary } from '../types';
import { Badge, Button, Card, Field, IconButton, Input, Notice, PaginationControls, SegmentedTabs, Select, Textarea } from './ui/primitives';
import { ServerContextBar } from './ServerContextBar';

type WorkloadCenterProps = {
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
  servers: ServerSummary[];
  selectedServerId: string;
  onSelectServer: (serverId: string) => void;
};

type LogState = {
  containerName: string;
  entries: ContainerLogEntry[];
};

export function WorkloadCenter({ apiFetch, servers, selectedServerId, onSelectServer }: WorkloadCenterProps) {
  const [activeTab, setActiveTab] = useState<'containers' | 'deploy'>('containers');
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [logState, setLogState] = useState<LogState | null>(null);
  const [searchText, setSearchText] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'running' | 'stopped'>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(8);
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  const [imageName, setImageName] = useState('');
  const [serviceName, setServiceName] = useState('');
  const [containerPort, setContainerPort] = useState('');
  const [remarks, setRemarks] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [deployNotice, setDeployNotice] = useState<string | null>(null);
  const [yaml, setYaml] = useState(`version: '3.8'
services:
  web:
    image: nginx:latest
    container_name: web
    restart: unless-stopped
    expose:
      - "80"
    networks:
      - proxy_net

networks:
  proxy_net:
    external: true
    name: proxy_net`);

  const currentServer = useMemo(
    () => servers.find((server) => server.id === selectedServerId) || servers[0] || null,
    [selectedServerId, servers]
  );

  const fetchContainers = async () => {
    if (!currentServer) return;
    setLoading(true);
    try {
      const res = await apiFetch(`/api/workloads/containers?serverId=${encodeURIComponent(currentServer.id)}`);
      setContainers((await res.json()) || []);
    } catch (error) {
      console.error(error);
      setContainers([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchContainers();
  }, [currentServer?.id]);

  useEffect(() => {
    if (imageName && !serviceName) {
      const name = imageName.split(':')[0].split('/').pop() || '';
      setServiceName(name.replace(/[^a-zA-Z0-9_-]/g, ''));
    }
  }, [imageName, serviceName]);

  useEffect(() => {
    setPage(1);
  }, [searchText, statusFilter, pageSize, containers.length]);

  const handleAction = async (id: string, action: string) => {
    if (!currentServer) return;
    try {
      await apiFetch(`/api/workloads/containers/${id}/${action}?serverId=${encodeURIComponent(currentServer.id)}`, { method: 'POST' });
      await fetchContainers();
    } catch (error) {
      console.error(error);
    }
  };

  const viewLogs = async (container: ContainerInfo) => {
    if (!currentServer) return;
    try {
      const res = await apiFetch(
        `/api/workloads/containers/${container.id}/logs?serverId=${encodeURIComponent(currentServer.id)}&structured=true`
      );
      const entries = await res.json();
      setLogState({
        containerName: container.name,
        entries: Array.isArray(entries) ? entries : [],
      });
    } catch (error) {
      console.error(error);
    }
  };

  const matchesContainer = (container: ContainerInfo) => {
    const normalizedQuery = searchText.trim().toLowerCase();
    const matchesStatus =
      statusFilter === 'all' || (statusFilter === 'running' ? container.state === 'running' : container.state !== 'running');
    if (!matchesStatus) return false;
    if (!normalizedQuery) return true;
    const haystack = [container.name, container.image, container.composeProject, container.composeService, container.status]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(normalizedQuery);
  };

  const composeGroupMap = new Map<
    string,
    {
      project: string;
      containers: ContainerInfo[];
      matchingContainers: ContainerInfo[];
    }
  >();
  const standaloneContainers: ContainerInfo[] = [];

  containers.forEach((container) => {
    if (container.sourceKind === 'compose-project' && container.composeProject) {
      const current = composeGroupMap.get(container.composeProject) || {
        project: container.composeProject,
        containers: [],
        matchingContainers: [],
      };
      current.containers.push(container);
      if (matchesContainer(container)) current.matchingContainers.push(container);
      composeGroupMap.set(container.composeProject, current);
      return;
    }

    if (matchesContainer(container)) standaloneContainers.push(container);
  });

  const composeGroups = Array.from(composeGroupMap.values())
    .filter((group) => {
      if (group.matchingContainers.length > 0) return true;
      return group.project.toLowerCase().includes(searchText.trim().toLowerCase());
    })
    .sort((left, right) => left.project.localeCompare(right.project));

  const topLevelItems = [
    ...composeGroups.map((group) => ({ type: 'compose' as const, key: `compose:${group.project}`, group })),
    ...standaloneContainers
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((container) => ({ type: 'container' as const, key: `container:${container.id}`, container })),
  ];

  const totalPages = Math.max(Math.ceil(topLevelItems.length / pageSize), 1);
  const currentPage = Math.min(page, totalPages);
  const pagedItems = topLevelItems.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const pagedComposeItems = pagedItems.filter((item) => item.type === 'compose');
  const pagedStandaloneItems = pagedItems.filter((item) => item.type === 'container');

  const runningContainers = containers.filter((container) => container.state === 'running').length;
  const composeProjectCount = composeGroups.length;
  const standaloneCount = standaloneContainers.length;

  const toggleProject = (projectName: string) => {
    setExpandedProjects((current) => ({
      ...current,
      [projectName]: !current[projectName],
    }));
  };

  const renderContainerActions = (container: ContainerInfo) => (
    <div className="flex items-center justify-end gap-2">
      <IconButton onClick={() => viewLogs(container)} title="查看日志">
        <Terminal className="w-4 h-4" />
      </IconButton>
      {container.state === 'running' ? (
        <IconButton onClick={() => handleAction(container.id, 'stop')} title="停止" variant="danger">
          <Square className="w-4 h-4" />
        </IconButton>
      ) : (
        <IconButton onClick={() => handleAction(container.id, 'start')} title="启动" variant="success">
          <Play className="w-4 h-4" />
        </IconButton>
      )}
      <IconButton onClick={() => handleAction(container.id, 'restart')} title="重启" variant="warning">
        <RotateCcw className="w-4 h-4" />
      </IconButton>
      <IconButton onClick={() => handleAction(container.id, 'remove')} title="删除" variant="danger">
        <Trash2 className="w-4 h-4" />
      </IconButton>
    </div>
  );

  const handleGenerate = async () => {
    if (!imageName.trim() || !serviceName.trim() || !containerPort.trim()) {
      return;
    }
    setIsGenerating(true);
    try {
      setYaml(
        [
          `version: '3.8'`,
          `services:`,
          `  ${serviceName}:`,
          `    image: ${imageName}`,
          `    container_name: ${serviceName}`,
          `    restart: unless-stopped`,
          `    expose:`,
          `      - "${containerPort}"`,
          `    networks:`,
          `      - proxy_net`,
          ``,
          `networks:`,
          `  proxy_net:`,
          `    external: true`,
          `    name: proxy_net`,
        ].join('\n')
      );
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDeploy = async () => {
    if (!currentServer) return;
    setDeploying(true);
    setDeployNotice(null);
    try {
      const res = await apiFetch('/api/deploy/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: currentServer.id, name: serviceName || 'new-service', composeYaml: yaml, remarks }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.details || data.error || '部署失败');
      setDeployNotice(data.message || '部署任务已提交');
      setActiveTab('containers');
      await fetchContainers();
    } catch (error: any) {
      setDeployNotice(error.message || '部署失败');
    } finally {
      setDeploying(false);
    }
  };

  return (
    <div className="space-y-6">
      <ServerContextBar
        servers={servers}
        serverId={currentServer?.id || ''}
        onChange={onSelectServer}
        title="工作负载"
        subtitle="容器管理和部署服务都统一绑定到当前服务器，不再通过页面顶部裸 select 切换环境。"
      />

      <SegmentedTabs
        value={activeTab}
        onChange={(value) => setActiveTab(value as 'containers' | 'deploy')}
        items={[
          { value: 'containers', label: '容器管理' },
          { value: 'deploy', label: '部署服务' },
        ]}
      />

      {activeTab === 'containers' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <StatBox label="运行中容器" value={`${runningContainers}`} detail={`总计 ${containers.length} 个容器`} />
            <StatBox label="Compose 项目" value={`${composeProjectCount}`} detail="按项目折叠展示" />
            <StatBox label="独立容器" value={`${standaloneCount}`} detail="单容器直接管理" />
          </div>

          <Card
            title="容器目录"
            subtitle="Compose 项目和独立容器分区展示，筛选和分页作用于当前服务器上下文。"
            action={
              <Button onClick={fetchContainers} variant="secondary">
                <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
                刷新状态
              </Button>
            }
          >
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4 rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--surface-card-strong)] p-4 lg:grid-cols-[minmax(0,1.4fr)_220px_180px]">
                <Field label="搜索范围" hint="项目名 / 容器名 / 镜像 / 服务名">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--text-tertiary)]" />
                    <Input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="搜索项目名、容器名、镜像或服务名" className="pl-10" />
                  </div>
                </Field>
                <Field label="状态">
                  <Select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as 'all' | 'running' | 'stopped')}>
                    <option value="all">全部状态</option>
                    <option value="running">仅运行中</option>
                    <option value="stopped">仅已停止</option>
                  </Select>
                </Field>
                <Field label="每页数量">
                  <Select value={String(pageSize)} onChange={(event) => setPageSize(Number(event.target.value))}>
                    <option value="5">每页 5 条</option>
                    <option value="8">每页 8 条</option>
                    <option value="12">每页 12 条</option>
                  </Select>
                </Field>
              </div>

              <div className="space-y-6">
                {pagedComposeItems.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <h4 className="text-base font-semibold text-[color:var(--text-primary)]">Compose 项目</h4>
                        <p className="mt-1 text-sm text-[color:var(--text-tertiary)]">按项目折叠展示，适合有依赖关系的工作负载。</p>
                      </div>
                      <Badge variant="default">{composeGroups.length} 个项目</Badge>
                    </div>
                    {pagedComposeItems.map((item) => {
                      if (item.type !== 'compose') return null;
                      const isExpanded = expandedProjects[item.group.project] ?? true;
                      const runningCount = item.group.containers.filter((container) => container.state === 'running').length;
                      return (
                        <div key={item.key} className="overflow-hidden rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--surface-card-strong)]">
                          <button
                            onClick={() => toggleProject(item.group.project)}
                            className="flex w-full items-center justify-between gap-4 bg-[var(--surface-soft)] px-5 py-4 text-left transition hover:bg-[var(--surface-subtle)]"
                          >
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-3">
                                <ChevronRight className={cn('h-4 w-4 text-[color:var(--text-tertiary)] transition-transform', isExpanded && 'rotate-90')} />
                                <span className="font-semibold text-[color:var(--text-primary)]">{item.group.project}</span>
                                <Badge variant="default">Compose 项目</Badge>
                                <Badge variant="success">
                                  {runningCount}/{item.group.containers.length} 运行中
                                </Badge>
                              </div>
                            </div>
                          </button>

                          {isExpanded && (
                            <div className="divide-y divide-[color:var(--border-subtle)]">
                              {(item.group.matchingContainers.length > 0 ? item.group.matchingContainers : item.group.containers).map((container) => (
                                <div key={container.id} className="grid grid-cols-1 items-center gap-4 px-5 py-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_160px_220px]">
                                  <div className="min-w-0">
                                    <p className="truncate font-medium text-[color:var(--text-primary)]">{container.name}</p>
                                    <p className="mt-1 truncate text-sm text-[color:var(--text-tertiary)]">服务：{container.composeService || '-'}</p>
                                  </div>
                                  <div className="min-w-0">
                                    <p className="truncate text-sm text-[color:var(--text-primary)]">{container.image}</p>
                                    <p className="mt-1 truncate text-xs text-[color:var(--text-tertiary)]">端口：{container.ports.length > 0 ? container.ports.join(', ') : '无暴露端口'}</p>
                                  </div>
                                  <div>
                                    <Badge variant={container.state === 'running' ? 'success' : 'danger'}>{container.state}</Badge>
                                    <p className="mt-2 text-xs text-[color:var(--text-tertiary)]">{container.status}</p>
                                  </div>
                                  {renderContainerActions(container)}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {pagedStandaloneItems.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <h4 className="text-base font-semibold text-[color:var(--text-primary)]">独立容器</h4>
                        <p className="mt-1 text-sm text-[color:var(--text-tertiary)]">未归属于 Compose 项目的容器按单项直接管理。</p>
                      </div>
                      <Badge variant="default">{standaloneContainers.length} 个容器</Badge>
                    </div>
                    {pagedStandaloneItems.map((item) => {
                      if (item.type !== 'container') return null;
                      const container = item.container;
                      return (
                        <div key={item.key} className="grid grid-cols-1 items-center gap-4 rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--surface-card-strong)] px-5 py-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_160px_220px]">
                          <div className="min-w-0">
                            <div className="flex items-center gap-3 flex-wrap">
                              <p className="truncate font-semibold text-[color:var(--text-primary)]">{container.name}</p>
                              <Badge variant="default">独立容器</Badge>
                            </div>
                            <p className="mt-2 text-xs text-[color:var(--text-tertiary)]">{container.id}</p>
                          </div>
                          <div className="min-w-0">
                            <p className="truncate text-sm text-[color:var(--text-primary)]">{container.image}</p>
                            <p className="mt-1 truncate text-xs text-[color:var(--text-tertiary)]">端口：{container.ports.length > 0 ? container.ports.join(', ') : '无暴露端口'}</p>
                          </div>
                          <div>
                            <Badge variant={container.state === 'running' ? 'success' : 'danger'}>{container.state}</Badge>
                            <p className="mt-2 text-xs text-[color:var(--text-tertiary)]">{container.status}</p>
                          </div>
                          {renderContainerActions(container)}
                        </div>
                      );
                    })}
                  </div>
                )}

                {topLevelItems.length === 0 && !loading && (
                  <div className="rounded-2xl border border-dashed border-[color:var(--border-strong)] py-12 text-center text-[color:var(--text-tertiary)]">
                    当前筛选条件下没有匹配的 Compose 项目或独立容器
                  </div>
                )}
              </div>

              <PaginationControls page={currentPage} totalPages={totalPages} totalItems={topLevelItems.length} pageSize={pageSize} onPageChange={setPage} />
            </div>
          </Card>
        </div>
      )}

      {activeTab === 'deploy' && (
        <div className="space-y-6">
          {deployNotice && <Notice tone={deployNotice.includes('失败') ? 'danger' : 'success'}>{deployNotice}</Notice>}

          <Card title="部署步骤" subtitle="先确定目标服务器，再生成 Compose，最后提交为部署任务。">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <StatBox label="步骤 1" value={currentServer?.displayName || '-'} detail="当前部署服务器" />
              <StatBox label="步骤 2" value="生成 Compose" detail="输入镜像、服务名和容器端口" />
              <StatBox label="步骤 3" value="提交任务" detail="部署结果会进入任务中心" />
            </div>
          </Card>

          <Card title="项目配置" subtitle="优先选择服务器，再填写镜像、服务名和端口后生成 Compose 配置。">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="镜像名">
                <Input value={imageName} onChange={(event) => setImageName(event.target.value)} placeholder="例如: nginx:latest" />
              </Field>
              <Field label="服务名">
                <Input value={serviceName} onChange={(event) => setServiceName(event.target.value)} placeholder="例如: web" />
              </Field>
              <Field label="容器内端口">
                <Input value={containerPort} onChange={(event) => setContainerPort(event.target.value)} placeholder="例如: 80" />
              </Field>
              <Field label="备注">
                <Input value={remarks} onChange={(event) => setRemarks(event.target.value)} placeholder="可选说明" />
              </Field>
            </div>
            <div className="mt-5 flex justify-end">
              <Button onClick={handleGenerate} disabled={isGenerating || !imageName.trim() || !serviceName.trim() || !containerPort.trim()}>
                <FileCode className={isGenerating ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
                生成配置
              </Button>
            </div>
          </Card>

          <Card
            title="Docker Compose 编辑器"
            subtitle="生成后可直接编辑 Compose，再提交到当前服务器。"
            action={
              <Button onClick={handleDeploy} variant="success" disabled={deploying || !currentServer?.capabilities.modules.deploy}>
                <Play className={deploying ? 'h-4 w-4 animate-pulse' : 'h-4 w-4'} />
                {deploying ? '提交中' : '提交部署任务'}
              </Button>
            }
          >
            {!currentServer?.capabilities.modules.deploy && (
              <Notice tone="warning">当前服务器缺少 deploy 能力，无法执行 Compose 部署。</Notice>
            )}
            <div className="relative">
              <Textarea
                value={yaml}
                onChange={(event) => setYaml(event.target.value)}
                className="h-[420px] resize-none bg-[var(--surface-subtle)] font-mono text-sm text-emerald-700 dark:text-emerald-300"
                spellCheck={false}
              />
              <div className="absolute right-4 top-4 flex gap-2">
                <IconButton title="保存草稿">
                  <Save className="h-4 w-4" />
                </IconButton>
              </div>
            </div>
          </Card>
        </div>
      )}

      <AnimatePresence>
        {logState && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(2,6,23,0.58)] p-6 backdrop-blur-sm"
          >
            <div className="flex max-h-[80vh] w-full max-w-5xl flex-col overflow-hidden rounded-[1.75rem] border border-[color:var(--border-subtle)] bg-[var(--surface-card)] shadow-2xl">
              <div className="flex items-center justify-between border-b border-[color:var(--border-subtle)] px-6 py-4">
                <h3 className="flex items-center gap-2 text-lg font-semibold text-[color:var(--text-primary)]">
                  <Terminal className="h-5 w-5 text-[var(--brand-500)]" />
                  {logState.containerName} 日志
                </h3>
                <IconButton onClick={() => setLogState(null)} title="关闭日志">
                  <Trash2 className="h-5 w-5" />
                </IconButton>
              </div>
              <div className="overflow-auto bg-[var(--console-bg)] p-4">
                <table className="w-full border-collapse font-mono text-sm text-[var(--console-text)]">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-[0.18em] text-[var(--console-border)]">
                      <th className="pb-3 pr-4">时间</th>
                      <th className="pb-3 pr-4">流</th>
                      <th className="pb-3">内容</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logState.entries.map((entry, index) => (
                      <tr key={`${entry.timestamp || 'none'}-${index}`} className="border-t border-[var(--console-border)]/30 align-top">
                        <td className="whitespace-nowrap py-3 pr-4 text-xs text-[var(--console-border)]">
                          {entry.timestamp ? new Date(entry.timestamp).toLocaleString('zh-CN', { hour12: false }) : '-'}
                        </td>
                        <td className="py-3 pr-4">
                          <Badge variant={entry.stream === 'stderr' ? 'danger' : 'default'}>{entry.stream}</Badge>
                        </td>
                        <td className="py-3 whitespace-pre-wrap break-all">{entry.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {logState.entries.length === 0 && <div className="py-8 text-center text-sm text-[var(--console-border)]">当前容器没有可显示的日志</div>}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function StatBox({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--surface-card)] px-5 py-4">
      <p className="text-xs uppercase tracking-[0.18em] text-[color:var(--text-tertiary)]">{label}</p>
      <p className="mt-3 text-2xl font-semibold tracking-tight text-[color:var(--text-primary)]">{value}</p>
      <p className="mt-2 text-sm text-[color:var(--text-tertiary)]">{detail}</p>
    </div>
  );
}
