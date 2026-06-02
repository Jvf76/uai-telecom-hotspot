import http from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { config } from './config.js';
import { isValidCpf, onlyDigits } from './utils/cpf.js';
import { findCustomerByCpf } from './services/ixc.js';
import { allowClient, cleanupExpiredBindings } from './services/mikrotik.js';
import { listLeads, recordLead } from './services/leads.js';

const publicDir = join(process.cwd(), 'public');
const instagramFlowTtlMs = 15 * 60 * 1000;
const instagramFlows = new Map();
const browserOpenTtlMs = 5 * 60 * 1000;
const recentBrowserOpenTtlMs = 30 * 1000;
const recentBrowserOpenKey = 'recent-browser-open';
const browserOpenRequests = new Map();
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendRedirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [key, ...value] = part.split('=');
        return [key, decodeURIComponent(value.join('='))];
      })
  );
}

function sign(value) {
  return crypto
    .createHmac('sha256', config.admin.sessionSecret)
    .update(value)
    .digest('base64url');
}

function createAdminSession() {
  const payload = Buffer.from(JSON.stringify({
    user: config.admin.user,
    expiresAt: Date.now() + 8 * 60 * 60 * 1000
  })).toString('base64url');

  return `${payload}.${sign(payload)}`;
}

function isAdmin(req) {
  const token = parseCookies(req).uai_admin;
  if (token) {
    const [payload, signature] = token.split('.');
    if (payload && signature && signature === sign(payload)) {
      try {
        const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (session.user === config.admin.user && session.expiresAt > Date.now()) {
          return true;
        }
      } catch {
        return false;
      }
    }
  }

  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const credentials = Buffer.from(header.slice(6), 'base64').toString('utf8');
  return credentials === `${config.admin.user}:${config.admin.password}`;
}

function requireAdmin(req, res, mode = 'page') {
  if (isAdmin(req)) return true;
  if (mode === 'json') {
    sendJson(res, 401, { error: 'Sessao expirada. Faça login novamente.' });
    return false;
  }
  sendRedirect(res, '/admin/login');
  return false;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function getClientContext(url, body = {}) {
  return {
    ip: body.ip || url.searchParams.get('ip') || url.searchParams.get('client_ip') || '',
    mac: body.mac || url.searchParams.get('mac') || url.searchParams.get('client_mac') || '',
    linkOrig: body.linkOrig || url.searchParams.get('link-orig') || url.searchParams.get('link_orig') || '',
    name: body.name || '',
    phone: body.phone || '',
    email: body.email || ''
  };
}

function normalizeMac(mac = '') {
  return String(mac).trim().toUpperCase();
}

function clientKey(context = {}) {
  const mac = normalizeMac(context.mac);
  if (mac) return `mac:${mac}`;
  if (context.ip) return `ip:${context.ip}`;
  return '';
}

function cleanupBrowserOpenRequests() {
  const now = Date.now();
  for (const [key, expiresAt] of browserOpenRequests) {
    if (expiresAt <= now) browserOpenRequests.delete(key);
  }
}

function markBrowserOpen(context) {
  cleanupBrowserOpenRequests();
  const key = clientKey(context);
  browserOpenRequests.set(recentBrowserOpenKey, Date.now() + recentBrowserOpenTtlMs);
  if (!key) return false;
  browserOpenRequests.set(key, Date.now() + browserOpenTtlMs);
  return true;
}

function shouldRedirectToBrowser(url) {
  cleanupBrowserOpenRequests();
  if (url.searchParams.get('browser') === '1') return false;

  const key = clientKey(getClientContext(url));
  return Boolean((key && browserOpenRequests.has(key)) || browserOpenRequests.has(recentBrowserOpenKey));
}

function createInstagramFlow(context, cpf) {
  cleanupInstagramFlows();

  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  instagramFlows.set(token, {
    token,
    cpf,
    context: {
      ...context,
      mac: normalizeMac(context.mac)
    },
    createdAt: now,
    openedAt: 0,
    expiresAt: now + instagramFlowTtlMs
  });

  return token;
}

function cleanupInstagramFlows() {
  const now = Date.now();
  for (const [token, flow] of instagramFlows) {
    if (flow.expiresAt <= now) instagramFlows.delete(token);
  }
}

function getInstagramFlow(token, context) {
  cleanupInstagramFlows();

  const flow = instagramFlows.get(String(token || ''));
  if (!flow) return null;

  const requestMac = normalizeMac(context.mac);
  const flowMac = normalizeMac(flow.context.mac);
  if (flowMac && requestMac && flowMac !== requestMac) return null;
  if (flow.context.ip && context.ip && flow.context.ip !== context.ip) return null;

  return flow;
}

function mergeFlowContext(flow, context) {
  flow.context = {
    ...flow.context,
    ...Object.fromEntries(
      Object.entries(context).filter(([, value]) => String(value || '').trim())
    ),
    mac: normalizeMac(context.mac || flow.context.mac)
  };
}

async function serveStatic(req, res, url) {
  const requested = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(publicDir, safePath);

  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': contentTypes[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'Arquivo não encontrado' });
  }
}

