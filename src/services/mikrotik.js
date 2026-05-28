import { config } from '../config.js';

function authHeader() {
  return `Basic ${Buffer.from(`${config.mikrotik.user}:${config.mikrotik.password}`).toString('base64')}`;
}

function restUrl(path) {
  const cleanPath = String(path).replace(/^\/+/, '');
  return new URL(cleanPath, config.mikrotik.baseUrl.endsWith('/') ? config.mikrotik.baseUrl : `${config.mikrotik.baseUrl}/`);
}

async function mikrotikRequest(path, options = {}) {
  const response = await fetch(restUrl(path), {
    ...options,
    headers: {
      Authorization: authHeader(),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`MikroTik respondeu ${response.status}: ${text.slice(0, 200)}`);
  }

  return response.json();
}

export async function allowClient({ ip, mac, comment }) {
  if (!ip && !mac) {
    return {
      skipped: true,
      message: 'IP/MAC não informado; liberação na MikroTik ignorada para teste direto.'
    };
  }

  if (!config.mikrotik.enabled) {
    return {
      skipped: true,
      message: 'MIKROTIK_ENABLED=false; liberação simulada.'
    };
  }

  const payload = {
    type: 'bypassed',
    comment: comment || 'uai-hotspot'
  };

  if (ip) payload.address = ip;
  if (mac) payload['mac-address'] = mac;
  payload.server = 'hotspot-uai';

  return mikrotikRequest('/ip/hotspot/ip-binding', {
    method: 'PUT',
    body: JSON.stringify(payload)
  });
}
