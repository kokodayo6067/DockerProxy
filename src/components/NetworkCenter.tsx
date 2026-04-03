import React, { useEffect, useMemo, useState } from 'react';
import { Globe, Network, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import {
  Certificate,
  DNSProviderConnection,
  DNSProviderRecord,
  DNSZoneSummary,
  GatewaySummary,
  ProxyRoute,
  ServerSummary,
} from '../types';
import { Badge, Button, Card, Checkbox, EmptyState, Field, IconButton, Input, Notice, PageHeader, PaginationControls, SegmentedTabs, Select } from './ui/primitives';
import { ServerContextBar } from './ServerContextBar';
import { DnsConnectionManager } from './DnsConnectionManager';

type NetworkCenterProps = {
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
  servers: ServerSummary[];
  selectedServerId: string;
  onSelectServer: (serverId: string) => void;
};

const initialRecord = { name: '', content: '', type: 'A', ttl: 1, proxied: false };

export function NetworkCenter({ apiFetch, servers, selectedServerId, onSelectServer }: NetworkCenterProps) {
  const [activeTab, setActiveTab] = useState<'dns' | 'routes' | 'certs'>('dns');
  const [dnsTab, setDnsTab] = useState<'connections' | 'records'>('connections');
  const [connections, setConnections] = useState<DNSProviderConnection[]>([]);
  const [zones, setZones] = useState<DNSZoneSummary[]>([]);
  const [records, setRecords] = useState<DNSProviderRecord[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState('');
  const [selectedZone, setSelectedZone] = useState('');
  const [recordForm, setRecordForm] = useState(initialRecord);
  const [editingRecordId, setEditingRecordId] = useState<string | null>(null);
  const [showRecordForm, setShowRecordForm] = useState(false);
  const [recordSearch, setRecordSearch] = useState('');
  const [recordPage, setRecordPage] = useState(1);
  const [recordPageSize, setRecordPageSize] = useState(10);
  const [gateways, setGateways] = useState<GatewaySummary[]>([]);
  const [selectedGatewayId, setSelectedGatewayId] = useState('');
  const [routes, setRoutes] = useState<ProxyRoute[]>([]);
  const [certificates, setCertificates] = useState<Certificate[]>([]);
  const [showRouteForm, setShowRouteForm] = useState(false);
  const [newRoute, setNewRoute] = useState({ domain: '', target: '127.0.0.1:8000', ssl: true });
  const [error, setError] = useState<string | null>(null);

  const currentServer = useMemo(
    () => servers.find((server) => server.id === selectedServerId) || servers[0] || null,
    [selectedServerId, servers]
  );
  const currentConnection = useMemo(
    () => connections.find((connection) => connection.id === selectedConnectionId) || null,
    [connections, selectedConnectionId]
  );
  const activeGateway = gateways.find((gateway) => gateway.id === selectedGatewayId) || gateways[0] || null;
  const manageableGateway = gateways.find((gateway) => gateway.capabilities.routeManagement) || null;

  const loadConnections = async () => {
    const res = await apiFetch('/api/provider-connections');
    const data = await res.json();
    const next = Array.isArray(data) ? data : [];
    setConnections(next);
    if (!selectedConnectionId && next.length > 0) {
      setSelectedConnectionId(next[0].id);
    }
  };

  const loadZones = async (connectionId: string) => {
    if (!connectionId) return;
    const res = await apiFetch(`/api/provider-connections/${connectionId}/zones`);
    const data = await res.json();
    const next = Array.isArray(data) ? data : [];
    setZones(next);
    if (!next.some((zone) => zone.name === selectedZone)) {
      setSelectedZone(next[0]?.name || '');
    }
  };

  const loadRecords = async () => {
    if (!selectedConnectionId || !selectedZone) return;
    const res = await apiFetch(`/api/provider-connections/${selectedConnectionId}/records?zone=${encodeURIComponent(selectedZone)}`);
    const data = await res.json();
    setRecords(Array.isArray(data) ? data : []);
  };

  const loadGatewayData = async () => {
    if (!currentServer) return;
    const gatewayRes = await apiFetch(`/api/gateways?serverId=${encodeURIComponent(currentServer.id)}`);
    const gatewayData = await gatewayRes.json();
    const nextGateways = Array.isArray(gatewayData) ? gatewayData : [];
    setGateways(nextGateways);
    if (!nextGateways.some((gateway) => gateway.id === selectedGatewayId)) {
      setSelectedGatewayId(nextGateways[0]?.id || '');
    }

    const resolvedGatewayId = nextGateways.some((gateway) => gateway.id === selectedGatewayId)
      ? selectedGatewayId
      : nextGateways[0]?.id;
    if (resolvedGatewayId) {
      const certRes = await apiFetch(`/api/certs?gatewayId=${encodeURIComponent(resolvedGatewayId)}`);
      const certData = await certRes.json();
      setCertificates(Array.isArray(certData) ? certData : []);
    } else {
      setCertificates([]);
    }

    const routeRes = await apiFetch(`/api/proxy/routes?serverId=${encodeURIComponent(currentServer.id)}`);
    const routeData = await routeRes.json();
    setRoutes(Array.isArray(routeData) ? routeData : []);
  };

  useEffect(() => {
    loadConnections().catch((loadError) => {
      console.error(loadError);
      setError('加载 DNS 厂商接入失败');
    });
  }, []);

  useEffect(() => {
    if (activeTab === 'dns') {
      loadConnections().catch((loadError) => {
        console.error(loadError);
      });
    }
  }, [activeTab, dnsTab]);

  useEffect(() => {
    if (!selectedConnectionId) return;
    loadZones(selectedConnectionId).catch((loadError) => {
      console.error(loadError);
      setError('加载 Zone 列表失败');
    });
  }, [selectedConnectionId]);

  useEffect(() => {
    if (selectedConnectionId && selectedZone) {
      loadRecords().catch((loadError) => {
        console.error(loadError);
        setError('加载 DNS 记录失败');
      });
    }
  }, [selectedConnectionId, selectedZone]);

  useEffect(() => {
    loadGatewayData().catch((loadError) => {
      console.error(loadError);
      setError('加载网关或证书数据失败');
    });
  }, [currentServer?.id, selectedGatewayId]);

  useEffect(() => {
    setRecordPage(1);
  }, [recordSearch, recordPageSize, records.length, selectedZone]);

  const filteredRecords = records.filter((record) => {
    const keyword = recordSearch.trim().toLowerCase();
    if (!keyword) return true;
    return [record.name, record.type, record.content, record.fqdn].join(' ').toLowerCase().includes(keyword);
  });
  const totalPages = Math.max(Math.ceil(filteredRecords.length / recordPageSize), 1);
  const currentPage = Math.min(recordPage, totalPages);
  const pagedRecords = filteredRecords.slice((currentPage - 1) * recordPageSize, currentPage * recordPageSize);

  const handleSaveRecord = async () => {
    if (!selectedConnectionId || !selectedZone) return;
    setError(null);
    try {
      const url = editingRecordId
        ? `/api/provider-connections/${selectedConnectionId}/records/${encodeURIComponent(editingRecordId)}?zone=${encodeURIComponent(selectedZone)}`
        : `/api/provider-connections/${selectedConnectionId}/records?zone=${encodeURIComponent(selectedZone)}`;
      const res = await apiFetch(url, {
        method: editingRecordId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(recordForm),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.details || data.error || '保存 DNS 记录失败');
      setShowRecordForm(false);
      setEditingRecordId(null);
      setRecordForm(initialRecord);
      await loadRecords();
    } catch (saveError: any) {
      setError(saveError.message || '保存 DNS 记录失败');
    }
  };

  const handleDeleteRecord = async (record: DNSProviderRecord) => {
    if (!selectedConnectionId || !selectedZone) return;
    try {
      const res = await apiFetch(
        `/api/provider-connections/${selectedConnectionId}/records/${encodeURIComponent(record.id)}?zone=${encodeURIComponent(selectedZone)}`,
        { method: 'DELETE' }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.details || data.error || '删除 DNS 记录失败');
      await loadRecords();
    } catch (deleteError: any) {
      setError(deleteError.message || '删除 DNS 记录失败');
    }
  };

  const handleSaveRoute = async () => {
    try {
      const res = await apiFetch('/api/proxy/routes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...newRoute,
          gatewayId: manageableGateway?.id,
          serverId: currentServer?.id,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.details || data.error || '保存路由失败');
      setShowRouteForm(false);
      setNewRoute({ domain: '', target: '127.0.0.1:8000', ssl: true });
      await loadGatewayData();
    } catch (routeError: any) {
      setError(routeError.message || '保存路由失败');
    }
  };

  const handleDeleteRoute = async (id: string) => {
    try {
      const res = await apiFetch(`/api/proxy/routes/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.details || data.error || '删除路由失败');
      await loadGatewayData();
    } catch (routeError: any) {
      setError(routeError.message || '删除路由失败');
    }
  };

  const handleRenew = async (cert: Certificate) => {
    if (!currentServer || !cert.gatewayId) return;
    try {
      const res = await apiFetch(`/api/certs/${encodeURIComponent(cert.domain)}/renew`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gatewayId: cert.gatewayId, serverId: currentServer.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.details || data.error || '续签失败');
      await loadGatewayData();
    } catch (renewError: any) {
      setError(renewError.message || '续签失败');
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Network}
        title="网络与域名"
        description="统一管理 DNS 厂商接入、Zone 记录、网关路由和证书，按服务器上下文收敛到正确的网关主语。"
      />

      {currentServer && (
        <ServerContextBar
          servers={servers}
          serverId={currentServer.id}
          onChange={onSelectServer}
          title="网络与域名上下文"
          subtitle="DNS 记录以厂商连接为主语；路由与证书以当前服务器下的网关为主语。"
        />
      )}

      {error && <Notice tone="danger">{error}</Notice>}

      <SegmentedTabs
        value={activeTab}
        onChange={(value) => setActiveTab(value as 'dns' | 'routes' | 'certs')}
        items={[
          { value: 'dns', label: 'DNS 记录' },
          { value: 'routes', label: '网关路由' },
          { value: 'certs', label: '证书管理' },
        ]}
      />

      {activeTab === 'dns' && (
        <div className="space-y-6">
          <SegmentedTabs
            value={dnsTab}
            onChange={(value) => setDnsTab(value as 'connections' | 'records')}
            items={[
              { value: 'connections', label: '厂商接入' },
              { value: 'records', label: '记录管理' },
            ]}
          />

          {dnsTab === 'connections' && <DnsConnectionManager apiFetch={apiFetch} />}

          {dnsTab === 'records' && (
            <Card title="Zone 与记录管理" subtitle="先选厂商连接，再选 Zone；表单会根据 Cloudflare / Gcore 的能力动态适配。">
              {connections.length === 0 ? (
                <EmptyState icon={Globe} title="暂无可用连接" description="先在“厂商接入”中创建 Cloudflare 或 Gcore 连接，再进入记录管理。" />
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 gap-4 rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--surface-card-strong)] p-4 md:grid-cols-[minmax(0,260px)_minmax(0,260px)_auto]">
                    <Field label="厂商连接">
                      <Select value={selectedConnectionId} onChange={(event) => setSelectedConnectionId(event.target.value)}>
                        {connections.map((connection) => (
                          <option key={connection.id} value={connection.id}>
                            {connection.displayName}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Zone">
                      <Select value={selectedZone} onChange={(event) => setSelectedZone(event.target.value)}>
                        {zones.map((zone) => (
                          <option key={zone.name} value={zone.name}>
                            {zone.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <div className="flex items-end justify-end gap-2">
                      <Button variant="secondary" onClick={loadRecords}>
                        <RefreshCw className="h-4 w-4" />
                        刷新记录
                      </Button>
                      <Button
                        onClick={() => {
                          setShowRecordForm(true);
                          setEditingRecordId(null);
                          setRecordForm({
                            ...initialRecord,
                            content: currentConnection?.provider === 'cloudflare' ? '' : '',
                          });
                        }}
                      >
                        <Plus className="h-4 w-4" />
                        添加记录
                      </Button>
                    </div>
                  </div>

                  {showRecordForm && (
                    <Card title={editingRecordId ? '编辑记录' : '新增记录'}>
                      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
                        <Field label="类型">
                          <Select value={recordForm.type} onChange={(event) => setRecordForm((current) => ({ ...current, type: event.target.value }))}>
                            {(currentConnection?.capabilities.recordTypes || ['A', 'AAAA', 'CNAME', 'TXT']).map((type) => (
                              <option key={type} value={type}>
                                {type}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <Field label="名称">
                          <Input value={recordForm.name} onChange={(event) => setRecordForm((current) => ({ ...current, name: event.target.value }))} placeholder="例如：@ / www" />
                        </Field>
                        <Field label="内容">
                          <Input value={recordForm.content} onChange={(event) => setRecordForm((current) => ({ ...current, content: event.target.value }))} placeholder="例如：1.2.3.4" />
                        </Field>
                        <Field label="TTL">
                          <Input value={String(recordForm.ttl)} onChange={(event) => setRecordForm((current) => ({ ...current, ttl: Number(event.target.value || 1) }))} />
                        </Field>
                      </div>
                      {currentConnection?.capabilities.supportsProxyStatus && (
                        <label className="mt-4 inline-flex items-center gap-2 text-sm text-[color:var(--text-secondary)]">
                          <Checkbox checked={recordForm.proxied} onChange={(event) => setRecordForm((current) => ({ ...current, proxied: event.target.checked }))} />
                          <span>代理状态 (Cloudflare 云朵)</span>
                        </label>
                      )}
                      <div className="mt-5 flex justify-end gap-3">
                        <Button variant="ghost" onClick={() => setShowRecordForm(false)}>
                          取消
                        </Button>
                        <Button onClick={handleSaveRecord}>保存记录</Button>
                      </div>
                    </Card>
                  )}

                  <Card title="记录列表" subtitle="Gcore 的复杂 RRset 会标记为只读；Cloudflare 记录仍支持代理状态编辑。">
                    <div className="space-y-4">
                      <div className="grid grid-cols-1 gap-4 rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--surface-card-strong)] p-4 md:grid-cols-[minmax(0,1fr)_180px]">
                        <Field label="搜索">
                          <Input value={recordSearch} onChange={(event) => setRecordSearch(event.target.value)} placeholder="搜索名称、内容或类型" />
                        </Field>
                        <Field label="每页数量">
                          <Select value={String(recordPageSize)} onChange={(event) => setRecordPageSize(Number(event.target.value))}>
                            <option value="10">每页 10 条</option>
                            <option value="20">每页 20 条</option>
                            <option value="50">每页 50 条</option>
                          </Select>
                        </Field>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-left">
                          <thead>
                            <tr className="border-b border-[color:var(--border-subtle)] text-sm text-[color:var(--text-tertiary)]">
                              <th className="pb-4 font-medium">类型</th>
                              <th className="pb-4 font-medium">名称</th>
                              <th className="pb-4 font-medium">内容</th>
                              <th className="pb-4 font-medium">TTL</th>
                              <th className="pb-4 font-medium">状态</th>
                              <th className="pb-4 font-medium text-right">操作</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-[color:var(--border-subtle)]">
                            {pagedRecords.map((record) => (
                              <tr key={record.id} className="hover:bg-[var(--surface-soft)]/50">
                                <td className="py-4 font-medium text-[var(--brand-500)]">{record.type}</td>
                                <td className="py-4 text-[color:var(--text-primary)]">{record.name}</td>
                                <td className="py-4 max-w-xs truncate text-sm text-[color:var(--text-tertiary)]" title={record.content}>
                                  {record.content}
                                </td>
                                <td className="py-4 text-sm text-[color:var(--text-tertiary)]">{record.ttl}</td>
                                <td className="py-4">
                                  {record.editable ? (
                                    <Badge variant="success">{record.proxied ? '可编辑 / Proxied' : '可编辑'}</Badge>
                                  ) : (
                                    <Badge variant="warning">只读</Badge>
                                  )}
                                </td>
                                <td className="py-4">
                                  <div className="flex items-center justify-end gap-2">
                                    <Button
                                      variant="secondary"
                                      size="sm"
                                      disabled={!record.editable}
                                      onClick={() => {
                                        setEditingRecordId(record.id);
                                        setRecordForm({
                                          name: record.name,
                                          content: record.content,
                                          type: record.type,
                                          ttl: record.ttl,
                                          proxied: Boolean(record.proxied),
                                        });
                                        setShowRecordForm(true);
                                      }}
                                    >
                                      编辑
                                    </Button>
                                    <IconButton title="删除记录" variant="danger" disabled={!record.editable} onClick={() => handleDeleteRecord(record)}>
                                      <Trash2 className="h-4 w-4" />
                                    </IconButton>
                                  </div>
                                  {!record.editable && record.readOnlyReason && (
                                    <p className="mt-2 text-right text-xs text-[color:var(--text-tertiary)]">{record.readOnlyReason}</p>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <PaginationControls page={currentPage} totalPages={totalPages} totalItems={filteredRecords.length} pageSize={recordPageSize} onPageChange={setRecordPage} />
                    </div>
                  </Card>
                </div>
              )}
            </Card>
          )}
        </div>
      )}

      {activeTab === 'routes' && (
        <div className="space-y-6">
          <Card title="网关概览" subtitle="路由转发挂在当前服务器的网关之下；没有网关能力的服务器不会再显示误导性的空列表。">
            {gateways.length === 0 ? (
              <EmptyState icon={Network} title="当前服务器未启用网关" description="这台服务器暂时没有可管理的网关能力，因此不能配置路由转发。" />
            ) : (
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                {gateways.map((gateway) => (
                  <div key={gateway.id} className="rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--surface-card-strong)] p-5">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <h3 className="text-lg font-semibold text-[color:var(--text-primary)]">{gateway.displayName}</h3>
                        <p className="mt-1 text-sm text-[color:var(--text-tertiary)]">{gateway.kind} · {gateway.server?.displayName}</p>
                      </div>
                      <Badge variant={gateway.status === 'active' ? 'success' : 'warning'}>{gateway.status}</Badge>
                    </div>
                    <div className="mt-4 grid grid-cols-2 gap-3 text-sm text-[color:var(--text-secondary)]">
                      <div>路由数：{gateway.routeCount}</div>
                      <div>证书数：{gateway.certificateCount}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {manageableGateway && (
            <>
              {showRouteForm && (
                <Card title="添加反向代理">
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <Field label="域名">
                      <Input value={newRoute.domain} onChange={(event) => setNewRoute((current) => ({ ...current, domain: event.target.value }))} placeholder="app.example.com" />
                    </Field>
                    <Field label="目标地址">
                      <Input value={newRoute.target} onChange={(event) => setNewRoute((current) => ({ ...current, target: event.target.value }))} placeholder="127.0.0.1:8000" />
                    </Field>
                  </div>
                  <label className="mt-5 inline-flex items-center gap-2 text-sm text-[color:var(--text-secondary)]">
                    <Checkbox checked={newRoute.ssl} onChange={(event) => setNewRoute((current) => ({ ...current, ssl: event.target.checked }))} />
                    <span>自动申请 SSL 证书</span>
                  </label>
                  <div className="mt-5 flex justify-end gap-3">
                    <Button variant="ghost" onClick={() => setShowRouteForm(false)}>
                      取消
                    </Button>
                    <Button onClick={handleSaveRoute}>保存并重载网关</Button>
                  </div>
                </Card>
              )}

              <Card
                title="路由列表"
                subtitle="路由直接归属到当前服务器的网关。切换服务器时，会自动切到对应网关上下文。"
                action={
                  <div className="flex items-center gap-3">
                    {gateways.length > 1 && (
                      <Select value={activeGateway?.id || ''} onChange={(event) => setSelectedGatewayId(event.target.value)}>
                        {gateways.map((gateway) => (
                          <option key={gateway.id} value={gateway.id}>
                            {gateway.displayName}
                          </option>
                        ))}
                      </Select>
                    )}
                    <Button onClick={() => setShowRouteForm(true)}>
                      <Plus className="h-4 w-4" />
                      添加路由
                    </Button>
                  </div>
                }
              >
                <div className="space-y-4">
                  {routes
                    .filter((route) => !activeGateway || route.gatewayId === activeGateway.id)
                    .map((route) => (
                    <div key={route.id} className="flex flex-col gap-3 rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--surface-card-strong)] px-5 py-4 md:flex-row md:items-center md:justify-between">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-[color:var(--text-primary)]">{route.domain}</span>
                          <Badge variant={route.ssl ? 'success' : 'warning'}>{route.ssl ? 'HTTPS' : 'HTTP'}</Badge>
                        </div>
                        <p className="mt-2 text-sm text-[color:var(--text-tertiary)]">指向：{route.target}</p>
                      </div>
                      <IconButton title="删除路由" variant="danger" onClick={() => handleDeleteRoute(route.id)}>
                        <Trash2 className="h-5 w-5" />
                      </IconButton>
                    </div>
                  ))}
                  {routes.filter((route) => !activeGateway || route.gatewayId === activeGateway.id).length === 0 && (
                    <EmptyState icon={Network} title="暂无路由" description="当前服务器网关还没有配置域名转发。" />
                  )}
                </div>
              </Card>
            </>
          )}
        </div>
      )}

      {activeTab === 'certs' && (
        <Card title="证书管理" subtitle="证书视图按服务器与网关分组，没有网关能力的服务器会明确标记为不可管理。">
          {gateways.length === 0 ? (
            <EmptyState icon={ShieldCheck} title="当前服务器没有可管理证书" description="先启用网关或切到已接入网关的服务器后，再查看证书与续签状态。" />
          ) : (
            <div className="space-y-4">
              {certificates.map((cert) => (
                <div key={cert.id || cert.domain} className="rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--surface-card-strong)] px-5 py-4">
                  <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-[color:var(--text-primary)]">{cert.domain}</span>
                        <Badge variant={cert.status === 'valid' ? 'success' : 'danger'}>{cert.status === 'valid' ? '正常' : cert.status}</Badge>
                      </div>
                      <p className="mt-2 text-sm text-[color:var(--text-tertiary)]">
                        网关：{cert.gatewayName || activeGateway?.displayName || '-'} · 目标：{cert.routeTarget || '-'}
                      </p>
                      <p className="mt-1 text-xs text-[color:var(--text-tertiary)]">
                        有效期：{cert.issueDate} → {cert.expiryDate}
                      </p>
                    </div>
                    <Button variant="secondary" onClick={() => handleRenew(cert)}>
                      手动续约
                    </Button>
                  </div>
                </div>
              ))}
              {certificates.length === 0 && <EmptyState icon={ShieldCheck} title="暂无证书" description="当前网关还没有 SSL 证书，先在路由中开启 SSL 或接入已有网关。" />}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
