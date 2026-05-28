import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const envFile = resolve(process.cwd(), '.env');

if (existsSync(envFile)) {
  const lines = readFileSync(envFile, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [key, ...valueParts] = trimmed.split('=');
    if (!process.env[key]) {
      process.env[key] = valueParts.join('=').trim();
    }
  }
}

export const config = {
  port: Number(process.env.PORT || 3000),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://10.10.10.2:3000',
  ixc: {
    baseUrl: process.env.IXC_BASE_URL || '',
    token: process.env.IXC_TOKEN || '',
    customerEndpoint: process.env.IXC_CUSTOMER_ENDPOINT || '/webservice/v1/cliente',
    activeStatuses: (process.env.IXC_ACTIVE_STATUSES || 'Ativo,A')
      .split(',')
      .map((status) => status.trim().toLowerCase())
      .filter(Boolean)
  },
  mikrotik: {
    baseUrl: process.env.MIKROTIK_BASE_URL || 'http://192.168.30.108/rest',
    user: process.env.MIKROTIK_USER || 'admin',
    password: process.env.MIKROTIK_PASSWORD || '',
    enabled: String(process.env.MIKROTIK_ENABLED || 'false').toLowerCase() === 'true'
  },
  instagram: {
    profileUrl: process.env.INSTAGRAM_PROFILE_URL || 'https://www.instagram.com/uaitelecom/'
  },
  admin: {
    user: process.env.ADMIN_USER || 'admin',
    password: process.env.ADMIN_PASSWORD || 'troque-esta-senha'
  }
};
