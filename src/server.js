import http from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { config } from './config.js';
import { isValidCpf, onlyDigits } from './utils/cpf.js';
import { findCustomerByCpf } from './services/ixc.js';
import { allowClient, cleanupExpiredBindings } from './services/mikrotik.js';
import { deleteLeadGroup, listLeads, recordLead } from './services/leads.js';
import {
  deleteDevice,
  deleteLocation,
  getDevice,
  listDevices,
  listLocations,
  saveDevice,
  saveLocation
} from './services/equipment.js';
import { runDeviceCommand } from './services/ssh.js';

const publicDir = join(process.cwd(), 'public');
const instagramFlowTtlMs = 15 * 60 * 1000;
const instagramFlows = new Map();
const browserOpenTtlMs = 5 * 60 * 1000;
const recentBrowserOpenTtlMs = 30 * 1000;
const recentBrowserOpenKey = 'recent-browser-open';
const browserOpenRequests = new Map();
const adminLoginAttempts = new Map();
const adminLoginWindowMs = 15 * 60 * 1000;
const adminLoginBlockMs = 10 * 60 * 1000;
const maxAdminLoginAttempts = 5;
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

function secureEquals(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function adminLoginPath() {
  return `${config.admin.path}/login`;
}

function cookieSecurity(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto === 'https' || req.socket.encrypted ? '; Secure' : '';
}

function clientAddress(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    .split(',')[0]
    .trim() || 'unknown';
}

function getAdminLoginAttempt(req) {
  const key = clientAddress(req);
  const now = Date.now();
  const attempt = adminLoginAttempts.get(key);

  if (!attempt || attempt.resetAt <= now) {
    const fresh = { count: 0, resetAt: now + adminLoginWindowMs, blockedUntil: 0 };
    adminLoginAttempts.set(key, fresh);
    return { key, attempt: fresh };
  }

  return { key, attempt };
}

function registerAdminLoginFailure(req) {
  const { attempt } = getAdminLoginAttempt(req);
  attempt.count += 1;
  if (attempt.count >= maxAdminLoginAttempts) {
    attempt.blockedUntil = Date.now() + adminLoginBlockMs;
  }
}

function clearAdminLoginFailures(req) {
  adminLoginAttempts.delete(clientAddress(req));
}

function adminLoginBlocked(req) {
  const { attempt } = getAdminLoginAttempt(req);
  const remainingMs = attempt.blockedUntil - Date.now();
  if (remainingMs <= 0) return 0;
  return Math.ceil(remainingMs / 1000);
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

  if (!config.admin.basicAuthEnabled) return false;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const credentials = Buffer.from(header.slice(6), 'base64').toString('utf8');
  return secureEquals(credentials, `${config.admin.user}:${config.admin.password}`);
}

function requireAdmin(req, res, mode = 'page') {
  if (isAdmin(req)) return true;
  if (mode === 'json') {
    sendJson(res, 401, { error: 'Sessao expirada. Faça login novamente.' });
    return false;
  }
  sendRedirect(res, adminLoginPath());
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
    location: body.location || body.local || body.hotspot
      || url.searchParams.get('location')
      || url.searchParams.get('local')
      || url.searchParams.get('hotspot')
      || config.hotspot.location
      || '',
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

async function handleAdminLeadDelete(req, res, id) {
  if (!requireAdmin(req, res, 'json')) return;

  try {
    sendJson(res, 200, await deleteLeadGroup(id));
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

async function handleAdminLocations(req, res) {
  if (!requireAdmin(req, res, 'json')) return;

  try {
    if (req.method === 'GET') {
      return sendJson(res, 200, { locations: await listLocations() });
    }

    const body = await readJson(req);
    return sendJson(res, 200, { location: await saveLocation(body) });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

async function handleAdminLocationDelete(req, res, id) {
  if (!requireAdmin(req, res, 'json')) return;

  try {
    sendJson(res, 200, await deleteLocation(id));
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

async function handleAdminDevices(req, res) {
  if (!requireAdmin(req, res, 'json')) return;

  try {
    if (req.method === 'GET') {
      return sendJson(res, 200, { devices: await listDevices() });
    }

    const body = await readJson(req);
    return sendJson(res, 200, { device: await saveDevice(body) });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

async function handleAdminGeocode(req, res, url) {
  if (!requireAdmin(req, res, 'json')) return;

  try {
    const address = String(url.searchParams.get('address') || '').trim();
    if (!address) {
      return sendJson(res, 400, { error: 'Informe o endereco.' });
    }

    const queries = [address];
    if (!/brasil|brazil/i.test(address)) queries.push(`${address}, Brasil`);

    let first = null;
    for (const query of queries) {
      const geocodeUrl = new URL('https://nominatim.openstreetmap.org/search');
      geocodeUrl.searchParams.set('format', 'json');
      geocodeUrl.searchParams.set('limit', '1');
      geocodeUrl.searchParams.set('addressdetails', '1');
      geocodeUrl.searchParams.set('countrycodes', 'br');
      geocodeUrl.searchParams.set('q', query);

      const response = await fetch(geocodeUrl, {
        headers: {
          'User-Agent': 'uai-telecom-hotspot/1.0'
        }
      });

      if (!response.ok) {
        return sendJson(res, 502, { error: 'Falha ao consultar o mapa.' });
      }

      const results = await response.json();
      first = results[0];
      if (first) break;
    }

    if (!first) {
      return sendJson(res, 404, { error: 'Endereco nao encontrado.' });
    }

    sendJson(res, 200, {
      location: {
        latitude: Number.parseFloat(first.lat).toFixed(6),
        longitude: Number.parseFloat(first.lon).toFixed(6),
        displayName: first.display_name || address
      }
    });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

async function handleAdminDeviceDelete(req, res, id) {
  if (!requireAdmin(req, res, 'json')) return;

  try {
    sendJson(res, 200, await deleteDevice(id));
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

async function handleAdminDeviceReboot(req, res, id) {
  if (!requireAdmin(req, res, 'json')) return;

  try {
    const device = await getDevice(id);
    const result = await runDeviceCommand(device, device.rebootCommand || '/system reboot', 15000);
    sendJson(res, 200, {
      ok: true,
      message: 'Comando de reboot enviado.',
      result
    });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

async function handleAdminDeviceConsole(req, res, id) {
  if (!requireAdmin(req, res, 'json')) return;

  try {
    const body = await readJson(req);
    const device = await getDevice(id);
    const result = await runDeviceCommand(device, body.command, 25000);
    sendJson(res, 200, { ok: true, result });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

async function handleAdminLogin(req, res) {
  try {
    const blockedSeconds = adminLoginBlocked(req);
    if (blockedSeconds) {
      return sendJson(res, 429, {
        error: `Muitas tentativas de login. Tente novamente em ${blockedSeconds} segundos.`
      });
    }

    const body = await readJson(req);
    if (!secureEquals(body.user, config.admin.user) || !secureEquals(body.password, config.admin.password)) {
      registerAdminLoginFailure(req);
      return sendJson(res, 401, { error: 'Usuario ou senha invalidos.' });
    }

    clearAdminLoginFailures(req);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `uai_admin=${encodeURIComponent(createAdminSession())}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${cookieSecurity(req)}`
    });
    res.end(JSON.stringify({ ok: true }));
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

function handleAdminLogout(req, res) {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Set-Cookie': `uai_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${cookieSecurity(req)}`
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
  const adminPath = config.admin.path;
  const adminLogin = adminLoginPath();

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === adminPath) {
    if (!requireAdmin(req, res)) return;
    req.url = '/admin.html';
    url.pathname = '/admin.html';
    return serveStatic(req, res, url);
  }

  if (req.method === 'GET' && url.pathname === adminLogin) {
    if (isAdmin(req)) return sendRedirect(res, adminPath);
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

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/admin/leads/')) {
    return handleAdminLeadDelete(req, res, decodeURIComponent(url.pathname.split('/').pop()));
  }

  if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/admin/locations') {
    return handleAdminLocations(req, res);
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/admin/locations/')) {
    return handleAdminLocationDelete(req, res, decodeURIComponent(url.pathname.split('/').pop()));
  }

  if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/admin/devices') {
    return handleAdminDevices(req, res);
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/geocode') {
    return handleAdminGeocode(req, res, url);
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/admin/devices/')) {
    return handleAdminDeviceDelete(req, res, decodeURIComponent(url.pathname.split('/').pop()));
  }

  const rebootMatch = url.pathname.match(/^\/api\/admin\/devices\/([^/]+)\/reboot$/);
  if (req.method === 'POST' && rebootMatch) {
    return handleAdminDeviceReboot(req, res, decodeURIComponent(rebootMatch[1]));
  }

  const consoleMatch = url.pathname.match(/^\/api\/admin\/devices\/([^/]+)\/console$/);
  if (req.method === 'POST' && consoleMatch) {
    return handleAdminDeviceConsole(req, res, decodeURIComponent(consoleMatch[1]));
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/login') {
    return handleAdminLogin(req, res);
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/logout') {
    return handleAdminLogout(req, res);
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
    if (url.pathname === '/admin.html' || url.pathname === '/admin-login.html') {
      return sendJson(res, 404, { error: 'Arquivo não encontrado' });
    }

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
