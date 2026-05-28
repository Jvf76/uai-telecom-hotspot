import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { onlyDigits } from '../utils/cpf.js';

const leadsFile = join(process.cwd(), 'data', 'leads.jsonl');

function sanitize(value = '') {
  return String(value).trim().slice(0, 300);
}

export async function recordLead(input = {}) {
  const lead = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
    name: sanitize(input.name),
    phone: sanitize(input.phone),
    email: sanitize(input.email),
    cpf: onlyDigits(input.cpf),
    ip: sanitize(input.ip),
    mac: sanitize(input.mac).toUpperCase(),
    status: sanitize(input.status),
    releaseMethod: sanitize(input.releaseMethod),
    message: sanitize(input.message),
    customerId: sanitize(input.customerId),
    customerName: sanitize(input.customerName)
  };

  await mkdir(dirname(leadsFile), { recursive: true });
  await appendFile(leadsFile, `${JSON.stringify(lead)}\n`, 'utf8');
  return lead;
}

export async function listLeads() {
  try {
    const text = await readFile(leadsFile, 'utf8');
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .reverse();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
