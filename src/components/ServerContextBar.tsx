import React, { useMemo, useState } from 'react';
import { CheckCircle2, ChevronDown, Cpu, HardDrive, MemoryStick, Server } from 'lucide-react';
import { ServerSummary } from '../types';
import { Badge, Button } from './ui/primitives';
import { cn } from '../lib/utils';

type ServerContextBarProps = {
  servers: ServerSummary[];
  serverId: string;
  onChange: (serverId: string) => void;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
};

function statusVariant(status: string) {
  if (status === 'ready') return 'success';
  if (status === 'warning') return 'warning';
  if (status === 'error') return 'danger';
  return 'default';
}

export function ServerContextBar({ servers, serverId, onChange, title, subtitle, action }: ServerContextBarProps) {
  const [open, setOpen] = useState(false);
  const current = useMemo(
    () => servers.find((server) => server.id === serverId) || servers[0] || null,
    [serverId, servers]
  );

  return (
    <div className="rounded-[1.65rem] border border-[color:var(--border-subtle)] bg-[var(--surface-card)] p-5 shadow-[0_24px_50px_-36px_rgba(15,23,42,0.45)]">
      <div className="flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[color:var(--text-tertiary)]">当前服务器上下文</p>
          <h3 className="mt-2 text-xl font-semibold tracking-tight text-[color:var(--text-primary)]">{title}</h3>
          {subtitle && <p className="mt-1 text-sm text-[color:var(--text-tertiary)]">{subtitle}</p>}
        </div>

        <div className="flex flex-col gap-3 xl:min-w-[420px]">
          <div className="relative">
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              className="flex w-full items-center justify-between gap-4 rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--surface-card-strong)] px-4 py-4 text-left transition hover:border-[color:var(--border-strong)] hover:bg-[var(--surface-soft)]"
            >
              {current ? (
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-semibold text-[color:var(--text-primary)]">{current.displayName}</span>
                    <Badge variant={statusVariant(current.status)}>{current.isLocal ? '当前宿主机' : '远端服务器'}</Badge>
                    <Badge variant="default">{current.host}</Badge>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-[color:var(--text-tertiary)]">
                    <span className="inline-flex items-center gap-1">
                      <Cpu className="h-3.5 w-3.5" />
                      CPU {current.metrics?.cpu?.toFixed(1) || '0.0'}%
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <MemoryStick className="h-3.5 w-3.5" />
                      内存 {current.metrics?.memoryPercent?.toFixed(1) || '0.0'}%
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <HardDrive className="h-3.5 w-3.5" />
                      磁盘 {current.metrics?.diskPercent?.toFixed(1) || '0.0'}%
                    </span>
                  </div>
                </div>
              ) : (
                <span className="text-sm text-[color:var(--text-tertiary)]">暂无可用服务器</span>
              )}
              <ChevronDown className={cn('h-5 w-5 text-[color:var(--text-tertiary)] transition', open && 'rotate-180')} />
            </button>

            {open && (
              <div className="absolute left-0 top-[calc(100%+0.75rem)] z-30 w-full overflow-hidden rounded-[1.4rem] border border-[color:var(--border-subtle)] bg-[var(--surface-card)] shadow-2xl">
                <div className="max-h-[320px] overflow-auto p-2">
                  {servers.map((server) => (
                    <button
                      key={server.id}
                      type="button"
                      onClick={() => {
                        onChange(server.id);
                        setOpen(false);
                      }}
                      className={cn(
                        'mb-2 flex w-full items-start justify-between gap-4 rounded-2xl px-4 py-4 text-left transition last:mb-0',
                        server.id === current?.id
                          ? 'border border-[color:var(--brand-500)] bg-[var(--brand-soft)]'
                          : 'border border-transparent bg-[var(--surface-card-strong)] hover:border-[color:var(--border-strong)] hover:bg-[var(--surface-soft)]'
                      )}
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-[color:var(--text-primary)]">{server.displayName}</span>
                          <Badge variant={statusVariant(server.status)}>{server.status}</Badge>
                        </div>
                        <p className="mt-1 text-xs text-[color:var(--text-tertiary)]">
                          {server.host} · Docker {server.capabilities.dockerVersion || '不可用'}
                        </p>
                      </div>
                      {server.id === current?.id && <CheckCircle2 className="mt-0.5 h-5 w-5 text-[var(--brand-600)]" />}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {action && <div className="flex justify-end">{action}</div>}
        </div>
      </div>
    </div>
  );
}