async function handleCheckCpf(req, res, url) {
  try {
    const body = await readJson(req);
    const cpf = onlyDigits(body.cpf);
    const context = getClientContext(url, body);

    if (!isValidCpf(cpf)) {
      return sendJson(res, 400, { error: 'CPF inválido.' });
    }

    const result = await findCustomerByCpf(cpf);
    if (result.active) {
      await allowClient({
        ip: context.ip,
        mac: context.mac,
        comment: `uai-hotspot cpf ${cpf} ativo`,
        ttl: config.access.activeCustomerTtl
      });
      await recordLead({
        ...context,
        cpf,
        status: 'released',
        releaseMethod: 'cpf_active',
        message: 'Cliente ativo',
        customerId: result.customer?.id,
        customerName: result.customer?.razao || result.customer?.nome
      });

      return sendJson(res, 200, {
        status: 'released',
        message: 'Cliente ativo. Internet liberada.',
        redirect: context.linkOrig || 'http://neverssl.com'
      });
    }

    await recordLead({
      ...context,
      cpf,
      status: 'instagram_required',
      releaseMethod: 'pending_instagram',
      message: result.found ? 'Cadastro localizado sem status ativo' : 'CPF nao localizado como cliente ativo',
      customerId: result.customer?.id,
      customerName: result.customer?.razao || result.customer?.nome
    });

    const instagramToken = createInstagramFlow(context, cpf);

    return sendJson(res, 200, {
      status: 'instagram_required',
      message: result.found
        ? `Cadastro localizado, mas não está ativo${result.status ? ` (${result.status})` : ''}.`
        : 'CPF não localizado como cliente ativo.',
      instagramUrl: config.instagram.profileUrl,
      instagramToken,
      confirmDelaySeconds: config.instagram.confirmDelaySeconds
    });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

async function handleAdminLeads(req, res) {
  if (!requireAdmin(req, res, 'json')) return;

  try {
    sendJson(res, 200, { leads: await listLeads() });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

async function handleAdminLogin(req, res) {
  try {
    const body = await readJson(req);
    if (body.user !== config.admin.user || body.password !== config.admin.password) {
      return sendJson(res, 401, { error: 'Usuario ou senha invalidos.' });
    }

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `uai_admin=${encodeURIComponent(createAdminSession())}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`
    });
    res.end(JSON.stringify({ ok: true }));
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

function handleAdminLogout(res) {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Set-Cookie': 'uai_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'
  });
  res.end(JSON.stringify({ ok: true }));
}

async function handleInstagramWindow(req, res, url) {
  await readJson(req).catch(() => ({}));
  sendJson(res, 410, {
    error: 'Janela temporária do Instagram desativada. Use o walled garden da MikroTik.'
  });
}

async function handleBrowserOpened(req, res, url) {
  try {
    const body = await readJson(req);
    const context = getClientContext(url, body);
    sendJson(res, 200, { ok: markBrowserOpen(context) });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

async function handleInstagramOpened(req, res, url) {
  try {
    const body = await readJson(req);
    const context = getClientContext(url, body);
    const flow = getInstagramFlow(body.instagramToken, context);

    if (!flow) {
      return sendJson(res, 400, {
        error: 'Refaça a consulta do CPF antes de abrir o Instagram.'
      });
    }

    flow.openedAt = Date.now();
    mergeFlowContext(flow, context);

    sendJson(res, 200, {
      status: 'instagram_opened',
      confirmDelaySeconds: config.instagram.confirmDelaySeconds
    });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

async function handleInstagramRelease(req, res, url) {
  try {
    const body = await readJson(req);
    const context = getClientContext(url, body);
    const flow = getInstagramFlow(body.instagramToken, context);

    if (!flow?.openedAt) {
      return sendJson(res, 400, {
        error: 'Abra o Instagram da UAI Telecom antes de confirmar.'
      });
    }

    const delayMs = config.instagram.confirmDelaySeconds * 1000;
    const elapsedMs = Date.now() - flow.openedAt;
    if (elapsedMs < delayMs) {
      const remainingSeconds = Math.ceil((delayMs - elapsedMs) / 1000);
      return sendJson(res, 429, {
        error: `Aguarde ${remainingSeconds} segundos antes de confirmar.`,
        remainingSeconds
      });
    }

    mergeFlowContext(flow, context);

    await allowClient({
      ip: flow.context.ip,
      mac: flow.context.mac,
      comment: 'uai-hotspot instagram declarado',
      ttl: config.access.activeCustomerTtl
    });
    await recordLead({
      ...flow.context,
      cpf: flow.cpf || body.cpf || '',
      status: 'released',
      releaseMethod: 'instagram',
      message: 'Liberado por confirmacao de Instagram'
    });
    instagramFlows.delete(flow.token);

    sendJson(res, 200, {
      status: 'released',
      message: 'Obrigado por seguir a UAI Telecom. Internet liberada.',
      redirect: flow.context.linkOrig || 'http://neverssl.com'
    });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/admin') {
    if (!requireAdmin(req, res)) return;
    req.url = '/admin.html';
    url.pathname = '/admin.html';
    return serveStatic(req, res, url);
  }

  if (req.method === 'GET' && url.pathname === '/admin/login') {
    if (isAdmin(req)) return sendRedirect(res, '/admin');
    req.url = '/admin-login.html';
    url.pathname = '/admin-login.html';
    return serveStatic(req, res, url);
  }

  if (req.method === 'GET' && url.pathname === '/browser') {
    req.url = '/index.html';
    url.pathname = '/index.html';
    return serveStatic(req, res, url);
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/leads') {
    return handleAdminLeads(req, res);
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/login') {
    return handleAdminLogin(req, res);
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/logout') {
    return handleAdminLogout(res);
  }

  if (req.method === 'POST' && url.pathname === '/api/check-cpf') {
    return handleCheckCpf(req, res, url);
  }

  if (req.method === 'POST' && url.pathname === '/api/instagram-window') {
    return handleInstagramWindow(req, res, url);
  }

  if (req.method === 'POST' && url.pathname === '/api/browser-opened') {
    return handleBrowserOpened(req, res, url);
  }

  if (req.method === 'POST' && url.pathname === '/api/instagram-opened') {
    return handleInstagramOpened(req, res, url);
  }

  if (req.method === 'POST' && url.pathname === '/api/instagram-release') {
    return handleInstagramRelease(req, res, url);
  }

  if (req.method === 'GET') {
    if ((url.pathname === '/' || url.pathname === '/index.html') && shouldRedirectToBrowser(url)) {
      return sendRedirect(res, `/browser${url.search}`);
    }

    return serveStatic(req, res, url);
  }

  sendJson(res, 405, { error: 'Método não permitido' });
});

server.listen(config.port, '0.0.0.0', () => {
  const localAddresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item?.family === 'IPv4' && !item.internal)
    .map((item) => `http://${item.address}:${config.port}`);

  console.log('UAI Telecom Hotspot rodando.');
  console.log(`Local: http://127.0.0.1:${config.port}`);
  for (const address of localAddresses) {
    console.log(`Rede:  ${address}`);
  }
});

cleanupExpiredBindings().catch((error) => {
  console.warn(`Falha ao limpar liberacoes expiradas: ${error.message}`);
});
setInterval(() => {
  cleanupExpiredBindings().catch((error) => {
    console.warn(`Falha ao limpar liberacoes expiradas: ${error.message}`);
  });
  cleanupInstagramFlows();
  cleanupBrowserOpenRequests();
}, 60 * 1000);
