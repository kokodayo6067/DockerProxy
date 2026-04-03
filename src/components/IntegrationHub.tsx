import React, { useState } from 'react';
import { PlugZap, Server } from 'lucide-react';
import { EnvironmentSummary, ServerSummary } from '../types';
import { PageHeader, SegmentedTabs } from './ui/primitives';
import { EnvironmentManager } from './EnvironmentManager';
import { DnsConnectionManager } from './DnsConnectionManager';

type IntegrationHubProps = {
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
  servers: ServerSummary[];
  onRefreshServers: () => Promise<void> | void;
};

export function IntegrationHub({ apiFetch, servers, onRefreshServers }: IntegrationHubProps) {
  const [activeTab, setActiveTab] = useState<'servers' | 'dns'>('servers');

  return (
    <div className="space-y-6">
      <PageHeader
        icon={PlugZap}
        title="接入中心"
        description="把服务器、DNS 厂商和后续 VPS 产商都统一收进接入中心，避免再次把接入逻辑塞回系统设置页。"
      />

      <SegmentedTabs
        value={activeTab}
        onChange={(value) => setActiveTab(value as 'servers' | 'dns')}
        items={[
          { value: 'servers', label: '服务器接入', icon: Server },
          { value: 'dns', label: 'DNS 厂商' },
        ]}
      />

      {activeTab === 'servers' && (
        <EnvironmentManager apiFetch={apiFetch} environments={servers as EnvironmentSummary[]} onRefresh={onRefreshServers} />
      )}

      {activeTab === 'dns' && <DnsConnectionManager apiFetch={apiFetch} />}
    </div>
  );
}
