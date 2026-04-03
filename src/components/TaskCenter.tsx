import React, { useEffect, useState } from 'react';
import { Activity, RefreshCw, Truck } from 'lucide-react';
import { JobSummary, ServerSummary } from '../types';
import { Badge, Button, Card, EmptyState, PageHeader, SegmentedTabs } from './ui/primitives';
import { ServerContextBar } from './ServerContextBar';
import { MigrationConsole } from './MigrationConsole';

type TaskCenterProps = {
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
  servers: ServerSummary[];
  selectedServerId: string;
  onSelectServer: (serverId: string) => void;
};

function statusVariant(status: string) {
  if (status === 'completed' || status === 'ready') return 'success';
  if (status === 'running' || status === 'pending' || status === 'verifying') return 'warning';
  if (status === 'failed' || status === 'blocked') return 'danger';
  return 'default';
}

export function TaskCenter({ apiFetch, servers, selectedServerId, onSelectServer }: TaskCenterProps) {
  const [activeTab, setActiveTab] = useState<'migration' | 'jobs'>('migration');
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [loading, setLoading] = useState(false);

  const loadJobs = async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/jobs?serverId=${encodeURIComponent(selectedServerId)}`);
      const data = await res.json();
      setJobs(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error(error);
      setJobs([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadJobs();
  }, [selectedServerId]);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Truck}
        title="迁移与任务"
        description="迁移、部署、证书续签和服务器校验都统一进入任务视角，不再把长流程分散到每个页面角落。"
        actions={
          <Button variant="secondary" onClick={loadJobs}>
            <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            刷新任务
          </Button>
        }
      />

      <ServerContextBar
        servers={servers}
        serverId={selectedServerId}
        onChange={onSelectServer}
        title="任务上下文"
        subtitle="迁移计划需要源服务器与目标服务器；任务列表默认按当前服务器过滤。"
      />

      <SegmentedTabs
        value={activeTab}
        onChange={(value) => setActiveTab(value as 'migration' | 'jobs')}
        items={[
          { value: 'migration', label: 'Docker 迁移' },
          { value: 'jobs', label: '任务中心' },
        ]}
      />

      {activeTab === 'migration' && <MigrationConsole apiFetch={apiFetch} environments={servers} />}

      {activeTab === 'jobs' && (
        <Card title="任务中心" subtitle="统一查看迁移、部署、证书续签和服务器校验任务，当前按服务器过滤。">
          <div className="space-y-4">
            {jobs.map((job) => (
              <div key={job.id} className="rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--surface-card-strong)] px-5 py-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold text-[color:var(--text-primary)]">{job.kind}</h3>
                      <Badge variant={statusVariant(job.status)}>{job.status}</Badge>
                      <Badge variant="default">{job.source === 'migration' ? '迁移会话' : '平台任务'}</Badge>
                    </div>
                    <p className="mt-2 text-sm text-[color:var(--text-tertiary)]">
                      更新时间：{new Date(job.updatedAt).toLocaleString('zh-CN')}
                    </p>
                    {job.metadata?.message && <p className="mt-2 text-sm text-[color:var(--text-secondary)]">{String(job.metadata.message)}</p>}
                    {job.metadata?.projectName && (
                      <p className="mt-2 text-sm text-[color:var(--text-secondary)]">项目：{String(job.metadata.projectName)}</p>
                    )}
                  </div>
                  <div className="rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--surface-card)] px-4 py-3 text-sm text-[color:var(--text-secondary)]">
                    <p>源服务器：{job.sourceServerId || '-'}</p>
                    <p className="mt-1">目标服务器：{job.targetServerId || '-'}</p>
                  </div>
                </div>
              </div>
            ))}
            {jobs.length === 0 && !loading && <EmptyState icon={Activity} title="暂无任务" description="当前服务器还没有匹配的迁移、部署或证书任务。" />}
          </div>
        </Card>
      )}
    </div>
  );
}
