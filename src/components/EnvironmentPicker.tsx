import React from 'react';
import { Server } from 'lucide-react';
import { EnvironmentSummary } from '../types';
import { Badge, Field, Select } from './ui/primitives';

type EnvironmentPickerProps = {
  environments: EnvironmentSummary[];
  value: string;
  onChange: (value: string) => void;
  label?: string;
  hint?: string;
  allowedModule?: string;
  disabled?: boolean;
};

export function EnvironmentPicker({
  environments,
  value,
  onChange,
  label = '运行环境',
  hint,
  allowedModule,
  disabled,
}: EnvironmentPickerProps) {
  const filtered = allowedModule
    ? environments.filter((environment) => environment.capabilities.modules?.[allowedModule])
    : environments;
  const selected = filtered.find((environment) => environment.id === value) || filtered[0] || null;

  return (
    <div className="rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--surface-card)] p-4">
      <Field
        label={label}
        hint={
          hint ||
          (selected
            ? `${selected.displayName} · ${selected.host}${selected.isLocal ? '' : `:${selected.port}`}`
            : '当前没有可用环境')
        }
      >
        <Select value={selected?.id || value} onChange={(event) => onChange(event.target.value)} disabled={disabled || filtered.length === 0}>
          {filtered.map((environment) => (
            <option key={environment.id} value={environment.id}>
              {environment.displayName} · {environment.status}
            </option>
          ))}
        </Select>
      </Field>

      {selected && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[color:var(--text-tertiary)]">
          <span className="inline-flex items-center gap-1">
            <Server className="h-3.5 w-3.5" />
            {selected.type === 'local-docker' ? '本机 Docker' : '远端 SSH + Docker'}
          </span>
          <Badge variant={selected.status === 'ready' ? 'success' : selected.status === 'warning' ? 'warning' : selected.status === 'error' ? 'danger' : 'default'}>
            {selected.status}
          </Badge>
          {selected.capabilities.inspect && <Badge variant="default">inspect</Badge>}
          {selected.capabilities.operate && <Badge variant="default">operate</Badge>}
          {selected.capabilities.elevated && <Badge variant="default">elevated</Badge>}
        </div>
      )}
    </div>
  );
}
