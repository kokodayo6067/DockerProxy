import React, { useEffect, useMemo, useState } from 'react';
import { Activity, ExternalLink, Network, PlugZap, Server, Settings, ShieldCheck, Truck, Workflow } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { cn } from './lib/utils';
import { AppConfig, ServerSummary } from './types';
import { ServerOverview } from './components/ServerOverview';
import { WorkloadCenter } from './components/WorkloadCenter';
import { NetworkCenter } from './components/NetworkCenter';
import { TaskCenter } from './components/TaskCenter';
import { IntegrationHub } from './components/IntegrationHub';
import { Badge, Button, Card, Field, Input, PageHeader, Textarea, ThemeSwitch } from './components/ui/primitives';
import { useTheme } from './hooks/useTheme';

export const apiFetch = async (url: string, options: RequestInit = {}) => {
  const token = localStorage.getItem('token');
  const headers = new Headers(options.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    window.dispatchEvent(new Event('auth-unauthorized'));
  }
  return res;
};

const SidebarItem = ({ icon: Icon, label, active, onClick }: { icon: any; label: string; active: boolean; onClick: () => void }) => (
  <button
    onClick={onClick}
    className={cn(
      'group flex w-full items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium transition-all duration-200',
      active
        ? 'bg-[var(--brand-600)] text-white shadow-[0_16px_28px_-22px_var(--brand-600)]'
        : 'text-[color:var(--text-secondary)] hover:bg-[var(--surface-soft)] hover:text-[color:var(--text-primary)]'
    )}
  >
    <Icon className={cn('h-5 w-5', active ? 'text-white' : 'text-[color:var(--text-tertiary)] group-hover:text-[var(--brand-500)]')} />
    {label}
  </button>
);

function SettingsView({ config, onConfigChange }: { config: AppConfig | null; onConfigChange: () => void }) {
  const [envContent, setEnvContent] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiFetch('/api/config/env')
      .then((res) => res.text())
      .then(setEnvContent)
      .catch(console.error);
  }, []);

  const handleSaveEnv = async () => {
    setSaving(true);
    try {
      const res = await apiFetch('/api/config/env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: envContent }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.details || data.error || '保存失败');
      }
      onConfigChange();
    } catch (error) {
      console.error(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Settings}
        title="系统设置"
        description="这里保留平台启动级配置；服务器接入、DNS 厂商和任务元数据已经迁入控制面数据库。"
        actions={
          <Button onClick={handleSaveEnv} disabled={saving}>
            {saving ? '保存中' : '保存配置'}
          </Button>
        }
      />

      <Card title="平台状态摘要" subtitle="只保留平台引导级配置和当前状态摘要，不再在这里维护 Cloudflare/Gcore 凭据。">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <SummaryBox label="平台主密钥" value={config?.hasAppMasterKey ? '已配置' : '未配置'} tone={config?.hasAppMasterKey ? 'success' : 'danger'} />
          <SummaryBox label="服务器数量" value={String(config?.environmentCount || 0)} tone="default" />
          <SummaryBox label="DNS 厂商接入" value={String(config?.providerConnectionCount || 0)} tone="default" />
          <SummaryBox label="本地网关容器" value={config?.nginxContainer || '-'} tone="default" />
        </div>
      </Card>

      <Card title=".env 配置" subtitle="仅用于平台启动级参数，保存后会立即重载服务端配置。">
        <div className="space-y-4">
          <Textarea
            value={envContent}
            onChange={(event) => setEnvContent(event.target.value)}
            className="h-[360px] resize-none bg-[var(--surface-subtle)] font-mono text-sm text-[color:var(--text-primary)]"
            spellCheck={false}
          />
        </div>
      </Card>
    </div>
  );
}

