import React, { useState, useEffect } from 'react';
import { 
  LayoutDashboard, Globe, FileCode, Network, ShieldCheck, Settings, Play, Square, RotateCcw, Trash2, Terminal, Plus, Save, RefreshCw, ExternalLink, ChevronRight, Activity, AlertCircle, CheckCircle2, Edit3, Search, Sun, Moon, Truck, Eye
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from './lib/utils';
import { ContainerInfo, ProxyRoute, DNSRecord, AppConfig, Certificate } from './types';
import { Monitor } from './components/Monitor';

// 统一的 fetch 封装，自动携带 token
export const apiFetch = async (url: string, options: RequestInit = {}) => {
  const token = localStorage.getItem('token');
  const headers = new Headers(options.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    // 触发一个自定义事件，让 App 组件处理登出
    window.dispatchEvent(new Event('auth-unauthorized'));
  }
  return res;
};

// --- 通用 UI 组件 ---

// 侧边栏导航项组件
const SidebarItem = ({ icon: Icon, label, active, onClick }: { icon: any, label: string, active: boolean, onClick: () => void }) => (
  <button
    onClick={onClick}
    className={cn(
      "flex items-center w-full gap-3 px-4 py-3 text-sm font-medium transition-all duration-200 rounded-lg group",
      active 
        ? "bg-blue-600 text-white shadow-lg shadow-blue-500/30" 
        : "text-slate-600 hover:bg-slate-200 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white"
    )}
  >
    <Icon className={cn("w-5 h-5", active ? "text-white" : "text-slate-500 group-hover:text-blue-500 dark:text-slate-400 dark:group-hover:text-blue-400")} />
    {label}
  </button>
);

// 卡片容器组件，用于包裹各个模块的内容
const Card = ({ children, title, subtitle, action }: { children: React.ReactNode, title?: string, subtitle?: string, action?: React.ReactNode }) => (
  <div className="overflow-hidden border bg-white dark:bg-slate-900/50 border-slate-200 dark:border-slate-800 rounded-xl backdrop-blur-sm shadow-sm dark:shadow-none">
    {(title || action) && (
      <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-800">
        <div>
          {title && <h3 className="text-lg font-semibold text-slate-900 dark:text-white">{title}</h3>}
          {subtitle && <p className="text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>}
        </div>
        {action}
      </div>
    )}
    <div className="p-6">{children}</div>
  </div>
);

// 状态徽章组件
const Badge = ({ children, variant = 'default', className, ...props }: { children: React.ReactNode, variant?: 'default' | 'success' | 'warning' | 'danger', className?: string, [key: string]: any }) => {
  const variants = {
    default: "bg-slate-100 text-slate-600 border border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700",
    success: "bg-emerald-50 text-emerald-600 border border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-500/20",
    warning: "bg-amber-50 text-amber-600 border border-amber-200 dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-500/20",
    danger: "bg-rose-50 text-rose-600 border border-rose-200 dark:bg-rose-500/10 dark:text-rose-400 dark:border-rose-500/20",
  };
  return (
    <span className={cn("px-2 py-0.5 text-xs font-medium rounded-full", variants[variant], className)} {...props}>
      {children}
    </span>
  );
};

// --- 核心功能视图模块 ---

// 1. Docker 容器管理视图
const DockerView = () => {
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [logs, setLogs] = useState<string | null>(null);

  // 获取所有容器列表
  const fetchContainers = async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/docker/containers');
      const data = await res.json();
      setContainers(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchContainers();
  }, []);

  // 执行容器操作 (启动/停止/重启/删除)
  const handleAction = async (id: string, action: string) => {
    try {
      await apiFetch(`/api/docker/container/${id}/${action}`, { method: 'POST' });
      fetchContainers();
    } catch (e) {
      console.error(e);
    }
  };

  // 查看容器日志
  const viewLogs = async (id: string) => {
    try {
      const res = await apiFetch(`/api/docker/container/${id}/logs`);
      const text = await res.text();
      setLogs(text);
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-slate-900 dark:text-white">Docker 镜像管理</h2>
        <button 
          onClick={fetchContainers}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white transition-colors bg-blue-600 rounded-lg hover:bg-blue-700"
        >
          <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
          刷新状态
        </button>
      </div>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="text-slate-500 dark:text-slate-400 text-sm border-b border-slate-200 dark:border-slate-800">
                <th className="pb-4 font-medium">名称</th>
                <th className="pb-4 font-medium">镜像</th>
                <th className="pb-4 font-medium">状态</th>
                <th className="pb-4 font-medium">运行时间</th>
                <th className="pb-4 font-medium text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {containers.map((c) => (
                <tr key={c.id} className="group hover:bg-slate-50 dark:hover:bg-slate-800/30">
                  <td className="py-4 font-medium text-slate-900 dark:text-white">{c.name || 'Unknown'}</td>
                  <td className="py-4 text-slate-500 dark:text-slate-400 text-sm">{c.image}</td>
                  <td className="py-4">
                    <Badge variant={c.state === 'running' ? 'success' : 'danger'}>
                      {c.state}
                    </Badge>
                  </td>
                  <td className="py-4 text-slate-500 dark:text-slate-400 text-sm">{c.status}</td>
                  <td className="py-4">
                    <div className="flex items-center justify-end gap-2">
                      <button onClick={() => viewLogs(c.id)} className="p-2 text-slate-400 hover:text-blue-500 dark:hover:text-blue-400 transition-colors" title="查看日志">
                        <Terminal className="w-4 h-4" />
                      </button>
                      {c.state === 'running' ? (
                        <button onClick={() => handleAction(c.id, 'stop')} className="p-2 text-slate-400 hover:text-rose-500 dark:hover:text-rose-400 transition-colors" title="停止">
                          <Square className="w-4 h-4" />
                        </button>
                      ) : (
                        <button onClick={() => handleAction(c.id, 'start')} className="p-2 text-slate-400 hover:text-emerald-500 dark:hover:text-emerald-400 transition-colors" title="启动">
                          <Play className="w-4 h-4" />
                        </button>
                      )}
                      <button onClick={() => handleAction(c.id, 'restart')} className="p-2 text-slate-400 hover:text-amber-500 dark:hover:text-amber-400 transition-colors" title="重启">
                        <RotateCcw className="w-4 h-4" />
                      </button>
                      <button onClick={() => handleAction(c.id, 'remove')} className="p-2 text-slate-400 hover:text-rose-600 transition-colors" title="删除">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {containers.length === 0 && !loading && (
                <tr>
                  <td colSpan={5} className="py-12 text-center text-slate-500">
                    未检测到运行中的 Docker 容器
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* 日志弹窗 */}
      <AnimatePresence>
        {logs && (
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-slate-900/60 dark:bg-black/60 backdrop-blur-sm"
          >
            <div className="w-full max-w-4xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]">
              <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-800">
                <h3 className="text-lg font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                  <Terminal className="w-5 h-5 text-blue-500 dark:text-blue-400" />
                  容器日志
                </h3>
                <button onClick={() => setLogs(null)} className="text-slate-400 hover:text-slate-900 dark:hover:text-white">
                  <Trash2 className="w-5 h-5" />
                </button>
              </div>
              <div className="flex-1 p-6 overflow-auto font-mono text-sm text-slate-800 dark:text-slate-300 bg-slate-50 dark:bg-black/40">
                <pre className="whitespace-pre-wrap">{logs}</pre>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

// 2. DNS 代理视图 (Cloudflare)
const DNSView = ({ config }: { config: AppConfig | null }) => {
  const [records, setRecords] = useState<DNSRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedDomain, setSelectedDomain] = useState<string>('');
  const [newRecord, setNewRecord] = useState({ name: '', content: config?.vpsIp || '', type: 'A', proxied: config?.cfProxied || false, domain: '' });

  const [availableZones, setAvailableZones] = useState<{id: string, name: string}[]>([]);
  const [isFallbackMode, setIsFallbackMode] = useState(false);
  const [zonesLoaded, setZonesLoaded] = useState(false);

  // 初始化获取可用域名
  useEffect(() => {
    if (config?.hasCfToken) {
      const fetchZones = async () => {
        try {
          const res = await apiFetch('/api/dns/zones');
          const data = await res.json();
          if (res.ok) {
            setAvailableZones(data.zones || []);
            setIsFallbackMode(data.isFallbackMode || false);
            if (data.zones && data.zones.length > 0) {
              setSelectedDomain(data.zones[0].name);
            }
          }
        } catch (e) {
          console.error("Failed to fetch zones", e);
        } finally {
          setZonesLoaded(true);
        }
      };
      fetchZones();
    }
  }, [config?.hasCfToken]);

  // 获取指定域名的 DNS 记录
  const fetchRecords = async () => {
    if (!selectedDomain) return;
    setLoading(true);
    try {
      const res = await apiFetch(`/api/dns/records?domain=${selectedDomain}`);
      const data = await res.json();
      if (res.ok) {
        setRecords(Array.isArray(data) ? data : []);
      } else {
        console.error("DNS Fetch Error:", data);
        alert(`获取 DNS 记录失败: ${data.error}\n详情: ${JSON.stringify(data.details || '')}`);
        setRecords([]);
      }
    } catch (e) {
      console.error(e);
      alert("网络请求失败，请查看控制台");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (config?.hasCfToken && selectedDomain) {
      fetchRecords();
    }
  }, [config, selectedDomain]);

  // 保存或更新 DNS 记录
  const handleSave = async () => {
    try {
      const url = editingId ? `/api/dns/records/${editingId}` : '/api/dns/records';
      const method = editingId ? 'PUT' : 'POST';
      const payload = { ...newRecord, domain: selectedDomain };
      const res = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        setShowAdd(false);
        setEditingId(null);
        setNewRecord({ name: '', content: config?.vpsIp || '', type: 'A', proxied: config?.cfProxied || false, domain: '' });
        fetchRecords();
      } else {
        const data = await res.json();
        alert(data.error || '保存记录失败');
      }
    } catch (e) {
      console.error(e);
    }
  };

  // 编辑记录
  const handleEdit = (record: DNSRecord) => {
    setNewRecord({ name: record.name, content: record.content, type: record.type, proxied: record.proxied, domain: selectedDomain });
    setEditingId(record.id);
    setShowAdd(true);
  };

  // 删除记录
  const handleDelete = async (id: string) => {
    if (!confirm('确定要删除这条 DNS 记录吗？')) return;
    try {
      await apiFetch(`/api/dns/records/${id}?domain=${selectedDomain}`, { method: 'DELETE' });
      fetchRecords();
    } catch (e) {
      console.error(e);
    }
  };

  // 如果未配置 CF Token，显示提示信息
  if (!config?.hasCfToken) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-bold text-slate-900 dark:text-white">DNS 代理模块</h2>
        <Card>
          <div className="py-12 text-center">
            <AlertCircle className="w-12 h-12 text-amber-500 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-slate-900 dark:text-white mb-2">未配置 Cloudflare</h3>
            <p className="text-slate-500 dark:text-slate-400">请在 .env 文件中配置 CF_API_TOKEN 以启用此功能。</p>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {isFallbackMode && (
        <div className="p-4 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 rounded-xl flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
          <div>
            <h4 className="text-sm font-medium text-amber-800 dark:text-amber-400">降级告警：未获取到完整 Zone 读取权限</h4>
            <p className="text-sm text-amber-700 dark:text-amber-500/80 mt-1">
              当前 Token 缺乏全局的 Zone:Read 权限，系统已被迫退回兜底模式，域名列表仅使用 ALLOWED_DOMAINS 呈现。后台使用的是强绑定的 CF_ZONE_ID，若下拉选择了其他无关域名操作，将会引发 403 / 404 错误。请务必确认操作范围一致。
            </p>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-slate-900 dark:text-white">DNS 代理模块</h2>
        <div className="flex items-center gap-3">
          {/* 域名选择器 */}
          {availableZones && availableZones.length > 0 && (
            <select 
              value={selectedDomain}
              onChange={(e) => setSelectedDomain(e.target.value)}
              className={cn("px-4 py-2 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none", availableZones.length <= 1 && "bg-slate-50 dark:bg-slate-900 text-slate-500 cursor-not-allowed")}
              disabled={availableZones.length <= 1}
            >
              {availableZones.map(z => (
                <option key={z.name} value={z.name}>{z.name}</option>
              ))}
            </select>
          )}
          <button 
            onClick={fetchRecords}
            className="p-2 bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700"
          >
            <RefreshCw className={cn("w-5 h-5", loading && "animate-spin")} />
          </button>
          <button 
            onClick={() => {
              setEditingId(null);
              setNewRecord({ name: '', content: config?.vpsIp || '', type: 'A', proxied: config?.cfProxied || false, domain: selectedDomain });
              setShowAdd(true);
            }}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700"
          >
            <Plus className="w-4 h-4" />
            添加记录
          </button>
        </div>
      </div>

      {/* 添加/编辑表单 */}
      {showAdd && (
        <Card title={editingId ? "编辑 DNS 记录" : "添加 DNS 记录"}>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
            <div className="space-y-2">
              <label className="text-sm text-slate-500 dark:text-slate-400">记录类型</label>
              <select 
                value={newRecord.type}
                onChange={(e) => setNewRecord({...newRecord, type: e.target.value})}
                className="w-full px-4 py-2 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
              >
                <option value="A">A</option>
                <option value="CNAME">CNAME</option>
                <option value="TXT">TXT</option>
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-sm text-slate-500 dark:text-slate-400">名称 (Name)</label>
              <input 
                type="text" 
                value={newRecord.name}
                onChange={(e) => setNewRecord({...newRecord, name: e.target.value})}
                className="w-full px-4 py-2 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                placeholder="subdomain"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm text-slate-500 dark:text-slate-400">内容 (Content)</label>
              <input 
                type="text" 
                value={newRecord.content}
                onChange={(e) => setNewRecord({...newRecord, content: e.target.value})}
                className="w-full px-4 py-2 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                placeholder="1.2.3.4"
              />
            </div>
            <div className="space-y-2 flex flex-col justify-end pb-2">
              <div className="flex items-center gap-2">
                <input 
                  type="checkbox" 
                  id="proxied" 
                  checked={newRecord.proxied}
                  onChange={(e) => setNewRecord({...newRecord, proxied: e.target.checked})}
                  className="w-4 h-4 rounded border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-blue-600 focus:ring-blue-500 focus:ring-offset-white dark:focus:ring-offset-slate-900"
                />
                <label htmlFor="proxied" className="text-sm text-slate-600 dark:text-slate-300">Proxied (云朵开启)</label>
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-3">
            <button onClick={() => { setShowAdd(false); setEditingId(null); }} className="px-4 py-2 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white">取消</button>
            <button onClick={handleSave} className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">保存</button>
          </div>
        </Card>
      )}

      {/* 记录列表 */}
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="text-slate-500 dark:text-slate-400 text-sm border-b border-slate-200 dark:border-slate-800">
                <th className="pb-4 font-medium">类型</th>
                <th className="pb-4 font-medium">名称</th>
                <th className="pb-4 font-medium">内容</th>
                <th className="pb-4 font-medium">代理状态</th>
                <th className="pb-4 font-medium text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {records.map((r) => (
                <tr key={r.id} className="group hover:bg-slate-50 dark:hover:bg-slate-800/30">
                  <td className="py-4 font-medium text-blue-500 dark:text-blue-400">{r.type}</td>
                  <td className="py-4 text-slate-900 dark:text-white max-w-[150px] truncate" title={r.name}>{r.name}</td>
                  <td className="py-4 text-slate-500 dark:text-slate-400 text-sm max-w-xs truncate" title={r.content}>{r.content}</td>
                  <td className="py-4">
                    <Badge variant={r.proxied ? 'warning' : 'default'}>
                      {r.proxied ? 'Proxied' : 'DNS Only'}
                    </Badge>
                  </td>
                  <td className="py-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button onClick={() => handleEdit(r)} className="p-2 text-slate-400 hover:text-blue-500 dark:hover:text-blue-400 transition-colors" title="编辑">
                        <Edit3 className="w-4 h-4" />
                      </button>
                      <button onClick={() => handleDelete(r.id)} className="p-2 text-slate-400 hover:text-rose-600 transition-colors" title="删除">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {records.length === 0 && !loading && (
                <tr>
                  <td colSpan={5} className="py-12 text-center text-slate-500">
                    未找到 DNS 记录
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
};

// 3. 部署服务视图 (Docker Compose)
const ComposeView = () => {
  const [imageName, setImageName] = useState('');
  const [serviceName, setServiceName] = useState('');
  const [containerPort, setContainerPort] = useState('');
  const [remarks, setRemarks] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
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

  // 自动根据镜像名生成服务名
  useEffect(() => {
    if (imageName && !serviceName) {
      const name = imageName.split(':')[0].split('/').pop() || '';
      setServiceName(name.replace(/[^a-zA-Z0-9_-]/g, ''));
    }
  }, [imageName]);

  // 生成 Compose 模板
  const handleGenerate = async () => {
    if (!imageName.trim() || !serviceName.trim() || !containerPort.trim()) {
      alert("请填写镜像名、服务名和容器端口");
      return;
    }
    
    setIsGenerating(true);
    try {
      const composeObj = {
        services: {
          [serviceName]: {
            image: imageName,
            container_name: serviceName,
            restart: "unless-stopped",
            expose: [containerPort],
            networks: ["proxy_net"]
          }
        },
        networks: {
          proxy_net: {
            external: true,
            name: "proxy_net"
          }
        }
      };

      // 简单地将对象转为 YAML 字符串
      const yamlStr = [
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
        `    name: proxy_net`
      ].join('\n');
      
      setYaml(yamlStr);
    } catch (e) {
      console.error(e);
    } finally {
      setIsGenerating(false);
    }
  };

  // 部署 Compose 配置
  const handleDeploy = async () => {
    try {
      const res = await apiFetch('/api/deploy/compose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: serviceName || 'new-service', composeYaml: yaml, remarks })
      });
      const data = await res.json();
      alert(data.message || data.error);
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-slate-900 dark:text-white">部署 Docker 项目</h2>
        <button 
          onClick={handleDeploy}
          className="flex items-center gap-2 px-6 py-2 bg-emerald-600 text-white font-medium rounded-lg hover:bg-emerald-700 shadow-lg shadow-emerald-500/20"
        >
          <Play className="w-4 h-4" />
          立即部署
        </button>
      </div>

      <Card title="项目配置" subtitle="填写基本信息生成推荐的 Compose 配置，包含 proxy_net 网络以便 Nginx 代理">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div className="space-y-2">
            <label className="text-sm text-slate-500 dark:text-slate-400">镜像名 (Image)</label>
            <input 
              type="text" 
              value={imageName}
              onChange={(e) => setImageName(e.target.value)}
              placeholder="例如: nginx:latest, ghcr.io/komari-monitor/komari:latest"
              className="w-full px-4 py-2 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm text-slate-500 dark:text-slate-400">服务名 (Service Name)</label>
            <input 
              type="text" 
              value={serviceName}
              onChange={(e) => setServiceName(e.target.value)}
              placeholder="例如: web, komari"
              className="w-full px-4 py-2 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm text-slate-500 dark:text-slate-400">容器内端口 (Expose Port)</label>
            <input 
              type="text" 
              value={containerPort}
              onChange={(e) => setContainerPort(e.target.value)}
              placeholder="例如: 80, 25774"
              className="w-full px-4 py-2 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm text-slate-500 dark:text-slate-400">备注 (可选)</label>
            <input 
              type="text" 
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              placeholder="项目备注信息"
              className="w-full px-4 py-2 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
            />
          </div>
        </div>
        <div className="flex justify-end">
          <button 
            onClick={handleGenerate}
            disabled={isGenerating || !imageName.trim() || !serviceName.trim() || !containerPort.trim()}
            className="flex items-center gap-2 px-6 py-2 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isGenerating ? <RefreshCw className="w-4 h-4 animate-spin" /> : <FileCode className="w-4 h-4" />}
            生成配置
          </button>
        </div>
      </Card>

      <Card title="Docker Compose 编辑器" subtitle="在线编辑并下发部署文件">
        <div className="relative">
          <textarea 
            value={yaml}
            onChange={(e) => setYaml(e.target.value)}
            className="w-full h-[400px] p-6 bg-slate-50 dark:bg-black/40 border border-slate-200 dark:border-slate-800 rounded-xl font-mono text-sm text-emerald-600 dark:text-emerald-400 focus:ring-2 focus:ring-emerald-500 outline-none resize-none"
            spellCheck={false}
          />
          <div className="absolute top-4 right-4 flex gap-2">
            <button className="p-2 bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 rounded-lg hover:text-slate-900 dark:hover:text-white border border-slate-200 dark:border-slate-700 shadow-sm" title="保存草稿">
              <Save className="w-4 h-4" />
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
};

// 4. 路由转发视图 (Nginx 代理)
const ProxyView = () => {
  const [routes, setRoutes] = useState<ProxyRoute[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [newRoute, setNewRoute] = useState({ domain: '', target: '127.0.0.1:8000', ssl: true });

  // 获取代理路由列表
  const fetchRoutes = async () => {
    try {
      const res = await apiFetch('/api/proxy/routes');
      const data = await res.json();
      setRoutes(data);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    fetchRoutes();
  }, []);

  // 添加新代理
  const handleAdd = async () => {
    try {
      await apiFetch('/api/proxy/routes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newRoute)
      });
      setShowAdd(false);
      setNewRoute({ domain: '', target: '127.0.0.1:8000', ssl: true });
      fetchRoutes();
    } catch (e) {
      console.error(e);
    }
  };

  // 删除代理
  const handleDelete = async (id: string) => {
    try {
      await apiFetch(`/api/proxy/routes/${id}`, { method: 'DELETE' });
      fetchRoutes();
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-slate-900 dark:text-white">Nginx 路由 & 证书</h2>
        <button 
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700"
        >
          <Plus className="w-4 h-4" />
          添加代理
        </button>
      </div>

      {showAdd && (
        <Card title="添加反向代理">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <div className="space-y-2">
              <label className="text-sm text-slate-500 dark:text-slate-400">域名 (Domain)</label>
              <input 
                type="text" 
                value={newRoute.domain}
                onChange={(e) => setNewRoute({...newRoute, domain: e.target.value})}
                className="w-full px-4 py-2 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                placeholder="app.example.com"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm text-slate-500 dark:text-slate-400">目标地址 (Target)</label>
              <input 
                type="text" 
                value={newRoute.target}
                onChange={(e) => setNewRoute({...newRoute, target: e.target.value})}
                className="w-full px-4 py-2 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                placeholder="127.0.0.1:8000"
              />
            </div>
          </div>
          <div className="flex items-center gap-2 mb-6">
            <input 
              type="checkbox" 
              id="ssl" 
              checked={newRoute.ssl}
              onChange={(e) => setNewRoute({...newRoute, ssl: e.target.checked})}
              className="w-4 h-4 rounded border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-blue-600 focus:ring-blue-500 focus:ring-offset-white dark:focus:ring-offset-slate-900"
            />
            <label htmlFor="ssl" className="text-sm text-slate-600 dark:text-slate-300">自动申请 SSL 证书 (Let's Encrypt)</label>
          </div>
          <div className="flex justify-end gap-3">
            <button onClick={() => setShowAdd(false)} className="px-4 py-2 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white">取消</button>
            <button onClick={handleAdd} className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">保存并重载 Nginx</button>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4">
        {routes.length === 0 ? (
          <Card>
            <div className="py-12 text-center">
              <Network className="w-12 h-12 text-slate-300 dark:text-slate-700 mx-auto mb-4" />
              <p className="text-slate-500">暂无代理配置，点击上方按钮添加</p>
            </div>
          </Card>
        ) : (
          routes.map(r => (
            <div key={r.id}>
              <Card>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-blue-500 dark:text-blue-400">
                      <Network className="w-6 h-6" />
                    </div>
                    <div>
                      <h4 className="text-lg font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                        {r.domain}
                        {r.ssl && <ShieldCheck className="w-4 h-4 text-emerald-500 dark:text-emerald-400" />}
                      </h4>
                      <p className="text-sm text-slate-500 dark:text-slate-400">指向: {r.target}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge variant={r.ssl ? 'success' : 'warning'}>
                      {r.ssl ? 'HTTPS 已开启' : 'HTTP'}
                    </Badge>
                    <button onClick={() => handleDelete(r.id)} className="p-2 text-slate-400 hover:text-rose-600 transition-colors">
                      <Trash2 className="w-5 h-5" />
                    </button>
                  </div>
                </div>
              </Card>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

// 5. 证书管理视图
const CertView = () => {
  const [certs, setCerts] = useState<Certificate[]>([]);
  const [loading, setLoading] = useState(false);

  // 获取证书列表
  const fetchCerts = async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/certs');
      const data = await res.json();
      setCerts(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCerts();
  }, []);

  // 手动续约证书
  const handleRenew = async (domain: string) => {
    try {
      const res = await apiFetch(`/api/certs/${domain}/renew`, { method: 'POST' });
      const data = await res.json();
      alert(data.message || data.error);
      fetchCerts();
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-slate-900 dark:text-white">证书管理模块</h2>
        <button 
          onClick={fetchCerts}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-700 dark:text-white transition-colors bg-slate-100 dark:bg-slate-800 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700"
        >
          <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
          刷新状态
        </button>
      </div>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="text-slate-500 dark:text-slate-400 text-sm border-b border-slate-200 dark:border-slate-800">
                <th className="pb-4 font-medium">域名</th>
                <th className="pb-4 font-medium">签发日期</th>
                <th className="pb-4 font-medium">过期日期</th>
                <th className="pb-4 font-medium">状态</th>
                <th className="pb-4 font-medium text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {certs.map((c, i) => (
                <tr key={i} className="group hover:bg-slate-50 dark:hover:bg-slate-800/30">
                  <td className="py-4 font-medium text-slate-900 dark:text-white flex items-center gap-2">
                    <ShieldCheck className={cn("w-4 h-4", c.status === 'valid' ? "text-emerald-500 dark:text-emerald-400" : "text-rose-500 dark:text-rose-400")} />
                    {c.domain}
                  </td>
                  <td className="py-4 text-slate-500 dark:text-slate-400 text-sm">{c.issueDate}</td>
                  <td className="py-4 text-slate-500 dark:text-slate-400 text-sm">{c.expiryDate}</td>
                  <td className="py-4">
                    <Badge variant={c.status === 'valid' ? 'success' : 'danger'}>
                      {c.status === 'valid' ? '正常' : '已过期'}
                    </Badge>
                  </td>
                  <td className="py-4 text-right">
                    <button 
                      onClick={() => handleRenew(c.domain)}
                      className="px-3 py-1 text-sm text-blue-500 dark:text-blue-400 border border-blue-500/30 rounded hover:bg-blue-50 dark:hover:bg-blue-500/10 transition-colors"
                    >
                      手动续约
                    </button>
                  </td>
                </tr>
              ))}
              {certs.length === 0 && !loading && (
                <tr>
                  <td colSpan={5} className="py-12 text-center text-slate-500">
                    未找到证书信息，请在路由转发中开启 SSL
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
};

// 6. Docker 迁移视图 (SSH)
const MigrationView = () => {
  const [form, setForm] = useState({ host: '', port: '22', username: 'root', password: '', privateKey: '' });
  const [logs, setLogs] = useState('');
  const [migrating, setMigrating] = useState(false);

  // 开始迁移流程
  const handleMigrate = async () => {
    if (!form.host || !form.username) return alert("请填写目标机器 IP 和用户名");
    setLogs('');
    setMigrating(true);
    try {
      const res = await apiFetch('/api/migrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      // 处理流式响应，实时显示日志
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          setLogs(prev => prev + decoder.decode(value));
        }
      }
    } catch (e: any) {
      setLogs(prev => prev + '\nError: ' + e.message);
    } finally {
      setMigrating(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-slate-900 dark:text-white">Docker 全量迁移</h2>
        <button 
          onClick={handleMigrate}
          disabled={migrating}
          className="flex items-center gap-2 px-6 py-2 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          {migrating ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
          开始迁移
        </button>
      </div>

      <Card title="目标机器 SSH 配置" subtitle="将当前机器的所有 Docker 服务和数据完整迁移至目标机器">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-sm text-slate-500 dark:text-slate-400">目标 IP (Host)</label>
            <input 
              type="text" 
              value={form.host}
              onChange={(e) => setForm({...form, host: e.target.value})}
              className="w-full px-4 py-2 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
              placeholder="192.168.1.100"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm text-slate-500 dark:text-slate-400">端口 (Port)</label>
            <input 
              type="text" 
              value={form.port}
              onChange={(e) => setForm({...form, port: e.target.value})}
              className="w-full px-4 py-2 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
              placeholder="22"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm text-slate-500 dark:text-slate-400">用户名 (Username)</label>
            <input 
              type="text" 
              value={form.username}
              onChange={(e) => setForm({...form, username: e.target.value})}
              className="w-full px-4 py-2 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
              placeholder="root"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm text-slate-500 dark:text-slate-400">密码 (Password) - 可选</label>
            <input 
              type="password" 
              value={form.password}
              onChange={(e) => setForm({...form, password: e.target.value})}
              className="w-full px-4 py-2 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
              placeholder="********"
            />
          </div>
          <div className="space-y-2 md:col-span-2">
            <label className="text-sm text-slate-500 dark:text-slate-400">私钥 (Private Key) - 可选</label>
            <textarea 
              value={form.privateKey}
              onChange={(e) => setForm({...form, privateKey: e.target.value})}
              className="w-full h-24 px-4 py-2 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none font-mono text-sm"
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----..."
            />
          </div>
        </div>
      </Card>

      {/* 迁移日志输出 */}
      {logs && (
        <Card title="迁移日志">
          <div className="w-full h-[300px] p-4 bg-slate-50 dark:bg-black/40 border border-slate-200 dark:border-slate-800 rounded-xl font-mono text-sm text-slate-800 dark:text-slate-300 overflow-auto whitespace-pre-wrap">
            {logs}
          </div>
        </Card>
      )}
    </div>
  );
};

// 7. 系统设置视图
const SettingsView = ({ config, onConfigChange }: { config: AppConfig | null, onConfigChange: () => void }) => {
  const [envContent, setEnvContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<'view' | 'edit' | 'preview'>('view');

  // 获取环境变量内容
  useEffect(() => {
    apiFetch('/api/config/env')
      .then(res => res.text())
      .then(setEnvContent)
      .catch(console.error);
  }, []);

  // 保存环境变量
  const handleSaveEnv = async () => {
    setSaving(true);
    try {
      const res = await apiFetch('/api/config/env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: envContent })
      });
      if (res.ok) {
        alert('配置已保存并生效');
        setMode('view');
        onConfigChange(); // 通知父组件重新加载配置
      } else {
        alert('保存失败');
      }
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-slate-900 dark:text-white">在线服务配置</h2>
        <div className="flex gap-3">
          {mode === 'view' && (
            <button 
              onClick={() => setMode('edit')}
              className="flex items-center gap-2 px-6 py-2 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700"
            >
              <Edit3 className="w-4 h-4" />
              编辑配置
            </button>
          )}
          {mode === 'edit' && (
            <>
              <button 
                onClick={() => setMode('view')}
                className="px-6 py-2 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
              >
                取消
              </button>
              <button 
                onClick={() => setMode('preview')}
                className="flex items-center gap-2 px-6 py-2 bg-emerald-600 text-white font-medium rounded-lg hover:bg-emerald-700"
              >
                <Eye className="w-4 h-4" />
                预览修改
              </button>
            </>
          )}
          {mode === 'preview' && (
            <>
              <button 
                onClick={() => setMode('edit')}
                className="px-6 py-2 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
              >
                返回编辑
              </button>
              <button 
                onClick={handleSaveEnv}
                disabled={saving}
                className="flex items-center gap-2 px-6 py-2 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                保存并生效
              </button>
            </>
          )}
        </div>
      </div>

      <Card title="环境变量 (.env)" subtitle={mode === 'view' ? "只读模式" : mode === 'edit' ? "编辑模式" : "预览模式"}>
        {mode === 'edit' ? (
          <textarea 
            value={envContent}
            onChange={(e) => setEnvContent(e.target.value)}
            className="w-full h-[300px] p-6 bg-white dark:bg-black/40 border border-slate-300 dark:border-slate-800 rounded-xl font-mono text-sm text-blue-600 dark:text-blue-400 focus:ring-2 focus:ring-blue-500 outline-none resize-none"
            spellCheck={false}
          />
        ) : (
          <div className="w-full h-[300px] p-6 bg-slate-50 dark:bg-black/40 border border-slate-200 dark:border-slate-800 rounded-xl font-mono text-sm text-slate-800 dark:text-slate-300 overflow-auto whitespace-pre-wrap">
            {envContent || '文件为空'}
          </div>
        )}
      </Card>

      <Card title="当前加载的配置状态">
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="p-4 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-200 dark:border-slate-700">
              <p className="text-sm text-slate-500 dark:text-slate-400 mb-1">VPS 公网 IP</p>
              <p className="text-slate-900 dark:text-white font-mono">{config?.vpsIp || '未配置'}</p>
            </div>
            <div className="p-4 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-200 dark:border-slate-700">
              <p className="text-sm text-slate-500 dark:text-slate-400 mb-1">Nginx 容器名称</p>
              <p className="text-slate-900 dark:text-white font-mono">{config?.nginxContainer}</p>
            </div>
            <div className="p-4 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-200 dark:border-slate-700">
              <p className="text-sm text-slate-500 dark:text-slate-400 mb-1">证书代理容器</p>
              <p className="text-slate-900 dark:text-white font-mono">{config?.certAgentContainer}</p>
            </div>
            <div className="p-4 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-200 dark:border-slate-700">
              <p className="text-sm text-slate-500 dark:text-slate-400 mb-1">Cloudflare API Token</p>
              <div className="flex items-center gap-2">
                {config?.hasCfToken ? (
                  <Badge variant="success"><CheckCircle2 className="w-3 h-3 inline mr-1" />已配置</Badge>
                ) : (
                  <Badge variant="danger"><AlertCircle className="w-3 h-3 inline mr-1" />未配置</Badge>
                )}
              </div>
            </div>
            <div className="p-4 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-200 dark:border-slate-700">
              <p className="text-sm text-slate-500 dark:text-slate-400 mb-1">开放的域名 (ALLOWED_DOMAINS)</p>
              <div className="flex flex-wrap gap-2 mt-1">
                {config?.allowedDomains && config.allowedDomains.length > 0 ? (
                  config.allowedDomains.map(d => <Badge key={d} variant="default">{d}</Badge>)
                ) : (
                  <Badge variant="warning">未配置多域名</Badge>
                )}
              </div>
            </div>
            <div className="p-4 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-200 dark:border-slate-700">
              <p className="text-sm text-slate-500 dark:text-slate-400 mb-1">CF 默认代理状态</p>
              <p className="text-slate-900 dark:text-white font-mono">{config?.cfProxied ? 'Proxied (云朵开启)' : 'DNS Only'}</p>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
};

// --- 主题管理 Hook (业界最佳实践) ---
type Theme = 'dark' | 'light' | 'system';

function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    return (localStorage.getItem('theme') as Theme) || 'system';
  });

  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove('light', 'dark');

    if (theme === 'system') {
      const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      root.classList.add(systemTheme);
      return;
    }

    root.classList.add(theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  return { theme, setTheme };
}

// --- 主应用组件 ---

export default function App() {
  const [activeTab, setActiveTab] = useState('monitor');
  const [config, setConfig] = useState<AppConfig | null>(null);
  const { theme, setTheme } = useTheme();
  const [loggedIn, setLoggedIn] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');

  // 检查登录状态
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const res = await apiFetch('/api/auth/me');
        const data = await res.json();
        setLoggedIn(data.loggedIn);
      } catch (e) {
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

  // 加载系统配置
  const loadConfig = () => {
    apiFetch('/api/config')
      .then(res => res.json())
      .then(setConfig)
      .catch(console.error);
  };

  useEffect(() => {
    if (loggedIn) {
      loadConfig();
    }
  }, [loggedIn]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');
    try {
      const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (data.success) {
        localStorage.setItem('token', data.token);
        setLoggedIn(true);
      } else {
        setLoginError(data.error || '登录失败');
      }
    } catch (e) {
      setLoginError('网络错误');
    }
  };

  const handleLogout = async () => {
    await apiFetch('/api/auth/logout', { method: 'POST' });
    localStorage.removeItem('token');
    setLoggedIn(false);
  };

  if (checkingAuth) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-[#0a0b10] text-slate-800 dark:text-slate-200"><RefreshCw className="w-8 h-8 animate-spin text-blue-500" /></div>;
  }

  if (!loggedIn) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-[#0a0b10] text-slate-800 dark:text-slate-200 transition-colors duration-200">
        <div className="w-full max-w-md p-8 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-xl">
          <div className="flex flex-col items-center mb-8">
            <div className="w-12 h-12 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-xl flex items-center justify-center shadow-lg shadow-blue-500/20 mb-4">
              <ShieldCheck className="w-7 h-7 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Docker 代理平台</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">请输入管理员账号登录</p>
          </div>
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">用户名</label>
              <input 
                type="text" 
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">密码</label>
              <input 
                type="password" 
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                required
              />
            </div>
            {loginError && <p className="text-sm text-rose-500">{loginError}</p>}
            <button type="submit" className="w-full py-2 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors">
              登录
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-slate-50 dark:bg-[#0a0b10] text-slate-800 dark:text-slate-200 font-sans transition-colors duration-200">
      {/* 左侧侧边栏 */}
      <aside className="w-72 border-r border-slate-200 dark:border-slate-800 flex flex-col bg-white/80 dark:bg-[#0a0b10]/80 backdrop-blur-xl sticky top-0 h-screen transition-colors duration-200">
        <div className="p-8">
          <div className="flex items-center gap-3 mb-10">
            <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-xl flex items-center justify-center shadow-lg shadow-blue-500/20">
              <Activity className="w-6 h-6 text-white" />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-white">DockerProxy</h1>
          </div>

          <nav className="space-y-2">
            <SidebarItem 
              icon={Activity} 
              label="主机监控" 
              active={activeTab === 'monitor'} 
              onClick={() => setActiveTab('monitor')} 
            />
            <SidebarItem 
              icon={LayoutDashboard} 
              label="容器管理" 
              active={activeTab === 'docker'} 
              onClick={() => setActiveTab('docker')} 
            />
            <SidebarItem 
              icon={Globe} 
              label="DNS 代理" 
              active={activeTab === 'dns'} 
              onClick={() => setActiveTab('dns')} 
            />
            <SidebarItem 
              icon={FileCode} 
              label="部署服务" 
              active={activeTab === 'compose'} 
              onClick={() => setActiveTab('compose')} 
            />
            <SidebarItem 
              icon={Network} 
              label="路由转发" 
              active={activeTab === 'proxy'} 
              onClick={() => setActiveTab('proxy')} 
            />
            <SidebarItem 
              icon={ShieldCheck} 
              label="证书管理" 
              active={activeTab === 'certs'} 
              onClick={() => setActiveTab('certs')} 
            />
            <SidebarItem 
              icon={Truck} 
              label="Docker 迁移" 
              active={activeTab === 'migrate'} 
              onClick={() => setActiveTab('migrate')} 
            />
          </nav>
        </div>

        {/* 底部设置与主题切换 */}
        <div className="mt-auto p-8 border-t border-slate-200 dark:border-slate-800 space-y-2">
          <button
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            className="flex items-center w-full gap-3 px-4 py-3 text-sm font-medium transition-all duration-200 rounded-lg text-slate-600 hover:bg-slate-200 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white"
          >
            {theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            {theme === 'dark' ? '切换至明亮模式' : '切换至暗黑模式'}
          </button>
          <button
            onClick={handleLogout}
            className="flex items-center w-full gap-3 px-4 py-3 text-sm font-medium transition-all duration-200 rounded-lg text-slate-600 hover:bg-rose-100 hover:text-rose-600 dark:text-slate-400 dark:hover:bg-rose-900/30 dark:hover:text-rose-400"
          >
            <ExternalLink className="w-5 h-5" />
            退出登录
          </button>
          <SidebarItem 
            icon={Settings} 
            label="系统设置" 
            active={activeTab === 'settings'} 
            onClick={() => setActiveTab('settings')} 
          />
        </div>
      </aside>

      {/* 右侧主内容区 */}
      <main className="flex-1 p-10 overflow-auto">
        <div className="max-w-6xl mx-auto">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -10 }}
              transition={{ duration: 0.2 }}
            >
              {activeTab === 'monitor' && <Monitor apiFetch={apiFetch} />}
              {activeTab === 'docker' && <DockerView />}
              {activeTab === 'dns' && <DNSView config={config} />}
              {activeTab === 'compose' && <ComposeView />}
              {activeTab === 'proxy' && <ProxyView />}
              {activeTab === 'certs' && <CertView />}
              {activeTab === 'migrate' && <MigrationView />}
              {activeTab === 'settings' && <SettingsView config={config} onConfigChange={loadConfig} />}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}
