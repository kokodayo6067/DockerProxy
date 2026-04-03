import React, { useEffect, useRef, useState } from 'react';
import {
  Activity,
  AlertCircle,
  Ban,
  CheckCircle2,
  ChevronRight,
  Clock,
  Download,
  Folder,
  HardDrive,
  Layers,
  Network,
  Package,
  Play,
  RefreshCw,
  RotateCcw,
  Server,
  ShieldCheck,
  Terminal,
  Truck,
} from 'lucide-react';
import { cn } from '../lib/utils';
import {
  EnvironmentSummary,
  MigrationEvent,
  MigrationPlan,
  MigrationProject,
  MigrationResourceImpact,
  MigrationServiceInfo,
  MigrationSession,
} from '../types';
import { Badge, Button, Card, Checkbox, Notice, PageHeader, SegmentedTabs, Select, StatCard } from './ui/primitives';

type MigrationConsoleProps = {
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
  environments: EnvironmentSummary[];
};

const PHASES = [
  { key: 'discover', label: '发现范围' },
  { key: 'plan', label: '生成计划' },
  { key: 'preflight', label: '预检阻断' },
  { key: 'sync', label: '同步数据' },
  { key: 'stage_restore', label: '隔离恢复' },
  { key: 'cutover', label: '切换上线' },
  { key: 'verify_or_rollback', label: '验证/回滚' },
] as const;

const statusLabelMap: Record<string, string> = {
  idle: '草案',
  planning: '规划中',
  plan_ready: '待预检',
  blocked: '已阻断',
  running: '执行中',
  cutover_pending: '待切换',
  verifying: '验证中',
  completed: '已完成',
  rolled_back: '已回滚',
  failed: '失败',
};

const riskVariantMap: Record<string, 'default' | 'warning' | 'danger' | 'success'> = {
  low: 'default',
  medium: 'warning',
  high: 'danger',
};

const impactGroupMeta = {
  'read-only inspect': { title: '只读检查', badge: 'default' as const },
  'new staging resource': { title: '隔离创建', badge: 'success' as const },
  'needs cutover': { title: '切换阶段', badge: 'warning' as const },
  blocked: { title: '阻断项', badge: 'danger' as const },
};

const impactClassificationLabelMap: Record<string, string> = {
  'read-only inspect': '只读检查',
  'new staging resource': '隔离创建',
  'needs cutover': '切换阶段',
  blocked: '阻断',
};

const stateVariantMap: Record<string, 'default' | 'warning' | 'danger' | 'success'> = {
  idle: 'default',
  planning: 'warning',
  plan_ready: 'warning',
  blocked: 'danger',
  running: 'warning',
  cutover_pending: 'warning',
  verifying: 'warning',
  completed: 'success',
  rolled_back: 'default',
  failed: 'danger',
};

const sectionTitleClass = 'mb-3 text-sm font-medium text-[color:var(--text-secondary)]';
const panelClass = 'rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--surface-card-strong)] p-5';
const compactPanelClass = 'rounded-xl border border-[color:var(--border-subtle)] bg-[var(--surface-card-strong)] p-4';
const infoRowClass = 'rounded-xl border border-[color:var(--border-subtle)] bg-[var(--surface-card-strong)] px-4 py-3';
const emptyPanelClass =
  'rounded-xl border border-dashed border-[color:var(--border-strong)] bg-[var(--surface-subtle)] p-6 text-sm text-[color:var(--text-tertiary)]';
const tableHeadClass = 'border-b border-[color:var(--border-subtle)] text-sm text-[color:var(--text-tertiary)]';
const tableBodyClass = 'divide-y divide-[color:var(--border-subtle)]';
const terminalShellClass =
  'h-[420px] w-full overflow-auto rounded-xl border border-[color:var(--console-border)] p-4 font-mono text-sm';
const sourceCardClass =
  'w-full rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--surface-card-strong)] p-4 text-left transition hover:border-[color:var(--border-strong)] hover:bg-[var(--surface-card)]';

