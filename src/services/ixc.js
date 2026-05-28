import { config } from '../config.js';
import { formatCpf, onlyDigits } from '../utils/cpf.js';

function buildUrl(path) {
  const cleanPath = String(path).replace(/^\/+/, '');
  return new URL(cleanPath, config.ixc.baseUrl.endsWith('/') ? config.ixc.baseUrl : `${config.ixc.baseUrl}/`);
}

function normalizeStatus(customer = {}) {
  return String(
    customer.ativo
      ?? customer.status
      ?? customer.situacao
      ?? customer.status_cliente
      ?? customer.status_internet
      ?? customer.cli_ativado
      ?? ''
  ).trim().toLowerCase();
}

function getStatusSnapshot(customer = {}) {
  return {
    ativo: customer.ativo ?? null,
    status: customer.status ?? null,
    situacao: customer.situacao ?? null,
    status_cliente: customer.status_cliente ?? null,
    status_internet: customer.status_internet ?? null,
    cli_ativado: customer.cli_ativado ?? null,
    bloqueado: customer.bloqueado ?? null,
    inadimplente: customer.inadimplente ?? null,
    tipo_pessoa: customer.tipo_pessoa ?? null
  };
}

function isActiveCustomer(customer) {
  const status = normalizeStatus(customer);
  if (['s', 'sim', '1', 'true', 'ativo', 'a'].includes(status) || config.ixc.activeStatuses.includes(status)) {
    return true;
  }

  const blocked = String(customer.bloqueado ?? customer.inadimplente ?? '').trim().toLowerCase();
  if (['n', 'nao', 'não', '0', 'false'].includes(blocked) && !status) {
    return true;
  }

  return false;
}

function buildAuthorizationToken(token) {
  const credential = token.includes(':') ? token : `${token}:`;
  return Buffer.from(credential).toString('base64');
}

function parseCustomers(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.registros)) return payload.registros;
  if (Array.isArray(payload?.data)) return payload.data;
  if (payload && typeof payload === 'object' && ('page' in payload || 'total' in payload)) return [];
  if (payload && typeof payload === 'object') return [payload];
  return [];
}

async function requestCustomer(query, oper = '=') {
  const url = buildUrl(config.ixc.customerEndpoint);
  const body = {
    qtype: 'cliente.cnpj_cpf',
    query,
    oper,
    page: '1',
    rp: '5',
    sortname: 'cliente.id',
    sortorder: 'desc'
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${buildAuthorizationToken(config.ixc.token)}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ixcsoft: 'listar'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`IXC respondeu ${response.status}: ${text.slice(0, 200)}`);
  }

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`IXC retornou resposta fora de JSON: ${text.slice(0, 120)}`);
  }
}

export async function findCustomerByCpf(cpf) {
  if (!config.ixc.baseUrl || !config.ixc.token) {
    throw new Error('IXC_BASE_URL e IXC_TOKEN precisam estar configurados no .env');
  }

  const cleanCpf = onlyDigits(cpf);
  const attempts = [
    [cleanCpf, '='],
    [formatCpf(cleanCpf), '='],
    [cleanCpf, 'L']
  ];

  let customers = [];
  for (const [query, oper] of attempts) {
    const payload = await requestCustomer(query, oper);
    customers = parseCustomers(payload);
    if (customers.length) break;
  }

  const customer = customers.find((item) => onlyDigits(item.cnpj_cpf ?? item.cpf ?? '') === cleanCpf) || customers[0];

  return {
    found: Boolean(customer),
    active: customer ? isActiveCustomer(customer) : false,
    status: customer ? normalizeStatus(customer) : '',
    statusSnapshot: customer ? getStatusSnapshot(customer) : {},
    customer: customer || null
  };
}
