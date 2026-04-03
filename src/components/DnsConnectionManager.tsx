import React, { useEffect, useMemo, useState } from 'react';
import { Globe, Plus, RefreshCw, ShieldCheck } from 'lucide-react';
import { DNSProviderCatalogItem, DNSProviderConnection } from '../types';
import { Badge, Button, Card, EmptyState, Field, Input, Notice, Select } from './ui/primitives';

type DnsConnectionManagerProps = {
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
  compact?: boolean;
};

const initialForm = {
  provider: 'cloudflare' as 'cloudflare' | 'gcore',
  displayName: '',
  secret: '',
};

export function DnsConnectionManager({ apiFetch, compact = false }: DnsConnectionManagerProps) {
  const [catalog, setCatalog] = useState<DNSProviderCatalogItem[]>([]);
  const [connections, setConnections] = useState<DNSProviderConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(initialForm);

  const selectedCatalog = useMemo(
    () => catalog.find((item) => item.key === form.provider) || null,
    [catalog, form.provider]
  );

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [catalogRes, connectionsRes] = await Promise.all([
        apiFetch('/api/provider-connections/catalog'),
        apiFetch('/api/provider-connections'),
      ]);
      setCatalog((await catalogRes.json()) || []);
      setConnections((await connectionsRes.json()) || []);
    } catch (loadError: any) {
      setError(loadError.message || '加载 DNS 厂商接入失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleCreate = async () => {
    setSaving(true);
    setError(null);
    try {
      const payload =
        form.provider === 'cloudflare'
          ? { provider: form.provider, displayName: form.displayName, apiToken: form.secret }
          : { provider: form.provider, displayName: form.displayName, apiKey: form.secret };
      const res = await apiFetch('/api/provider-connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.details || data.error || '创建接入失败');
      setForm(initialForm);
      setShowCreate(false);
      await loadData();
    } catch (createError: any) {
      setError(createError.message || '创建接入失败');
    } finally {
      setSaving(false);
    }
  };

  const handleVerify = async (id: string) => {
    setVerifyingId(id);
    setError(null);
    try {
      const res = await apiFetch(`/api/provider-connections/${id}/verify`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.details || data.error || '校验失败');
      await loadData();
    } catch (verifyError: any) {
      setError(verifyError.message || '校验失败');
    } finally {
      setVerifyingId(null);
    }
  };

  return (
    <div className="space-y-5">
      {error && <Notice tone="danger">{error}</Notice>}

      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-[color:var(--text-primary)]">DNS 厂商接入</h3>
          {!compact && <p className="mt-1 text-sm text-[color:var(--text-tertiary)]">先接入 Cloudflare 或 Gcore，再进入 Zone 与记录管理。</p>}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={loadData}>
            <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            刷新
          </Button>
          <Button onClick={() => setShowCreate((value) => !value)}>
            <Plus className="h-4 w-4" />
            新增接入
          </Button>
        </div>
      </div>

      {showCreate && (
        <Card title="新增 DNS 厂商接入" subtitle="凭据会加密保存，系统设置页不再直接维护 Cloudflare / Gcore Token。">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <Field label="厂商">
              <Select value={form.provider} onChange={(event) => setForm((current) => ({ ...current, provider: event.target.value as 'cloudflare' | 'gcore' }))}>
                {catalog.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="显示名称">
              <Input value={form.displayName} onChange={(event) => setForm((current) => ({ ...current, displayName: event.target.value }))} placeholder="例如：Cloudflare-生产" />
            </Field>
            <Field label={selectedCatalog?.secretLabel || '密钥'}>
              <Input type="password" value={form.secret} onChange={(event) => setForm((current) => ({ ...current, secret: event.target.value }))} placeholder="输入接入密钥" />
            </Field>
          </div>
          {selectedCatalog && (
            <Notice tone="info" title={selectedCatalog.name}>
              {selectedCatalog.description}
            </Notice>
          )}
          <div className="mt-5 flex justify-end gap-3">
            <Button variant="ghost" onClick={() => setShowCreate(false)}>
              取消
            </Button>
            <Button onClick={handleCreate} disabled={saving || !form.secret.trim()}>
              <ShieldCheck className={saving ? 'h-4 w-4 animate-pulse' : 'h-4 w-4'} />
              {saving ? '保存中' : '保存并校验'}
            </Button>
          </div>
        </Card>
      )}

      {connections.length === 0 && !loading ? (
        <Card>
          <EmptyState icon={Globe} title="还没有 DNS 厂商接入" description="先添加一个 Cloudflare 或 Gcore 连接，后续再切到记录管理。" />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {connections.map((connection) => (
            <div key={connection.id}>
              <Card
                className="h-full"
                title={connection.displayName}
                subtitle={`${connection.provider === 'cloudflare' ? 'Cloudflare' : 'Gcore'} · ${connection.managedBy === 'env' ? '.env 兼容模式' : '数据库接入'}`}
                action={
                  <Badge variant={connection.status === 'ready' ? 'success' : connection.status === 'error' ? 'danger' : 'warning'}>
                    {connection.status}
                  </Badge>
                }
              >
                <div className="space-y-4">
                  <div className="grid grid-cols-1 gap-3 text-sm text-[color:var(--text-secondary)] md:grid-cols-2">
                    <div>代理状态：{connection.capabilities.supportsProxyStatus ? '支持' : '不支持'}</div>
                    <div>最近校验：{connection.lastVerifiedAt || '未校验'}</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {connection.capabilities.recordTypes.map((type) => (
                      <span key={`${connection.id}:${type}`}>
                        <Badge variant="default">{type}</Badge>
                      </span>
                    ))}
                  </div>
                  <div className="flex justify-end">
                    <Button variant="secondary" onClick={() => handleVerify(connection.id)} disabled={verifyingId === connection.id || connection.managedBy === 'env'}>
                      <RefreshCw className={verifyingId === connection.id ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
                      {connection.managedBy === 'env' ? '由 .env 托管' : '重新校验'}
                    </Button>
                  </div>
                </div>
              </Card>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