const formatBytes = (bytes?: number | null) => {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

const formatDateTime = (value?: string) => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toLocaleDateString('zh-CN')} ${date.toLocaleTimeString('zh-CN', { hour12: false })}`;
};

const getStatusVariant = (status?: string) => stateVariantMap[status || 'idle'] || 'default';

const getRiskRows = (plan: MigrationPlan | null) => {
  if (!plan) return [];
  const riskRows = plan.risks.map((risk) => ({
    id: risk.id,
    kind: 'risk',
    severity: risk.level,
    title: risk.title,
    target: risk.scope,
    reason: risk.reason,
    blocking: risk.blocking,
    recommendation: risk.recommendation,
  }));
  const conflictRows = plan.conflicts.map((conflict) => ({
    id: conflict.id,
    kind: 'conflict',
    severity: 'high',
    title: conflict.kind,
    target: conflict.target,
    reason: conflict.reason,
    blocking: conflict.blocking,
    recommendation: conflict.recommendation,
  }));
  return [...conflictRows, ...riskRows];
};

const pickServiceOptions = (projects: MigrationProject[], projectPath: string) =>
  projects.find((project) => project.path === projectPath)?.services || [];

function classifyPhaseState(session: MigrationSession | null, phaseKey: string) {
  if (!session) return 'pending';
  const currentIndex = PHASES.findIndex((phase) => phase.key === session.currentPhase);
  const phaseIndex = PHASES.findIndex((phase) => phase.key === phaseKey);
  if (session.status === 'failed' && session.currentPhase === phaseKey) return 'failed';
  if (session.status === 'rolled_back' && phaseKey === 'verify_or_rollback') return 'rolled_back';
  if (phaseIndex < currentIndex) return 'completed';
  if (phaseIndex === currentIndex) return 'current';
  return 'pending';
}

function riskCounter(plan: MigrationPlan | null) {
  return {
    high: plan?.risks.filter((risk) => risk.level === 'high').length || 0,
    medium: plan?.risks.filter((risk) => risk.level === 'medium').length || 0,
    low: plan?.risks.filter((risk) => risk.level === 'low').length || 0,
  };
}

function mergeSessionEvent(current: MigrationSession | null, event: MigrationEvent) {
  if (event.type === 'session_summary' && event.meta?.session) {
    return event.meta.session;
  }
  return current;
}

export function MigrationConsole({ apiFetch, environments }: MigrationConsoleProps) {
  const [projects, setProjects] = useState<MigrationProject[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [activeTab, setActiveTab] = useState<'config' | 'impact' | 'execution' | 'result'>('config');
  const [sourceEnvironmentId, setSourceEnvironmentId] = useState('');
  const [targetEnvironmentId, setTargetEnvironmentId] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [rootService, setRootService] = useState('');
  const [session, setSession] = useState<MigrationSession | null>(null);
  const [logs, setLogs] = useState<MigrationEvent[]>([]);
  const [planning, setPlanning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [loadingArtifacts, setLoadingArtifacts] = useState(false);
  const [artifactPreview, setArtifactPreview] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logLevelFilter, setLogLevelFilter] = useState<'all' | 'info' | 'warn' | 'error' | 'success'>('all');
  const [serviceFilter, setServiceFilter] = useState('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const sourceEnvironment =
    environments.find((environment) => environment.id === sourceEnvironmentId) ||
    environments.find((environment) => environment.isLocal) ||
    null;
  const targetEnvironment =
    environments.find((environment) => environment.id === targetEnvironmentId) ||
    environments.find((environment) => !environment.isLocal && environment.capabilities.modules?.migrateTarget) ||
    null;
  const sourceEnvironmentOptions = environments.filter((environment) => environment.capabilities.modules?.docker);
  const targetEnvironmentOptions = environments.filter(
    (environment) => environment.capabilities.modules?.migrateTarget && environment.id !== sourceEnvironmentId
  );

  const selectedProjectServices = pickServiceOptions(projects, projectPath);
  const selectedProject = projects.find((project) => project.path === projectPath) || null;
  const composeProjects = projects.filter((project) => project.sourceKind === 'compose-project');
  const standaloneProjects = projects.filter((project) => project.sourceKind === 'standalone-container');
  const isComposeSource = selectedProject?.sourceKind === 'compose-project';
  const effectiveRootService = isComposeSource ? selectedProjectServices[0] || rootService : rootService;
  const plan = session?.plan || null;
  const result = session?.result;
  const rollbackSummary = result?.rollback;
  const riskCounts = riskCounter(plan);
  const timelineState = PHASES.map((phase) => ({
    ...phase,
    state: classifyPhaseState(session, phase.key),
  }));
  const riskRows = getRiskRows(plan);
  const currentPhaseLabel = session?.currentPhase ? PHASES.find((phase) => phase.key === session.currentPhase)?.label || session.currentPhase : '';
  const sourceDirectoryFailure =
    (result?.message || '').includes('源服务器项目目录') || (rollbackSummary?.message || '').includes('源服务器项目目录');
  const autoHandledNetworks = Array.from(
    new Set(
      [
        ...(plan?.readOnlyInspect || []),
        ...(plan?.needsCutover || []),
        ...(plan?.stagingResources || []),
      ]
        .filter((item) => item.kind === 'network' && item.detail.includes('自动创建'))
        .map((item) => item.label)
    )
  );

  const filteredLogs = logs.filter((entry) => {
    if (entry.type === 'heartbeat') return false;
    if (logLevelFilter !== 'all' && entry.level !== logLevelFilter) return false;
    if (serviceFilter !== 'all' && entry.service !== serviceFilter) return false;
    return true;
  });

  useEffect(() => {
    if (!sourceEnvironmentId && sourceEnvironmentOptions.length > 0) {
      setSourceEnvironmentId(sourceEnvironmentOptions[0].id);
    }
    if ((!targetEnvironmentId || !targetEnvironmentOptions.some((environment) => environment.id === targetEnvironmentId)) && targetEnvironmentOptions.length > 0) {
      setTargetEnvironmentId(targetEnvironmentOptions[0].id);
    }
  }, [sourceEnvironmentId, sourceEnvironmentOptions, targetEnvironmentId, targetEnvironmentOptions]);

  const reloadProjects = async (preferredProjectPath?: string) => {
    if (!sourceEnvironmentId) {
      setProjects([]);
      setLoadingProjects(false);
      return;
    }
    setLoadingProjects(true);
    try {
      const res = await apiFetch(`/api/migrate/projects?environmentId=${encodeURIComponent(sourceEnvironmentId)}`);
      const data = await res.json();
      const nextProjects = Array.isArray(data) ? data : [];
      setProjects(nextProjects);
      if (nextProjects.length === 0) {
        setProjectPath('');
        setRootService('');
        return;
      }

      const nextSelectedProject =
        nextProjects.find((project) => project.path === preferredProjectPath) ||
        nextProjects.find((project) => project.path === projectPath) ||
        nextProjects[0];

      setProjectPath(nextSelectedProject.path);
      setRootService(nextSelectedProject.services[0] || '');
      setError(null);
    } catch (loadError: any) {
      setError(loadError.message || '加载迁移项目失败');
    } finally {
      setLoadingProjects(false);
    }
  };

  useEffect(() => {
    if (!autoScroll || !terminalRef.current) return;
    terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
  }, [filteredLogs, autoScroll]);

  useEffect(() => {
    if (sourceEnvironmentId) {
      reloadProjects();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiFetch, sourceEnvironmentId]);

  useEffect(() => {
    const options = pickServiceOptions(projects, projectPath);
    if (options.length === 0) {
      setRootService('');
      return;
    }
    if (!options.includes(rootService)) {
      setRootService(options[0]);
    }
  }, [projectPath, projects, rootService]);

  useEffect(() => {
    if (!session?.id) return;
    streamAbortRef.current?.abort();
    const controller = new AbortController();
    streamAbortRef.current = controller;

    const consume = async () => {
      try {
        const res = await apiFetch(`/api/migrate/sessions/${session.id}/events`, { signal: controller.signal });
        const reader = res.body?.getReader();
        if (!reader) return;
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const event = JSON.parse(trimmed) as MigrationEvent;
              if (event.type !== 'heartbeat') {
                setLogs((previous) => {
                  const next = [...previous, event];
                  return next.slice(-800);
                });
              }
              setSession((current) => mergeSessionEvent(current, event));
            } catch {
              // ignore malformed line
            }
          }
        }
      } catch (streamError: any) {
        if (controller.signal.aborted) return;
        setError(streamError.message || '订阅迁移事件失败');
      }
    };

    consume();
    return () => controller.abort();
  }, [apiFetch, session?.id]);

  const generatePlan = async () => {
    if (!projectPath || !effectiveRootService || !sourceEnvironmentId || !targetEnvironmentId) {
      setError('请先选择源服务器、迁移对象和目标服务器。');
      return;
    }

    setError(null);
    setPlanning(true);
    setLogs([]);
    setArtifactPreview(null);
    try {
      const res = await apiFetch('/api/migrate/plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectPath,
          rootService: effectiveRootService,
          sourceEnvironmentId,
          targetEnvironmentId,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.details || data.error || '生成计划失败');
      }
      setSession(data);
      setLogs([]);
      setActiveTab('impact');
    } catch (planError: any) {
      setError(planError.message || '生成计划失败');
    } finally {
      setPlanning(false);
    }
  };

  const startMigration = async () => {
    if (!session) return;
    setError(null);
    setStarting(true);
    try {
      const res = await apiFetch(`/api/migrate/sessions/${session.id}/start`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.details || data.error || '启动迁移失败');
      }
      setSession(data);
      setArtifactPreview(null);
      setActiveTab('execution');
    } catch (startError: any) {
      setError(startError.message || '启动迁移失败');
    } finally {
      setStarting(false);
    }
  };

  const rollbackMigration = async () => {
    if (!session) return;
    setError(null);
    setRollingBack(true);
    try {
      const res = await apiFetch(`/api/migrate/sessions/${session.id}/rollback`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.details || data.error || '执行回滚失败');
      }
      setSession(data);
      setArtifactPreview(null);
      setActiveTab('result');
    } catch (rollbackError: any) {
      setError(rollbackError.message || '执行回滚失败');
    } finally {
      setRollingBack(false);
    }
  };

  const exportReport = async () => {
    if (!session) return;
    setExporting(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/migrate/sessions/${session.id}/artifacts`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.details || data.error || '导出报告失败');
      }
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `migration-report-${session.id}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (exportError: any) {
      setError(exportError.message || '导出报告失败');
    } finally {
      setExporting(false);
    }
  };

  const loadArtifactsPreview = async () => {
    if (!session) return;
    setLoadingArtifacts(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/migrate/sessions/${session.id}/artifacts`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.details || data.error || '加载产物失败');
      }
      setArtifactPreview(data);
    } catch (artifactError: any) {
      setError(artifactError.message || '加载产物失败');
    } finally {
      setLoadingArtifacts(false);
    }
  };

  const showStartButton = session?.status === 'plan_ready';
  const showRollbackButton = !!session && ['completed', 'failed', 'rolled_back'].includes(session.status);
  const serviceFilterOptions = session ? ['all', ...session.selectedServices] : ['all'];
  const tabItems = [
    {
      value: 'config',
      label: '1. 选择来源',
      icon: Server,
      disabled: false,
    },
    {
      value: 'impact',
      label: '2. 审查计划',
      icon: Layers,
      disabled: !session,
    },
    {
      value: 'execution',
      label: '3. 执行迁移',
      icon: Terminal,
      disabled: !session || !['running', 'cutover_pending', 'verifying', 'completed', 'failed', 'rolled_back'].includes(session.status),
    },
    {
      value: 'result',
      label: '4. 查看结果',
      icon: RotateCcw,
      disabled: !session || !['blocked', 'completed', 'failed', 'rolled_back'].includes(session.status),
    },
  ] as const;

  const stepGuide = {
    config: {
      title: '先选来源，再确认源/目标服务器',
      description: '系统会自动识别 Compose 整组或独立容器；如果原始目录不可读，会自动降级为运行态快照。',
    },
    impact: {
      title: '确认迁移范围、风险和阻断项',
      description: '先看影响面和风险，确认没有问题后再开始迁移。',
    },
    execution: {
      title: '观察实时进度和命令日志',
      description: '迁移执行过程中重点看阶段时间线、传输进度和错误日志。',
    },
    result: {
      title: '查看结果、导出报告或回滚',
      description: '迁移结束后在这里确认结果，必要时导出报告或执行回滚。',
    },
  }[activeTab];

  const handleTabChange = (next: 'config' | 'impact' | 'execution' | 'result') => {
    const target = tabItems.find((item) => item.value === next);
    if (target?.disabled) return;
    setActiveTab(next);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Truck}
        title="Docker 服务级迁移控制台"
        description="选择来源、生成计划、执行迁移与回滚。"
      />

      {error && (
        <Notice tone="danger">
          {error}
        </Notice>
      )}

      <Card className="border-[color:var(--border-strong)] bg-[linear-gradient(135deg,var(--surface-card-strong),var(--surface-soft))]">
        <div className="grid grid-cols-1 2xl:grid-cols-[minmax(0,1.6fr)_420px] gap-6 items-start">
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <div className="flex items-center gap-3">
                  <Badge variant={getStatusVariant(session?.status)}>{statusLabelMap[session?.status || 'idle']}</Badge>
                  {session?.id && <span className="text-xs font-mono text-[color:var(--text-tertiary)]">{session.id.slice(0, 8)}</span>}
                </div>
                <h3 className="mt-3 text-xl font-semibold text-[color:var(--text-primary)]">
                  {session ? `${session.projectName} / ${session.rootService}` : '先选择 Compose 项目或独立容器'}
                </h3>
                <p className="mt-2 text-sm text-[color:var(--text-tertiary)]">
                  {session?.currentPhase ? `${currentPhaseLabel} / ${session.currentStep}` : '建议先选择迁移来源，再填写目标主机并生成计划。'}
                </p>
              </div>
              <div className="min-w-[220px]">
                <div className="flex items-center justify-between text-sm mb-2">
                  <span className="text-[color:var(--text-tertiary)]">总体进度</span>
                  <span className="font-semibold text-[color:var(--text-primary)]">{session?.progress.percent?.toFixed(1) || '0.0'}%</span>
                </div>
                <div className="h-3 w-full overflow-hidden rounded-full border border-[color:var(--border-subtle)] bg-[var(--surface-card-strong)]">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all',
                      session?.status === 'completed'
                        ? 'bg-emerald-500'
                        : session?.status === 'failed'
                          ? 'bg-rose-500'
                          : session?.status === 'rolled_back'
                            ? 'bg-amber-500'
                            : 'bg-blue-500'
                    )}
                    style={{ width: `${Math.min(session?.progress.percent || 0, 100)}%` }}
                  />
                </div>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <StatCard label="服务数" value={String(session?.serviceCount || 0)} />
              <StatCard label="风险数" value={String((riskCounts.high || 0) + (riskCounts.medium || 0) + (riskCounts.low || 0))} />
              <StatCard label="阻断项" value={String(session?.blockingCount || 0)} />
            </div>
          </div>
          <div className="space-y-4 rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--surface-card-strong)] p-5">
            <div className="flex items-center gap-2">
              <Server className="w-4 h-4 text-[var(--brand-500)]" />
              <p className="font-medium text-[color:var(--text-primary)]">服务器摘要</p>
            </div>
            <div className="space-y-3 text-sm">
              <SummaryLine label="源服务器" value={sourceEnvironment?.displayName || '-'} />
              <SummaryLine label="目标服务器" value={targetEnvironment?.displayName || session?.target.host || '-'} />
              <SummaryLine label="目标主机" value={session?.target.host || targetEnvironment?.host || '-'} />
              <SummaryLine label="SSH 用户" value={session?.target.username || targetEnvironment?.username || '-'} />
              <SummaryLine label="工作目录" value={session?.target.workdir || '/var/lib/docker-proxy-migrate/<sessionId>'} mono />
            </div>
          </div>
        </div>
      </Card>

      <SegmentedTabs
        value={activeTab}
        onChange={(next) => handleTabChange(next as 'config' | 'impact' | 'execution' | 'result')}
        fullWidth
        className="w-full overflow-hidden"
        items={tabItems.map((item) => ({ ...item }))}
      />

      <Card className="border-[color:var(--border-subtle)] bg-[var(--surface-soft)]" contentClassName="p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-[color:var(--text-tertiary)]">当前步骤</p>
            <h3 className="mt-2 text-lg font-semibold text-[color:var(--text-primary)]">{stepGuide.title}</h3>
            <p className="mt-1 text-sm text-[color:var(--text-tertiary)]">{stepGuide.description}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {activeTab === 'config' && (
              <Button onClick={generatePlan} disabled={planning || loadingProjects}>
                {planning ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Layers className="h-4 w-4" />}
                生成计划
              </Button>
            )}
            {activeTab === 'impact' && (
              <>
                <Button onClick={() => setActiveTab('config')} variant="secondary">
                  返回修改
                </Button>
                <Button onClick={startMigration} disabled={!showStartButton || starting} variant="success">
                  {starting ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                  开始迁移
                </Button>
              </>
            )}
            {activeTab === 'execution' && ['completed', 'failed', 'rolled_back'].includes(session?.status || '') && (
              <Button onClick={() => setActiveTab('result')} variant="secondary">
                查看结果
              </Button>
            )}
            {activeTab === 'result' && (
              <>
                {showRollbackButton && (
                  <Button onClick={rollbackMigration} disabled={rollingBack} variant="warning">
                    {rollingBack ? <RefreshCw className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                    执行回滚
                  </Button>
                )}
                <Button onClick={exportReport} disabled={!session || exporting} variant="secondary">
                  {exporting ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                  导出报告
                </Button>
              </>
            )}
          </div>
        </div>
      </Card>

      {activeTab === 'config' && (
        <Card
          title="迁移配置"
          action={
            <Button onClick={() => reloadProjects(projectPath)} disabled={loadingProjects} variant="secondary" size="sm">
              <RefreshCw className={cn('h-4 w-4', loadingProjects && 'animate-spin')} />
              刷新来源
            </Button>
          }
        >
          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-6">
            <div className="space-y-5 rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--surface-soft)] p-5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Package className="h-4 w-4 text-emerald-500" />
                  <p className="font-medium text-[color:var(--text-primary)]">选择来源</p>
                </div>
                {selectedProject && (
                  <Badge variant={isComposeSource ? 'default' : 'success'}>
                    {isComposeSource ? `整组迁移 · ${selectedProjectServices.length} 个服务` : '单容器迁移'}
                  </Badge>
                )}
              </div>

              {projects.length === 0 ? (
                <div className={emptyPanelClass}>当前没有可用来源。</div>
              ) : (
                <div className="space-y-4">
                  {composeProjects.length > 0 && (
                    <div className="space-y-3">
                      <p className="text-sm font-medium text-[color:var(--text-secondary)]">Compose 项目</p>
                      <div className="max-h-[20rem] space-y-3 overflow-auto pr-1">
                        {composeProjects.map((project) => {
                          const selected = project.path === projectPath;
                          return (
                            <button
                              key={project.path}
                              type="button"
                              onClick={() => setProjectPath(project.path)}
                              className={cn(
                                sourceCardClass,
                                selected && 'border-[color:var(--brand-500)] bg-[var(--brand-soft)] shadow-[0_16px_32px_-28px_rgba(37,99,235,0.45)]'
                              )}
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <p className="font-semibold text-[color:var(--text-primary)]">{project.name}</p>
                                    <Badge variant="default">Compose</Badge>
                                    {project.planningMode === 'runtime-snapshot' && <Badge variant="warning">运行态快照</Badge>}
                                  </div>
                                  <p className="mt-1 text-xs text-[color:var(--text-tertiary)]">
                                    {project.warning || `${project.runningContainerCount || 0} 个运行容器`}
                                  </p>
                                </div>
                                {selected && <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-[var(--brand-600)]" />}
                              </div>
                              <div className="mt-3 flex flex-wrap gap-2">
                                {project.services.map((service) => (
                                  <span
                                    key={service}
                                    className="rounded-full border border-[color:var(--border-subtle)] bg-[var(--surface-card)] px-3 py-1 text-xs text-[color:var(--text-secondary)]"
                                  >
                                    {service}
                                  </span>
                                ))}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {standaloneProjects.length > 0 && (
                    <div className="space-y-3">
                      <p className="text-sm font-medium text-[color:var(--text-secondary)]">独立容器</p>
                      <div className="space-y-3">
                        {standaloneProjects.map((project) => {
                          const selected = project.path === projectPath;
                          return (
                            <button
                              key={project.path}
                              type="button"
                              onClick={() => setProjectPath(project.path)}
                              className={cn(
                                sourceCardClass,
                                selected && 'border-[color:var(--brand-500)] bg-[var(--brand-soft)] shadow-[0_16px_32px_-28px_rgba(37,99,235,0.45)]'
                              )}
                            >
                              <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <p className="font-semibold text-[color:var(--text-primary)]">{project.name}</p>
                                    <Badge variant="success">独立容器</Badge>
                                  </div>
                                  <p className="mt-1 text-xs text-[color:var(--text-tertiary)]">
                                    {project.services[0] || project.name}
                                  </p>
                                </div>
                                {selected && <CheckCircle2 className="h-5 w-5 shrink-0 text-[var(--brand-600)]" />}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {selectedProject && (
                <div className="space-y-3 rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--surface-card)] p-4 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-[color:var(--text-primary)]">{selectedProject.name}</p>
                      <p className="mt-1 text-xs text-[color:var(--text-tertiary)]">
                        {selectedProject.description ||
                          (selectedProject.sourceType === 'runtime-container'
                            ? '来自当前独立容器运行态'
                            : selectedProject.sourceType === 'runtime-compose'
                              ? '来自当前 Docker 运行态'
                              : '来自平台管理目录')}
                      </p>
                    </div>
                    <Badge variant={selectedProject.planningMode === 'runtime-snapshot' ? 'warning' : 'success'}>
                      {selectedProject.planningMode === 'runtime-snapshot' ? '快照来源' : '原始编排'}
                    </Badge>
                  </div>

                  {selectedProject.warning && <Notice tone="warning">{selectedProject.warning}</Notice>}

                  {!isComposeSource && selectedProjectServices.length > 1 && (
                    <div className="flex flex-wrap gap-2">
                      {selectedProjectServices.map((service) => (
                        <button
                          key={service}
                          type="button"
                          onClick={() => setRootService(service)}
                          className={cn(
                            'rounded-full border px-3 py-1 text-xs transition',
                            rootService === service
                              ? 'border-[color:var(--brand-500)] bg-[var(--brand-soft)] text-[var(--brand-600)]'
                              : 'border-[color:var(--border-subtle)] bg-[var(--surface-card-strong)] text-[color:var(--text-secondary)]'
                          )}
                        >
                          {service}
                        </button>
                      ))}
                    </div>
                  )}

                  {selectedProject.planningMode === 'runtime-snapshot' && (
                    <p className="text-xs leading-6 text-[color:var(--text-tertiary)]">
                      当前来源基于运行态快照，缺少原始编排文件时会更保守。
                    </p>
                  )}
                </div>
              )}
            </div>

            <div className="space-y-5 rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--surface-card-strong)] p-5">
              <div className="flex items-center gap-2">
                <Server className="h-4 w-4 text-[var(--brand-500)]" />
                <p className="font-medium text-[color:var(--text-primary)]">服务器选择</p>
              </div>
              <p className="text-sm text-[color:var(--text-tertiary)]">迁移统一复用“接入中心”里的服务器凭据和权限评估，不再单独填写 SSH 表单。</p>
              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                  <div className="rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--surface-card)] p-4">
                    <p className="text-sm font-medium text-[color:var(--text-secondary)]">源服务器</p>
                    <p className="mt-1 text-xs text-[color:var(--text-tertiary)]">选择工作负载当前所在的服务器。系统会基于该服务器上的容器/Compose 状态生成计划。</p>
                    <Select className="mt-4" value={sourceEnvironmentId} onChange={(event) => setSourceEnvironmentId(event.target.value)}>
                      {sourceEnvironmentOptions.map((environment) => (
                        <option key={environment.id} value={environment.id}>
                          {environment.displayName} · {environment.host}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--surface-card)] p-4">
                    <p className="text-sm font-medium text-[color:var(--text-secondary)]">目标服务器</p>
                    <p className="mt-1 text-xs text-[color:var(--text-tertiary)]">目标服务器需要具备 inspect / operate / elevated 能力，才能完成隔离恢复、切换和回滚。</p>
                    <Select className="mt-4" value={targetEnvironmentId} onChange={(event) => setTargetEnvironmentId(event.target.value)}>
                      {targetEnvironmentOptions.map((environment) => (
                        <option key={environment.id} value={environment.id}>
                          {environment.displayName} · {environment.host}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
                {targetEnvironment ? (
                  <div className="rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--surface-card)] p-4 text-sm">
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      <SummaryLine label="目标地址" value={`${targetEnvironment.host}:${targetEnvironment.port}`} />
                      <SummaryLine label="SSH 用户" value={targetEnvironment.username || '-'} />
                      <SummaryLine label="工作目录" value={targetEnvironment.workdir} mono />
                      <SummaryLine label="Sudo 模式" value={targetEnvironment.capabilities.sudoMode} />
                    </div>
                    {targetEnvironment.capabilities.warnings.length > 0 && (
                      <div className="mt-4">
                        <Notice tone="warning">{targetEnvironment.capabilities.warnings.join('；')}</Notice>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className={emptyPanelClass}>请先在“接入中心”页面添加并校验一个可迁移的远端服务器。</div>
                )}
              </div>
            </div>
          </div>
        </Card>
      )}

      {activeTab === 'impact' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 xl:grid-cols-[1.3fr_0.9fr] gap-6">
            <Card
              title="迁移范围与影响面"
            >
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="space-y-4">
                  <div>
                    <p className={sectionTitleClass}>迁移服务闭包</p>
                    <div className="space-y-3">
                      <div className="flex items-center gap-3 px-4 py-3 rounded-xl border border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-300">
                        <Package className="w-5 h-5" />
                        <div>
                          <p className="font-medium">{selectedProject?.sourceKind === 'compose-project' ? 'Compose 项目整组' : 'Root Service'}</p>
                          <p className="text-sm">
                            {selectedProject?.sourceKind === 'compose-project'
                              ? `实际迁移 ${(plan?.selectedServices.length || selectedProjectServices.length || 0)} 个服务`
                              : plan?.rootService || rootService || '-'}
                          </p>
                        </div>
                      </div>
                      {(plan?.dependencyServices || []).map((service) => (
                        <div key={service} className={cn(infoRowClass, 'flex items-center gap-3')}>
                          <ChevronRight className="w-4 h-4 text-[color:var(--text-tertiary)]" />
                          <div>
                            <p className="font-medium text-[color:var(--text-primary)]">{service}</p>
                            <p className="text-sm text-[color:var(--text-tertiary)]">自动识别依赖服务</p>
                          </div>
                        </div>
                      ))}
                      {plan && plan.dependencyServices.length === 0 && (
                        <div className={cn(infoRowClass, 'text-sm text-[color:var(--text-tertiary)]')}>
                          {selectedProject?.sourceKind === 'compose-project'
                            ? '当前来源是 Compose 项目，已按整组迁移策略覆盖全部服务。'
                            : '当前根服务没有解析出 Compose 内依赖，按单服务范围执行。'}
                        </div>
                      )}
                    </div>
                  </div>
                  <div>
                    <p className={sectionTitleClass}>运行态漂移</p>
                    <div className="space-y-2">
                      {(plan?.runtimeDrift || []).map((item) => (
                        <div key={item.service} className={compactPanelClass}>
                          <div className="flex items-center justify-between gap-3">
                            <p className="font-medium text-[color:var(--text-primary)]">{item.service}</p>
                            <Badge variant={item.running ? 'success' : 'warning'}>{item.running ? '本地运行中' : '本地未运行'}</Badge>
                          </div>
                          {item.containerNames.length > 0 && (
                            <p className="mt-2 text-xs text-[color:var(--text-tertiary)]">容器：{item.containerNames.join(', ')}</p>
                          )}
                          {item.notes.map((note) => (
                            <p key={note} className="text-xs text-amber-600 dark:text-amber-400 mt-2">
                              {note}
                            </p>
                          ))}
                        </div>
                      ))}
                      {!plan && (
                        <div className={emptyPanelClass}>
                          生成计划后，这里会显示当前迁移范围内各服务的运行态差异；Compose 来源会按整组展示。
                        </div>
                      )}
                    </div>
                  </div>
              </div>

              <div className="space-y-4">
                  {autoHandledNetworks.length > 0 && (
                    <Notice tone="info">
                      平台会自动处理这些托管外部网络：{autoHandledNetworks.join('、')}。如果目标机缺失，会在预检阶段自动创建，不需要你手工登录目标机执行。
                    </Notice>
                  )}
                  {[
                    { key: 'read-only inspect', icon: EyeSectionIcon, items: plan?.readOnlyInspect || [] },
                    { key: 'new staging resource', icon: Layers, items: plan?.stagingResources || [] },
                    { key: 'needs cutover', icon: Network, items: plan?.needsCutover || [] },
                    { key: 'blocked', icon: Ban, items: plan?.blockedResources || [] },
                  ].map((group) => (
                    <div key={group.key} className={compactPanelClass}>
                      <div className="flex items-center gap-2 mb-3">
                        <group.icon className="w-4 h-4 text-[color:var(--text-tertiary)]" />
                        <p className="font-medium text-[color:var(--text-primary)]">{impactGroupMeta[group.key as keyof typeof impactGroupMeta].title}</p>
                        <Badge variant={impactGroupMeta[group.key as keyof typeof impactGroupMeta].badge}>
                          {group.items.length}
                        </Badge>
                      </div>
                      <div className="space-y-2">
                        {group.items.length > 0 ? (
                          group.items.map((item, index) => (
                            <div key={`${item.kind}-${item.label}-${index}`}>
                              <ImpactRow item={item} />
                            </div>
                          ))
                        ) : (
                          <p className="text-sm text-[color:var(--text-tertiary)]">暂无</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </Card>

            <Card title="安全边界">
              <div className="space-y-5">
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <ShieldCheck className="w-4 h-4 text-emerald-500" />
                    <p className="font-medium text-[color:var(--text-primary)]">绝不触碰</p>
                  </div>
                  <div className="space-y-2">
                    {(plan?.notTouched || []).map((item) => (
                      <div key={`${item.kind}-${item.label}`}>
                        <BoundaryRow item={item} />
                      </div>
                    ))}
                    {(!plan || plan.notTouched.length === 0) && (
                      <p className="text-sm text-[color:var(--text-tertiary)]">计划生成后会明确列出不会停止、不会删除、不会改写的目标机内容。</p>
                    )}
                  </div>
                </div>
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <Server className="w-4 h-4 text-blue-500" />
                    <p className="font-medium text-[color:var(--text-primary)]">权限边界</p>
                  </div>
                  <div className="space-y-2">
                    {(plan?.safetyBoundary.permissions || []).map((item) => (
                      <div key={`${item.kind}-${item.label}`}>
                        <BoundaryRow item={item} />
                      </div>
                    ))}
                    {(!plan || plan.safetyBoundary.permissions.length === 0) && (
                      <p className="text-sm text-[color:var(--text-tertiary)]">preflight 会检测 Docker / Compose / 目标工作目录权限，并在这里直观展示。</p>
                    )}
                  </div>
                </div>
              </div>
            </Card>
          </div>

          <Card title="风险与阻断">
            <div className="space-y-5">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {[
                  { label: '高风险', count: riskCounts.high, variant: 'danger' as const },
                  { label: '中风险', count: riskCounts.medium, variant: 'warning' as const },
                  { label: '低风险', count: riskCounts.low, variant: 'default' as const },
                ].map((item) => (
                  <div key={item.label} className="rounded-xl border border-[color:var(--border-subtle)] bg-[var(--surface-card-strong)] px-5 py-4">
                    <div className="flex items-center justify-between">
                      <p className="text-sm text-[color:var(--text-tertiary)]">{item.label}</p>
                      <Badge variant={item.variant}>{item.count}</Badge>
                    </div>
                    <p className="mt-3 text-2xl font-semibold text-[color:var(--text-primary)]">{item.count}</p>
                  </div>
                ))}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className={tableHeadClass}>
                      <th className="pb-4 font-medium">类型</th>
                      <th className="pb-4 font-medium">对象</th>
                      <th className="pb-4 font-medium">原因</th>
                      <th className="pb-4 font-medium">阻断</th>
                      <th className="pb-4 font-medium">建议动作</th>
                    </tr>
                  </thead>
                  <tbody className={tableBodyClass}>
                    {riskRows.length > 0 ? (
                      riskRows.map((row) => (
                        <tr key={`${row.kind}-${row.id}`} className="align-top">
                          <td className="py-4">
                            <Badge variant={riskVariantMap[row.severity] || 'default'}>{row.kind === 'conflict' ? 'Conflict' : row.title}</Badge>
                          </td>
                          <td className="py-4 text-sm text-[color:var(--text-primary)]">{row.target}</td>
                          <td className="py-4 text-sm text-[color:var(--text-tertiary)]">{row.reason}</td>
                          <td className="py-4">{row.blocking ? <Badge variant="danger">阻断</Badge> : <Badge variant="warning">告警</Badge>}</td>
                          <td className="py-4 text-sm text-[color:var(--text-tertiary)]">{row.recommendation}</td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={5} className="py-12 text-center text-[color:var(--text-tertiary)]">尚未生成风险报告。</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </Card>
        </div>
      )}

      {activeTab === 'execution' && (
        <Card title="执行监控">
          <div className="space-y-6">
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              <div className={panelClass}>
                <div className="flex items-center gap-2 mb-4">
                  <Activity className="w-4 h-4 text-blue-500" />
                  <h4 className="font-semibold text-[color:var(--text-primary)]">阶段时间线</h4>
                </div>
                <div className="space-y-4">
                  {timelineState.map((phase, index) => (
                    <div key={phase.key} className="flex items-start gap-4">
                      <div className="flex flex-col items-center">
                        <div
                          className={cn(
                            'w-9 h-9 rounded-full flex items-center justify-center border text-sm font-semibold',
                            phase.state === 'completed'
                              ? 'bg-emerald-50 border-emerald-200 text-emerald-600 dark:bg-emerald-500/10 dark:border-emerald-500/20 dark:text-emerald-400'
                              : phase.state === 'current'
                                ? 'bg-blue-50 border-blue-200 text-blue-600 dark:bg-blue-500/10 dark:border-blue-500/20 dark:text-blue-400'
                                : phase.state === 'failed'
                                  ? 'bg-rose-50 border-rose-200 text-rose-600 dark:bg-rose-500/10 dark:border-rose-500/20 dark:text-rose-400'
                                  : phase.state === 'rolled_back'
                                    ? 'bg-amber-50 border-amber-200 text-amber-600 dark:bg-amber-500/10 dark:border-amber-500/20 dark:text-amber-400'
                                    : 'border-[color:var(--border-subtle)] bg-[var(--surface-subtle)] text-[color:var(--text-tertiary)]'
                          )}
                        >
                          {phase.state === 'completed' ? <CheckCircle2 className="w-4 h-4" /> : index + 1}
                        </div>
                        {index !== timelineState.length - 1 && <div className="mt-2 h-10 w-px bg-[var(--border-subtle)]" />}
                      </div>
                      <div className="pt-1 min-w-0">
                        <p className="font-medium text-[color:var(--text-primary)]">{phase.label}</p>
                        <p className="text-sm text-[color:var(--text-tertiary)]">
                          {session?.currentPhase === phase.key ? session.currentStep : phase.state === 'completed' ? '已完成' : phase.state === 'failed' ? '失败' : '等待'}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className={panelClass}>
                <div className="flex items-center gap-2 mb-4">
                  <Package className="w-4 h-4 text-emerald-500" />
                  <h4 className="font-semibold text-[color:var(--text-primary)]">服务矩阵</h4>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className={tableHeadClass}>
                        <th className="pb-3 font-medium">服务</th>
                        <th className="pb-3 font-medium">阶段</th>
                        <th className="pb-3 font-medium">健康</th>
                        <th className="pb-3 font-medium">数据</th>
                        <th className="pb-3 font-medium">更新时间</th>
                      </tr>
                    </thead>
                    <tbody className={tableBodyClass}>
                      {(plan?.services || []).map((service: MigrationServiceInfo) => {
                        const state = session?.services?.[service.name];
                        return (
                          <tr key={service.name}>
                            <td className="py-3 font-medium text-[color:var(--text-primary)]">{service.name}</td>
                            <td className="py-3 text-sm text-[color:var(--text-tertiary)]">{state?.phase || '-'}</td>
                            <td className="py-3">
                              <Badge variant={state?.health === 'healthy' ? 'success' : state?.health === 'unhealthy' ? 'danger' : 'warning'}>
                                {state?.health || 'unknown'}
                              </Badge>
                            </td>
                            <td className="py-3">
                              <Badge variant={state?.dataStatus === 'restored' || state?.dataStatus === 'synced' ? 'success' : state?.dataStatus === 'failed' ? 'danger' : 'default'}>
                                {state?.dataStatus || 'pending'}
                              </Badge>
                            </td>
                            <td className="py-3 text-xs text-[color:var(--text-tertiary)]">{formatDateTime(state?.updatedAt)}</td>
                          </tr>
                        );
                      })}
                      {(!plan || plan.services.length === 0) && (
                        <tr>
                          <td colSpan={5} className="py-10 text-center text-[color:var(--text-tertiary)]">生成计划后会出现服务矩阵。</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-[0.9fr_1.1fr] gap-6">
              <div className={panelClass}>
                <div className="flex items-center gap-2 mb-4">
                  <HardDrive className="w-4 h-4 text-purple-500" />
                  <h4 className="font-semibold text-[color:var(--text-primary)]">传输进度</h4>
                </div>
                <div className="space-y-4">
                  <div>
                    <div className="flex items-center justify-between text-sm mb-2">
                      <span className="text-[color:var(--text-tertiary)]">已传输</span>
                      <span className="font-medium text-[color:var(--text-primary)]">{session?.transfer.percent?.toFixed(1) || '0.0'}%</span>
                    </div>
                    <div className="h-3 w-full overflow-hidden rounded-full bg-[var(--surface-soft)]">
                      <div className="h-full rounded-full bg-indigo-500 transition-all" style={{ width: `${Math.min(session?.transfer.percent || 0, 100)}%` }} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div className="rounded-lg border border-[color:var(--border-subtle)] bg-[var(--surface-card)] px-4 py-3">
                      <p className="text-[color:var(--text-tertiary)]">总量</p>
                      <p className="mt-1 font-semibold text-[color:var(--text-primary)]">{formatBytes(session?.transfer.bytesTotal || plan?.transferEstimate.totalBytes)}</p>
                    </div>
                    <div className="rounded-lg border border-[color:var(--border-subtle)] bg-[var(--surface-card)] px-4 py-3">
                      <p className="text-[color:var(--text-tertiary)]">已完成</p>
                      <p className="mt-1 font-semibold text-[color:var(--text-primary)]">{formatBytes(session?.transfer.bytesDone)}</p>
                    </div>
                    <div className="rounded-lg border border-[color:var(--border-subtle)] bg-[var(--surface-card)] px-4 py-3">
                      <p className="text-[color:var(--text-tertiary)]">速度</p>
                      <p className="mt-1 font-semibold text-[color:var(--text-primary)]">
                        {session?.transfer.speedBytesPerSec ? `${formatBytes(session.transfer.speedBytesPerSec)}/s` : '-'}
                      </p>
                    </div>
                    <div className="rounded-lg border border-[color:var(--border-subtle)] bg-[var(--surface-card)] px-4 py-3">
                      <p className="text-[color:var(--text-tertiary)]">校验和</p>
                      <p className="mt-1 font-semibold text-[color:var(--text-primary)]">{session?.transfer.checksumStatus || 'pending'}</p>
                    </div>
                  </div>
                  <div className="rounded-lg border border-[color:var(--border-subtle)] bg-[var(--surface-card)] px-4 py-3 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[color:var(--text-tertiary)]">当前文件</span>
                      <span className="max-w-[220px] truncate text-right font-medium text-[color:var(--text-primary)]">{session?.transfer.currentFile || '等待同步'}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3 mt-3">
                      <span className="text-[color:var(--text-tertiary)]">预计剩余</span>
                      <span className="font-medium text-[color:var(--text-primary)]">{session?.transfer.etaSeconds ? `${session.transfer.etaSeconds}s` : '-'}</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className={panelClass}>
                <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
                  <div className="flex items-center gap-2">
                    <Terminal className="w-4 h-4 text-[color:var(--text-tertiary)]" />
                    <h4 className="font-semibold text-[color:var(--text-primary)]">命令日志终端</h4>
                  </div>
                  <div className="flex items-center gap-3 flex-wrap text-sm">
                    <Select
                      className="w-auto min-w-[140px]"
                      value={logLevelFilter}
                      onChange={(event) => setLogLevelFilter(event.target.value as 'all' | 'info' | 'warn' | 'error' | 'success')}
                    >
                      <option value="all">全部级别</option>
                      <option value="info">Info</option>
                      <option value="warn">Warn</option>
                      <option value="error">Error</option>
                      <option value="success">Success</option>
                    </Select>
                    <Select
                      className="w-auto min-w-[160px]"
                      value={serviceFilter}
                      onChange={(event) => setServiceFilter(event.target.value)}
                    >
                      {serviceFilterOptions.map((option) => (
                        <option key={option} value={option}>
                          {option === 'all' ? '全部服务' : option}
                        </option>
                      ))}
                    </Select>
                    <label className="flex items-center gap-2 text-[color:var(--text-tertiary)]">
                      <Checkbox checked={autoScroll} onChange={(event) => setAutoScroll(event.target.checked)} />
                      自动滚动
                    </label>
                  </div>
                </div>
                <div
                  ref={terminalRef}
                  className={terminalShellClass}
                  style={{
                    backgroundColor: 'var(--console-bg)',
                    color: 'var(--console-text)',
                  }}
                >
                  {filteredLogs.length > 0 ? (
                    filteredLogs.map((entry, index) => (
                      <div key={`${entry.ts}-${entry.type}-${index}`} className="mb-2">
                        <span className="text-[var(--console-muted)]">[{entry.ts ? new Date(entry.ts).toLocaleTimeString('zh-CN', { hour12: false }) : '--:--:--'}]</span>{' '}
                        <span
                          className={cn(
                            'uppercase text-xs',
                            entry.level === 'error'
                              ? 'text-rose-400'
                              : entry.level === 'warn'
                                ? 'text-amber-400'
                                : entry.level === 'success'
                                  ? 'text-emerald-400'
                                  : 'text-blue-400'
                          )}
                        >
                          {entry.level || entry.type}
                        </span>{' '}
                        {entry.service && <span className="text-cyan-400">{entry.service}</span>}{' '}
                        <span>{entry.message}</span>
                      </div>
                    ))
                  ) : (
                    <div className="text-[var(--console-muted)]">暂无日志输出。开始迁移后，这里会按结构化事件实时滚动更新。</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </Card>
      )}

      {activeTab === 'result' && (
        <Card title="结果与回滚">
          <div className="grid grid-cols-1 xl:grid-cols-[1.1fr_0.9fr] gap-6">
            <div className="space-y-4">
              <div className={panelClass}>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm text-[color:var(--text-tertiary)]">当前结果</p>
                    <div className="flex items-center gap-2 mt-1">
                      <Badge variant={getStatusVariant(session?.status)}>{statusLabelMap[session?.status || 'idle']}</Badge>
                      <span className="text-sm text-[color:var(--text-tertiary)]">{result?.message || '尚未执行'}</span>
                    </div>
                  </div>
                  <div className="text-right text-sm text-[color:var(--text-tertiary)]">
                    <p>创建时间：{formatDateTime(session?.createdAt)}</p>
                    <p>结束时间：{formatDateTime(session?.endedAt)}</p>
                  </div>
                </div>
              </div>

              {sourceDirectoryFailure && (
                <Notice tone="warning">
                  当前失败不是目标机问题，而是源服务器上的原始 Compose 目录已不存在或当前 SSH 账号无法读取。处理方式是先刷新“选择来源”，如果系统已自动降级为“运行态快照”，直接按快照来源重新生成计划；如果你需要保留原始 Compose 语义，请先恢复源目录后再重试。
                </Notice>
              )}

              <div className={panelClass}>
                <div className="flex items-center gap-2 mb-4">
                  {session?.status === 'completed' ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                  ) : session?.status === 'rolled_back' ? (
                    <RotateCcw className="w-4 h-4 text-amber-500" />
                  ) : session?.status === 'blocked' ? (
                    <Ban className="w-4 h-4 text-rose-500" />
                  ) : (
                    <AlertCircle className="w-4 h-4 text-[color:var(--text-tertiary)]" />
                  )}
                  <h4 className="font-semibold text-[color:var(--text-primary)]">验证与处理结果</h4>
                </div>
                <div className="space-y-3">
                  {(result?.verification || []).length > 0 ? (
                    (result?.verification || []).map((item) => (
                      <div key={`${item.label}-${item.detail}`} className="flex items-start justify-between gap-4 rounded-lg border border-[color:var(--border-subtle)] bg-[var(--surface-card)] px-4 py-3">
                        <div>
                          <p className="font-medium text-[color:var(--text-primary)]">{item.label}</p>
                          <p className="text-sm text-[color:var(--text-tertiary)]">{item.detail}</p>
                        </div>
                        <Badge variant={item.status === 'pass' ? 'success' : item.status === 'warn' ? 'warning' : 'danger'}>{item.status}</Badge>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-[color:var(--text-tertiary)]">
                      {session?.status === 'blocked' ? '当前会话在计划阶段已阻断，尚未执行实际迁移。' : '等待迁移执行后生成验证结果。'}
                    </p>
                  )}
                </div>
              </div>

              <div className={panelClass}>
                <div className="flex items-center gap-2 mb-4">
                  <Folder className="w-4 h-4 text-blue-500" />
                  <h4 className="font-semibold text-[color:var(--text-primary)]">产物与正式资源</h4>
                </div>
                <div className="space-y-3">
                  {(result?.finalResources || []).length > 0 ? (
                    (result?.finalResources || []).map((resource) => (
                      <div key={resource} className="rounded-lg border border-[color:var(--border-subtle)] bg-[var(--surface-card)] px-4 py-3 text-sm text-[color:var(--text-secondary)]">
                        {resource}
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-[color:var(--text-tertiary)]">迁移成功后，这里会列出最终正式资源。</p>
                  )}
                  {(result?.artifacts || []).map((artifact) => (
                    <div key={artifact} className="rounded-lg border border-dashed border-[color:var(--border-strong)] bg-[var(--surface-subtle)] px-4 py-3 font-mono text-xs break-all text-[color:var(--text-tertiary)]">
                      {artifact}
                    </div>
                  ))}
                  <div className="pt-2">
                    <Button onClick={loadArtifactsPreview} disabled={!session || loadingArtifacts} variant="secondary">
                      {loadingArtifacts ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                      查看产物预览
                    </Button>
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <div className={panelClass}>
                <div className="flex items-center gap-2 mb-4">
                  <RotateCcw className="w-4 h-4 text-amber-500" />
                  <h4 className="font-semibold text-[color:var(--text-primary)]">回滚摘要</h4>
                </div>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-[color:var(--text-tertiary)]">状态</span>
                    <Badge variant={rollbackSummary?.status === 'completed' ? 'success' : rollbackSummary?.status === 'failed' ? 'danger' : 'default'}>
                      {rollbackSummary?.status || 'not_requested'}
                    </Badge>
                  </div>
                  {rollbackSummary?.message && <p className="text-sm text-[color:var(--text-tertiary)]">{rollbackSummary.message}</p>}
                  <div className="space-y-2">
                    {(rollbackSummary?.actions || []).length > 0 ? (
                      (rollbackSummary?.actions || []).map((action) => (
                        <div key={action} className="rounded-lg border border-[color:var(--border-subtle)] bg-[var(--surface-card)] px-4 py-3 text-sm text-[color:var(--text-secondary)]">
                          {action}
                        </div>
                      ))
                    ) : (
                      <p className="text-sm text-[color:var(--text-tertiary)]">尚未触发回滚。</p>
                    )}
                  </div>
                </div>
              </div>

              <div className={panelClass}>
                <div className="flex items-center gap-2 mb-4">
                  <Clock className="w-4 h-4 text-[color:var(--text-tertiary)]" />
                  <h4 className="font-semibold text-[color:var(--text-primary)]">执行摘要</h4>
                </div>
                <div className="space-y-3 text-sm text-[color:var(--text-tertiary)]">
                  <SummaryLine
                    label="项目 / 范围"
                    value={
                      session
                        ? `${session.projectName} / ${selectedProject?.sourceKind === 'compose-project' ? 'Compose 整组' : session.rootService}`
                        : '-'
                    }
                  />
                  <SummaryLine label="依赖服务数" value={String(session?.dependencyServices.length || 0)} />
                  <SummaryLine label="预检环境" value={plan?.preflight.dockerVersion ? 'Docker 就绪' : '未检查'} />
                  <SummaryLine label="迁移数据量" value={formatBytes(plan?.transferEstimate.totalBytes)} />
                  <SummaryLine label="目标工作目录" value={session?.target.workdir || '-'} mono />
                </div>
              </div>

              {artifactPreview && (
                <div className={panelClass}>
                  <div className="flex items-center gap-2 mb-4">
                    <Download className="w-4 h-4 text-blue-500" />
                    <h4 className="font-semibold text-[color:var(--text-primary)]">产物预览</h4>
                  </div>
                  <div className="space-y-4">
                    {[
                      { key: 'manifest', label: '计划清单' },
                      { key: 'riskReport', label: '风险报告' },
                      { key: 'targetSnapshotSummary', label: '目标机快照摘要' },
                      { key: 'rollbackReport', label: '回滚报告' },
                    ].map((entry) => (
                      <div key={entry.key}>
                        <p className="mb-2 text-sm font-medium text-[color:var(--text-primary)]">{entry.label}</p>
                        <pre
                          className="max-h-64 overflow-auto whitespace-pre-wrap rounded-xl border border-[color:var(--border-subtle)] p-4 text-xs text-[color:var(--text-secondary)]"
                          style={{ backgroundColor: 'var(--surface-subtle)' }}
                        >
                          {artifactPreview[entry.key] ? JSON.stringify(artifactPreview[entry.key], null, 2) : '暂无'}
                        </pre>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

function SummaryLine({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-[color:var(--text-tertiary)]">{label}</span>
      <span className={cn('text-right text-[color:var(--text-primary)]', mono && 'font-mono text-xs break-all')}>
        {value}
      </span>
    </div>
  );
}

function ImpactRow({ item }: { item: MigrationResourceImpact }) {
  const classificationLabel = impactClassificationLabelMap[item.classification] || item.classification;
  return (
    <div className="rounded-lg border border-[color:var(--border-subtle)] bg-[var(--surface-card-strong)] px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <p className="font-medium text-[color:var(--text-primary)]">{item.label}</p>
        <Badge
          variant={
            item.classification === 'blocked'
              ? 'danger'
              : item.classification === 'needs cutover'
                ? 'warning'
                : item.classification === 'new staging resource'
                  ? 'success'
                  : 'default'
          }
        >
          {classificationLabel}
        </Badge>
      </div>
      <p className="mt-2 text-sm text-[color:var(--text-tertiary)]">{item.detail}</p>
    </div>
  );
}

function BoundaryRow({ item }: { item: { kind: string; label: string; detail: string } }) {
  return (
    <div className="rounded-lg border border-[color:var(--border-subtle)] bg-[var(--surface-card-strong)] px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <p className="font-medium text-[color:var(--text-primary)]">{item.label}</p>
        <span className="text-xs uppercase text-[color:var(--text-tertiary)]">{item.kind}</span>
      </div>
      <p className="mt-2 text-sm text-[color:var(--text-tertiary)]">{item.detail}</p>
    </div>
  );
}

function EyeSectionIcon(props: React.ComponentProps<typeof Activity>) {
  return <Activity {...props} />;
}
