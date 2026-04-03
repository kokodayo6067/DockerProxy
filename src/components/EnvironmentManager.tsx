import React, { useEffect, useMemo, useState } from 'react';
import { KeyRound, RefreshCw, Server, ShieldCheck, TerminalSquare } from 'lucide-react';
import { EnvironmentSummary } from '../types';
import { Badge, Button, Card, EmptyState, Field, Input, Notice, PageHeader, Select, StatCard, Textarea } from './ui/primitives';

type EnvironmentManagerProps = {
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
  environments: EnvironmentSummary[];
  onRefresh: () => Promise<void> | void;
};

type FormState = {
  displayName: string;
  host: string;
  port: string;
  username: string;
  authType: 'password' | 'privateKey';
  password: string;
  privateKey: string;
  workdir: string;
};

const initialForm: FormState = {
  displayName: '',
  host: '',
  port: '22',
  username: 'root',
  authType: 'privateKey',
  password: '',
  privateKey: '',
  workdir: '/opt/docker-projects',
};

export function EnvironmentManager({ apiFetch, environments, onRefresh }: EnvironmentManagerProps) {
  const [form, setForm] = useState<FormState>(initialForm);
  const [creating, setCreating] = useState(false);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stats = useMemo(
    () => ({
      total: environments.length,
      ready: environments.filter((item) => item.status === 'ready').length,
      warnings: environments.filter((item) => item.status === 'warning').length,
      remote: environments.filter((item) => !item.isLocal).length,
    }),
    [environments]
  );

  useEffect(() => {
    if (form.displayName || !form.host) return;
    setForm((current) => ({
      ...current,
      displayName: current.host.trim(),
    }));
  }, [form.displayName, form.host]);

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      const res = await apiFetch('/api/environments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: form.displayName.trim() || form.host.trim(),
          host: form.host.trim(),
          port: Number(form.port || 22),
          username: form.username.trim(),
          authType: form.authType,
          password: form.authType === 'password' ? form.password : undefined,
          privateKey: form.authType === 'privateKey' ? form.privateKey : undefined,
          workdir: form.workdir.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.details || data.error || '创建环境失败');
      setForm(initialForm);
      await onRefresh();
    } catch (createError: any) {
      setError(createError.message || '创建环境失败');
    } finally {
      setCreating(false);
    }
  };

  const handleVerify = async (environmentId: string) => {
    setVerifyingId(environmentId);
    setError(null);
    try {
      const res = await apiFetch(`/api/environments/${environmentId}/verify`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.details || data.error || '校验失败');
      await onRefresh();
    } catch (verifyError: any) {
      setError(verifyError.message || '环境校验失败');
    } finally {
      setVerifyingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Server}
        title="服务器接入"
        description="把当前宿主机和远端 SSH + Docker 服务器纳入平台管理；接入成功后，监控、工作负载、迁移和证书都会按服务器执行。"
        actions={
          <Button onClick={() => onRefresh()} variant="secondary">
            <RefreshCw className="h-4 w-4" />
            刷新服务器
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <StatCard label="服务器总数" value={String(stats.total)} detail="包含当前宿主机与远端服务器" />
        <StatCard label="就绪服务器" value={String(stats.ready)} detail="可直接用于工作负载与迁移" />
        <StatCard label="告警服务器" value={String(stats.warnings)} detail="已接入，但部分模块受限" />
        <StatCard label="远端服务器" value={String(stats.remote)} detail="通过 SSH 接入的平台节点" />
      </div>

      {error && <Notice tone="danger">{error}</Notice>}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(340px,420px)]">
        <Card title="服务器列表" subtitle="按服务器展示接入状态、权限层级和可用模块。">
          <div className="space-y-4">
            {environments.map((environment) => (
              <div
                key={environment.id}
                className="rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--surface-card-strong)] p-5"
              >
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-lg font-semibold text-[color:var(--text-primary)]">{environment.displayName}</h3>
                      <Badge variant={environment.status === 'ready' ? 'success' : environment.status === 'warning' ? 'warning' : environment.status === 'error' ? 'danger' : 'default'}>
                        {environment.status}
                      </Badge>
                      <Badge variant="default">{environment.type === 'local-docker' ? '当前宿主机' : 'SSH 服务器'}</Badge>
                    </div>
                    <div className="grid grid-cols-1 gap-3 text-sm text-[color:var(--text-secondary)] md:grid-cols-2">
                      <div>地址：{environment.host}{environment.isLocal ? '' : `:${environment.port}`}</div>
                      <div>用户：{environment.username || '-'}</div>
                      <div>工作目录：{environment.workdir}</div>
                      <div>最近校验：{environment.lastVerifiedAt || '未校验'}</div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(environment.capabilities.modules || {})
                        .filter(([, enabled]) => enabled)
                        .map(([module]) => (
                          <span key={module}>
                            <Badge variant="success">{module}</Badge>
                          </span>
                        ))}
                    </div>
                    {environment.capabilities.warnings.length > 0 && (
                      <Notice tone="warning">
                        {environment.capabilities.warnings.join('；')}
                      </Notice>
                    )}
                    {environment.lastError && (
                      <Notice tone="danger">{environment.lastError}</Notice>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      onClick={() => handleVerify(environment.id)}
                      variant="secondary"
                      disabled={verifyingId === environment.id}
                    >
                      <RefreshCw className={verifyingId === environment.id ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
                      重新校验
                    </Button>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-4">
                  <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[var(--surface-card)] p-3">
                    <p className="text-xs text-[color:var(--text-tertiary)]">权限层级</p>
                    <p className="mt-1 font-medium text-[color:var(--text-primary)]">{environment.capabilities.permissions.join(' / ') || '无'}</p>
                  </div>
                  <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[var(--surface-card)] p-3">
                    <p className="text-xs text-[color:var(--text-tertiary)]">Docker</p>
                    <p className="mt-1 font-medium text-[color:var(--text-primary)]">{environment.capabilities.dockerVersion || '不可用'}</p>
                  </div>
                  <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[var(--surface-card)] p-3">
                    <p className="text-xs text-[color:var(--text-tertiary)]">Compose</p>
                    <p className="mt-1 font-medium text-[color:var(--text-primary)]">{environment.capabilities.composeVersion || '不可用'}</p>
                  </div>
                  <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[var(--surface-card)] p-3">
                    <p className="text-xs text-[color:var(--text-tertiary)]">Sudo / 指纹</p>
                    <p className="mt-1 font-medium text-[color:var(--text-primary)]">{environment.capabilities.sudoMode}</p>
                    <p className="mt-1 truncate text-xs text-[color:var(--text-tertiary)]">{environment.hostFingerprint || '首次接入后记录'}</p>
                  </div>
                </div>
              </div>
            ))}

            {environments.length === 0 && (
              <EmptyState icon={Server} title="还没有服务器" description="先添加一个 SSH 服务器，后续工作负载和迁移都会基于服务器执行。" />
            )}
          </div>
        </Card>

        <Card title="新增 SSH 服务器" subtitle="优先使用私钥，首次接入会自动记录主机指纹并给出权限分层评估。">
          <div className="space-y-4">
            <Field label="显示名称">
              <Input value={form.displayName} onChange={(event) => setForm((current) => ({ ...current, displayName: event.target.value }))} placeholder="例如：生产机-01" />
            </Field>
            <Field label="主机地址">
              <Input value={form.host} onChange={(event) => setForm((current) => ({ ...current, host: event.target.value }))} placeholder="192.168.1.100 / example.com" />
            </Field>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="SSH 端口">
                <Input value={form.port} onChange={(event) => setForm((current) => ({ ...current, port: event.target.value }))} />
              </Field>
              <Field label="SSH 用户">
                <Input value={form.username} onChange={(event) => setForm((current) => ({ ...current, username: event.target.value }))} />
              </Field>
            </div>
            <Field label="工作目录" hint="用于平台部署与迁移临时文件。">
              <Input value={form.workdir} onChange={(event) => setForm((current) => ({ ...current, workdir: event.target.value }))} />
            </Field>
            <Field label="认证方式">
              <Select value={form.authType} onChange={(event) => setForm((current) => ({ ...current, authType: event.target.value as 'password' | 'privateKey' }))}>
                <option value="privateKey">私钥</option>
                <option value="password">密码</option>
              </Select>
            </Field>
            {form.authType === 'password' ? (
              <Field label="SSH 密码">
                <Input type="password" value={form.password} onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))} />
              </Field>
            ) : (
              <Field label="私钥">
                <Textarea value={form.privateKey} onChange={(event) => setForm((current) => ({ ...current, privateKey: event.target.value }))} className="h-44 resize-none font-mono text-xs" />
              </Field>
            )}

            <Notice tone="info">
              <div className="space-y-2 text-sm">
                <div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" />首次接入自动记录主机指纹，后续连接默认校验。</div>
                <div className="flex items-center gap-2"><TerminalSquare className="h-4 w-4" />接入后不会默认获得所有模块能力，平台会按 inspect / operate / elevated 分层评估。</div>
                <div className="flex items-center gap-2"><KeyRound className="h-4 w-4" />密码和私钥只会加密存储，前端不会回显明文。</div>
              </div>
            </Notice>

            <Button onClick={handleCreate} className="w-full" disabled={creating}>
              <Server className={creating ? 'h-4 w-4 animate-pulse' : 'h-4 w-4'} />
              {creating ? '创建并校验中' : '创建服务器'}
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