function SummaryBox({ label, value, tone }: { label: string; value: string; tone: 'default' | 'success' | 'danger' }) {
  const toneClass =
    tone === 'success'
      ? 'border-emerald-200 bg-emerald-50/80 dark:border-emerald-500/20 dark:bg-emerald-500/10'
      : tone === 'danger'
        ? 'border-rose-200 bg-rose-50/80 dark:border-rose-500/20 dark:bg-rose-500/10'
        : 'border-[color:var(--border-subtle)] bg-[var(--surface-card-strong)]';
  return (
    <div className={cn('rounded-2xl border p-4', toneClass)}>
      <p className="text-xs uppercase tracking-[0.18em] text-[color:var(--text-tertiary)]">{label}</p>
      <p className="mt-3 text-xl font-semibold text-[color:var(--text-primary)]">{value}</p>
    </div>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'servers' | 'workloads' | 'network' | 'tasks' | 'integrations' | 'settings'>('servers');
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [selectedServerId, setSelectedServerId] = useState('local');
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [loggedIn, setLoggedIn] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const res = await apiFetch('/api/auth/me');
        const data = await res.json();
        setLoggedIn(data.loggedIn);
      } catch {
        setLoggedIn(false);
      } finally {
        setCheckingAuth(false);
      }
    };
    checkAuth();

    const handleUnauthorized = () => {
      setLoggedIn(false);
      localStorage.removeItem('token');
    };
    window.addEventListener('auth-unauthorized', handleUnauthorized);
    return () => window.removeEventListener('auth-unauthorized', handleUnauthorized);
  }, []);

  const loadConfig = () => {
    apiFetch('/api/config')
      .then((res) => res.json())
      .then(setConfig)
      .catch(console.error);
  };

  const loadServers = async () => {
    try {
      const res = await apiFetch('/api/servers');
      const data = await res.json();
      const nextServers = Array.isArray(data) ? data : [];
      setServers(nextServers);
      if (!nextServers.some((server) => server.id === selectedServerId)) {
        const fallback = nextServers.find((server) => server.isLocal) || nextServers[0];
        setSelectedServerId(fallback?.id || 'local');
      }
    } catch (error) {
      console.error(error);
      setServers([]);
    }
  };

  useEffect(() => {
    if (loggedIn) {
      loadConfig();
      loadServers();
    }
  }, [loggedIn]);

  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoginError('');
    try {
      const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (data.success) {
        localStorage.setItem('token', data.token);
        setLoggedIn(true);
      } else {
        setLoginError(data.error || '登录失败');
      }
    } catch {
      setLoginError('网络错误');
    }
  };

  const handleLogout = async () => {
    await apiFetch('/api/auth/logout', { method: 'POST' });
    localStorage.removeItem('token');
    setLoggedIn(false);
  };

  const currentServer = useMemo(
    () => servers.find((server) => server.id === selectedServerId) || servers[0] || null,
    [selectedServerId, servers]
  );

  if (checkingAuth) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--app-bg)] text-[color:var(--text-primary)]">
        <RefreshLoader />
      </div>
    );
  }

  if (!loggedIn) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--app-bg)] px-6 text-[color:var(--text-primary)] transition-colors duration-200">
        <div className="w-full max-w-md rounded-[1.75rem] border border-[color:var(--border-subtle)] bg-[var(--surface-card)] p-8 shadow-[0_28px_60px_-40px_rgba(15,23,42,0.7)] backdrop-blur-xl">
          <div className="mb-8 flex flex-col items-center">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 shadow-lg shadow-blue-500/20">
              <ShieldCheck className="h-7 w-7 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-[color:var(--text-primary)]">Docker 平台控制台</h1>
            <p className="mt-1 text-sm text-[color:var(--text-tertiary)]">请输入管理员账号登录</p>
          </div>
          <form onSubmit={handleLogin} className="space-y-4">
            <Field label="用户名">
              <Input type="text" value={username} onChange={(event) => setUsername(event.target.value)} required />
            </Field>
            <Field label="密码">
              <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required />
            </Field>
            {loginError && <p className="text-sm text-rose-500">{loginError}</p>}
            <Button type="submit" className="w-full" size="lg">
              登录
            </Button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-[var(--app-bg)] text-[color:var(--text-primary)] font-sans transition-colors duration-200">
      <aside className="sticky top-0 flex h-screen w-72 flex-col border-r border-[color:var(--border-subtle)] bg-[var(--surface-card)] backdrop-blur-xl transition-colors duration-200">
        <div className="p-8">
          <div className="mb-10 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 shadow-lg shadow-blue-500/20">
              <Activity className="h-6 w-6 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-[color:var(--text-primary)]">DockerProxy</h1>
              <p className="text-xs text-[color:var(--text-tertiary)]">服务器优先的多 VPS 控制台</p>
            </div>
          </div>

          <nav className="space-y-2">
            <SidebarItem icon={Server} label="服务器" active={activeTab === 'servers'} onClick={() => setActiveTab('servers')} />
            <SidebarItem icon={Workflow} label="工作负载" active={activeTab === 'workloads'} onClick={() => setActiveTab('workloads')} />
            <SidebarItem icon={Network} label="网络与域名" active={activeTab === 'network'} onClick={() => setActiveTab('network')} />
            <SidebarItem icon={Truck} label="迁移与任务" active={activeTab === 'tasks'} onClick={() => setActiveTab('tasks')} />
            <SidebarItem icon={PlugZap} label="接入中心" active={activeTab === 'integrations'} onClick={() => setActiveTab('integrations')} />
          </nav>
        </div>

        <div className="mt-auto space-y-3 border-t border-[color:var(--border-subtle)] p-8">
          {currentServer && (
            <Card className="rounded-2xl" contentClassName="p-4">
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium text-[color:var(--text-primary)]">当前服务器</p>
                  <Badge variant={currentServer.status === 'ready' ? 'success' : currentServer.status === 'warning' ? 'warning' : 'danger'}>
                    {currentServer.status}
                  </Badge>
                </div>
                <p className="text-sm text-[color:var(--text-secondary)]">{currentServer.displayName}</p>
                <p className="text-xs text-[color:var(--text-tertiary)]">{currentServer.host}</p>
              </div>
            </Card>
          )}
          <ThemeSwitch theme={theme} resolvedTheme={resolvedTheme} onChange={setTheme} />
          <SidebarItem icon={Settings} label="系统设置" active={activeTab === 'settings'} onClick={() => setActiveTab('settings')} />
          <Button onClick={handleLogout} variant="ghost" className="w-full justify-start text-rose-500 hover:bg-rose-500/10 hover:text-rose-500">
            <ExternalLink className="h-5 w-5" />
            退出登录
          </Button>
        </div>
      </aside>

      <main className="flex-1 overflow-auto p-10">
        <div className="mx-auto max-w-7xl">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -10 }}
              transition={{ duration: 0.2 }}
            >
              {activeTab === 'servers' && (
                <ServerOverview
                  apiFetch={apiFetch}
                  servers={servers}
                  selectedServerId={selectedServerId}
                  onSelectServer={setSelectedServerId}
                  onOpenIntegrations={() => setActiveTab('integrations')}
                  onOpenWorkloads={() => setActiveTab('workloads')}
                  onOpenTasks={() => setActiveTab('tasks')}
                />
              )}
              {activeTab === 'workloads' && (
                <WorkloadCenter apiFetch={apiFetch} servers={servers} selectedServerId={selectedServerId} onSelectServer={setSelectedServerId} />
              )}
              {activeTab === 'network' && (
                <NetworkCenter apiFetch={apiFetch} servers={servers} selectedServerId={selectedServerId} onSelectServer={setSelectedServerId} />
              )}
              {activeTab === 'tasks' && (
                <TaskCenter apiFetch={apiFetch} servers={servers} selectedServerId={selectedServerId} onSelectServer={setSelectedServerId} />
              )}
              {activeTab === 'integrations' && (
                <IntegrationHub
                  apiFetch={apiFetch}
                  servers={servers}
                  onRefreshServers={async () => {
                    loadConfig();
                    await loadServers();
                  }}
                />
              )}
              {activeTab === 'settings' && <SettingsView config={config} onConfigChange={loadConfig} />}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}

function RefreshLoader() {
  return <Activity className="h-8 w-8 animate-spin text-[var(--brand-500)]" />;
}
