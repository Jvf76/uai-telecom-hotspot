import { config } from '../config.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const bindingsFile = join(process.cwd(), 'data', 'access-bindings.json');

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

function durationToMs(value = '') {
  const match = String(value).trim().match(/^(\d+)\s*(m|h|d)?$/i);
  if (!match) return 0;
  const amount = Number(match[1]);
  const unit = (match[2] || 'm').toLowerCase();
  if (unit === 'd') return amount * 24 * 60 * 60 * 1000;
  if (unit === 'h') return amount * 60 * 60 * 1000;
  return amount * 60 * 1000;
}

async function readTrackedBindings() {
  try {
    return JSON.parse(await readFile(bindingsFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeTrackedBindings(bindings) {
  await mkdir(dirname(bindingsFile), { recursive: true });
  await writeFile(bindingsFile, JSON.stringify(bindings, null, 2), 'utf8');
}

async function trackBinding(binding) {
  if (!binding.id || !binding.expiresAt) return;
  const bindings = await readTrackedBindings();
  const filtered = bindings.filter((item) => item.id !== binding.id);
  filtered.push(binding);
  await writeTrackedBindings(filtered);
}

async function removeBinding(id) {
  await mikrotikRequest('/ip/hotspot/ip-binding/remove', {
    method: 'POST',
    body: JSON.stringify({ '.id': id })
  });
}

async function listBindings() {
  return mikrotikRequest('/ip/hotspot/ip-binding');
}

function shouldRemoveOldInstagramBinding(binding, now) {
  const comment = String(binding.comment || '');
  if (comment.includes('uai-hotspot janela instagram')) return true;
  if (!comment.includes('uai-hotspot')) return false;
  if (!comment.includes('expira ')) return true;

  const match = comment.match(/expira\s+([^\s|]+)/);
  if (!match) return false;

  const expiresAt = new Date(match[1]).getTime();
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

async function cleanupRouterBindings(activeTrackedIds, now) {
  const bindings = await listBindings();
  let removed = 0;

  for (const binding of bindings) {
    const id = binding['.id'];
    if (!id || activeTrackedIds.has(id)) continue;
    if (!shouldRemoveOldInstagramBinding(binding, now)) continue;

    try {
      await removeBinding(id);
      removed += 1;
    } catch {
      removed += 1;
    }
  }

  return removed;
}

export async function cleanupExpiredBindings() {
  if (!config.mikrotik.enabled) return { removed: 0 };

  const now = Date.now();
  const bindings = await readTrackedBindings();
  const active = [];
  let removed = 0;

  for (const binding of bindings) {
    if (new Date(binding.expiresAt).getTime() > now) {
      active.push(binding);
      continue;
    }

    try {
      await removeBinding(binding.id);
      removed += 1;
    } catch {
      removed += 1;
    }
  }

  if (removed) await writeTrackedBindings(active);
  const routerRemoved = await cleanupRouterBindings(new Set(active.map((binding) => binding.id)), now);
  return { removed: removed + routerRemoved };
}

export async function allowClient({ ip, mac, comment, ttl }) {
  if (!ip && !mac) {
    if (config.mikrotik.enabled) {
      throw new Error('IP/MAC do aparelho não informado; não foi possível liberar na MikroTik.');
    }

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

  await cleanupExpiredBindings().catch(() => {});

  const ttlMs = durationToMs(ttl);
  const expiresAt = ttlMs ? new Date(Date.now() + ttlMs).toISOString() : '';
  const payload = {
    type: 'bypassed',
    comment: [comment || 'uai-hotspot', expiresAt ? `expira ${expiresAt}` : ''].filter(Boolean).join(' | ')
  };

  if (ip) payload.address = ip;
  if (mac) payload['mac-address'] = mac;
  payload.server = 'hotspot-uai';

  const result = await mikrotikRequest('/ip/hotspot/ip-binding', {
    method: 'PUT',
    body: JSON.stringify(payload)
  });

  await trackBinding({
    id: result['.id'],
    ip: ip || '',
    mac: mac || '',
    expiresAt,
    comment: payload.comment
  });

  return result;
}
