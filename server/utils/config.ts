import path from "path";
import fs from "fs";
import dotenv from "dotenv";

export let CONFIG: any = {};

export function loadConfig() {
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const envConfig = dotenv.parse(fs.readFileSync(envPath));
    for (const k in envConfig) {
      process.env[k] = envConfig[k];
    }
  }
  
  CONFIG = {
    ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || '123456',
    JWT_SECRET: process.env.JWT_SECRET || 'your-secret-key-change-me',
    APP_MASTER_KEY: (process.env.APP_MASTER_KEY || '').trim(),
    NGINX_CONTAINER_NAME: process.env.NGINX_CONTAINER_NAME || 'nginx-gateway',
    CERT_AGENT_CONTAINER_NAME: process.env.CERT_AGENT_CONTAINER_NAME || 'cert-agent',
    VPS_PUBLIC_IP: process.env.VPS_PUBLIC_IP || '',
    CF_API_TOKEN: (process.env.CF_API_TOKEN || '').trim(),
    CF_ZONE_ID: (process.env.CF_ZONE_ID || '').trim(),
    CF_PROXIED: process.env.CF_PROXIED === 'true',
    CF_TTL: parseInt(process.env.CF_TTL || '1', 10),
    ALLOWED_DOMAINS: (process.env.ALLOWED_DOMAINS || '').split(',').map(s => s.trim()).filter(Boolean),
    PLATFORM_MANAGED_NETWORKS: (process.env.PLATFORM_MANAGED_NETWORKS || 'proxy_net').split(',').map(s => s.trim()).filter(Boolean),
    DATA_DIR: path.join(process.cwd(), 'data'),
    NGINX_CONF_DIR: path.join(process.cwd(), 'data', 'nginx', 'conf.d'),
  };

  if (!fs.existsSync(CONFIG.DATA_DIR)) fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG.NGINX_CONF_DIR)) fs.mkdirSync(CONFIG.NGINX_CONF_DIR, { recursive: true });
}

export function initConfig() {
  if (!fs.existsSync(path.join(process.cwd(), '.env'))) {
    fs.writeFileSync(path.join(process.cwd(), '.env'), '');
  }
  loadConfig();
}
