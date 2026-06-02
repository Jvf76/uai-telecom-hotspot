import { config } from '../config.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import net from 'node:net';

const bindingsFile = join(process.cwd(), 'data', 'access-bindings.json');

function authHeader() {
  return `Basic ${Buffer.from(`${config.mikrotik.user}:${config.mikrotik.password}`).toString('base64')}`;
}

function restUrl(path) {
  const cleanPath = String(path).replace(/^\/+/, '');
  return new URL(cleanPath, config.mikrotik.baseUrl.endsWith('/') ? config.mikrotik.baseUrl : `${config.mikrotik.baseUrl}/`);
}

function usesRouterOsApi() {
  return String(config.mikrotik.baseUrl || '').startsWith('api://');
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

function encodeApiLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  if (length < 0x4000) return Buffer.from([(length >> 8) | 0x80, length & 0xff]);
  if (length < 0x200000) return Buffer.from([(length >> 16) | 0xc0, (length >> 8) & 0xff, length & 0xff]);
  if (length < 0x10000000) {
    return Buffer.from([
      (length >> 24) | 0xe0,
      (length >> 16) & 0xff,
      (length >> 8) & 0xff,
      length & 0xff
    ]);
  }
  return Buffer.from([0xf0, (length >> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]);
}

function decodeApiLength(buffer, offset) {
  const first = buffer[offset];
  if (first < 0x80) return { length: first, offset: offset + 1 };
  if ((first & 0xc0) === 0x80) return { length: ((first & ~0xc0) << 8) + buffer[offset + 1], offset: offset + 2 };
  if ((first & 0xe0) === 0xc0) {
    return { length: ((first & ~0xe0) << 16) + (buffer[offset + 1] << 8) + buffer[offset + 2], offset: offset + 3 };
  }
  if ((first & 0xf0) === 0xe0) {
    return {
      length: ((first & ~0xf0) << 24) + (buffer[offset + 1] << 16) + (buffer[offset + 2] << 8) + buffer[offset + 3],
      offset: offset + 4
    };
  }
  return {
    length: (buffer[offset + 1] << 24) + (buffer[offset + 2] << 16) + (buffer[offset + 3] << 8) + buffer[offset + 4],
    offset: offset + 5
  };
}

function encodeApiWord(value) {
  const data = Buffer.from(value, 'utf8');
  return Buffer.concat([encodeApiLength(data.length), data]);
}

function encodeApiSentence(words) {
  return Buffer.concat([...words.map(encodeApiWord), Buffer.from([0])]);
}

function parseApiWords(words) {
  const result = {};
  for (const word of words.slice(1)) {
    const match = word.match(/^=([^=]+)=(.*)$/);
    if (match) result[match[1]] = match[2];
  }
  return result;
}

class ApiParser {
  buffer = Buffer.alloc(0);
  current = [];
  sentences = [];

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let offset = 0;

    while (offset < this.buffer.length) {
      const start = offset;
      const decoded = decodeApiLength(this.buffer, offset);
      if (decoded.offset > this.buffer.length || decoded.offset + decoded.length > this.buffer.length) {
        offset = start;
        break;
      }

      offset = decoded.offset;
      if (decoded.length === 0) {
        this.sentences.push(this.current);
        this.current = [];
        continue;
      }

      this.current.push(this.buffer.subarray(offset, offset + decoded.length).toString('utf8'));
      offset += decoded.length;
    }

    this.buffer = this.buffer.subarray(offset);
  }
}

async function routerOsApiRequest(words) {
  const url = new URL(config.mikrotik.baseUrl);
  const socket = net.createConnection({
    host: url.hostname,
    port: Number(url.port || 8728),
    timeout: 8000
  });
  const parser = new ApiParser();
  socket.on('data', (chunk) => parser.push(chunk));

  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
      socket.once('timeout', () => reject(new Error('Timeout conectando na API MikroTik')));
    });

    socket.write(encodeApiSentence(['/login', `=name=${config.mikrotik.user}`, `=password=${config.mikrotik.password}`]));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    socket.write(encodeApiSentence(words));

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const commandSentences = parser.sentences.slice(1);
      if (commandSentences.some((sentence) => ['!done', '!empty', '!trap', '!fatal'].includes(sentence[0]))) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const loginSentence = parser.sentences.shift();
    if (!loginSentence || loginSentence[0] !== '!done') {
      throw new Error(`Falha ao autenticar na API MikroTik: ${(loginSentence || []).join(' ')}`);
    }

    const records = [];
    let done = {};
    for (const sentence of parser.sentences) {
      if (process.env.MIKROTIK_DEBUG_API === 'true') console.error('api sentence', sentence);
      const type = sentence[0];
      if (type === '!re') records.push(parseApiWords(sentence));
      if (type === '!done') {
        done = parseApiWords(sentence);
        return { records, done };
      }
      if (type === '!empty') return { records, done };
      if (type === '!trap' || type === '!fatal') {
        const details = parseApiWords(sentence);
        throw new Error(details.message || sentence.join(' '));
      }
    }

    throw new Error('Timeout aguardando resposta da API MikroTik');
  } finally {
    socket.end();
  }
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
  if (usesRouterOsApi()) {
    await routerOsApiRequest(['/ip/hotspot/ip-binding/remove', `=.id=${id}`]);
    return;
  }

  await mikrotikRequest('/ip/hotspot/ip-binding/remove', {
    method: 'POST',
    body: JSON.stringify({ '.id': id })
  });
}

async function listBindings() {
  if (usesRouterOsApi()) {
    const { records } = await routerOsApiRequest(['/ip/hotspot/ip-binding/print']);
    return records.map((record) => ({
      ...record,
      '.id': record['.id']
    }));
  }

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

  let result;
  if (usesRouterOsApi()) {
    const words = [
      '/ip/hotspot/ip-binding/add',
      ...Object.entries(payload).map(([key, value]) => `=${key}=${value}`)
    ];
    const { done } = await routerOsApiRequest(words);
    result = { '.id': done.ret || '' };

    if (!result['.id']) {
      const bindings = await listBindings();
      const match = bindings.find((binding) => binding.comment === payload.comment);
      if (match) result = match;
    }
  } else {
    result = await mikrotikRequest('/ip/hotspot/ip-binding', {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
  }

  await trackBinding({
    id: result['.id'],
    ip: ip || '',
    mac: mac || '',
    expiresAt,
    comment: payload.comment
  });

  return result;
}
