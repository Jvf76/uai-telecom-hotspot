import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { onlyDigits } from '../utils/cpf.js';

const dataDir = join(process.cwd(), 'data');
const leadsFile = join(dataDir, 'leads.jsonl');
const dbFile = join(dataDir, 'hotspot.sqlite');

let dbPromise;

function sanitize(value = '') {
  return String(value).trim().slice(0, 300);
}

function normalizeLead(input = {}) {
  return {
    id: sanitize(input.id) || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: sanitize(input.createdAt) || new Date().toISOString(),
    location: sanitize(input.location),
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
}

async function loadSqlite() {
  try {
    return await import('node:sqlite');
  } catch {
    return null;
  }
}

function insertLead(db, lead) {
  db.prepare(`
    INSERT OR IGNORE INTO leads (
      id, created_at, location, name, phone, email, cpf, ip, mac, status,
      release_method, message, customer_id, customer_name
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `).run(
    lead.id,
    lead.createdAt,
    lead.location,
    lead.name,
    lead.phone,
    lead.email,
    lead.cpf,
    lead.ip,
    lead.mac,
    lead.status,
    lead.releaseMethod,
    lead.message,
    lead.customerId,
    lead.customerName
  );
}

function ensureColumn(db, table, column, definition) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  if (!columns.has(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function migrateJsonl(db) {
  let text = '';
  try {
    text = await readFile(leadsFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  db.exec('BEGIN');
  try {
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        insertLead(db, normalizeLead(JSON.parse(line)));
      } catch {
        console.warn('Lead antigo ignorado durante migracao por estar invalido.');
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

async function initDb() {
  const sqlite = await loadSqlite();
  if (!sqlite?.DatabaseSync) return null;

  await mkdir(dataDir, { recursive: true });
  const db = new sqlite.DatabaseSync(dbFile);
  db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      location TEXT DEFAULT '',
      name TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      email TEXT DEFAULT '',
      cpf TEXT DEFAULT '',
      ip TEXT DEFAULT '',
      mac TEXT DEFAULT '',
      status TEXT DEFAULT '',
      release_method TEXT DEFAULT '',
      message TEXT DEFAULT '',
      customer_id TEXT DEFAULT '',
      customer_name TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at);
    CREATE INDEX IF NOT EXISTS idx_leads_location ON leads(location);
    CREATE INDEX IF NOT EXISTS idx_leads_cpf ON leads(cpf);
    CREATE INDEX IF NOT EXISTS idx_leads_mac ON leads(mac);
  `);

  ensureColumn(db, 'leads', 'location', "TEXT DEFAULT ''");
  await migrateJsonl(db);
  return db;
}

async function getDb() {
  dbPromise ??= initDb();
  return dbPromise;
}

function rowToLead(row = {}) {
  return {
    id: row.id,
    createdAt: row.created_at,
    location: row.location || '',
    name: row.name || '',
    phone: row.phone || '',
    email: row.email || '',
    cpf: row.cpf || '',
    ip: row.ip || '',
    mac: row.mac || '',
    status: row.status || '',
    releaseMethod: row.release_method || '',
    message: row.message || '',
    customerId: row.customer_id || '',
    customerName: row.customer_name || ''
  };
}

async function appendJsonlFallback(lead) {
  await mkdir(dirname(leadsFile), { recursive: true });
  await appendFile(leadsFile, `${JSON.stringify(lead)}\n`, 'utf8');
}

export async function recordLead(input = {}) {
  const lead = normalizeLead(input);
  const db = await getDb();

  if (db) {
    insertLead(db, lead);
    return lead;
  }

  await appendJsonlFallback(lead);
  return lead;
}

export async function listLeads() {
  const db = await getDb();

  if (db) {
    return db
      .prepare('SELECT * FROM leads ORDER BY datetime(created_at) DESC, created_at DESC')
      .all()
      .map(rowToLead);
  }

  try {
    const text = await readFile(leadsFile, 'utf8');
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => normalizeLead(JSON.parse(line)))
      .reverse();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
