import http from 'node:http';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { config } from './config.js';
import { isValidCpf, onlyDigits } from './utils/cpf.js';
import { findCustomerByCpf } from './services/ixc.js';
import { allowClient } from './services/mikrotik.js';
import { listLeads, recordLead } from './services/leads.js';

const publicDir = join(process.cwd(), 'public');
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

function isAdmin(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const credentials = Buffer.from(header.slice(6), 'base64').toString('utf8');
  return credentials === `${config.admin.user}:${config.admin.password}`;
}

function requireAdmin(req, res) {
  if (isAdmin(req)) return true;
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="UAI Hotspot"',
    'Content-Type': 'text/plain; charset=utf-8'
  });
  res.end('Autenticacao obrigatoria');
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
        comment: `uai-hotspot cpf ${cpf} ativo`
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

    return sendJson(res, 200, {
      status: 'instagram_required',
      message: result.found
        ? `Cadastro localizado, mas não está ativo${result.status ? ` (${result.status})` : ''}.`
        : 'CPF não localizado como cliente ativo.',
      instagramUrl: config.instagram.profileUrl
    });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

async function handleAdminLeads(req, res) {
  if (!requireAdmin(req, res)) return;

  try {
    sendJson(res, 200, { leads: await listLeads() });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

async function handleInstagramRelease(req, res, url) {
  try {
    const body = await readJson(req);
    const context = getClientContext(url, body);

    await allowClient({
      ip: context.ip,
      mac: context.mac,
      comment: 'uai-hotspot instagram declarado'
    });
    await recordLead({
      ...context,
      cpf: body.cpf || '',
      status: 'released',
      releaseMethod: 'instagram',
      message: 'Liberado por confirmacao de Instagram'
    });

    sendJson(res, 200, {
      status: 'released',
      message: 'Obrigado por seguir a UAI Telecom. Internet liberada.',
      redirect: context.linkOrig || 'http://neverssl.com'
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

  if (req.method === 'GET' && url.pathname === '/api/admin/leads') {
    return handleAdminLeads(req, res);
  }

  if (req.method === 'POST' && url.pathname === '/api/check-cpf') {
    return handleCheckCpf(req, res, url);
  }

  if (req.method === 'POST' && url.pathname === '/api/instagram-release') {
    return handleInstagramRelease(req, res, url);
  }

  if (req.method === 'GET') {
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
