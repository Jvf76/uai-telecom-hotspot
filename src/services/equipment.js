import crypto from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const dataDir = join(process.cwd(), 'data');
const dbFile = join(dataDir, 'hotspot.sqlite');
let dbPromise;

function sanitize(value = '', limit = 300) {
  return String(value || '').trim().slice(0, limit);
}

function normalizeNumber(value) {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : null;
}

function normalizePort(value) {
  const port = Number.parseInt(value || '22', 10);
  return Number.isFinite(port) && port > 0 && port <= 65535 ? port : 22;
}

function normalizeConnectionType(value) {
  return String(value || '').trim().toLowerCase() === 'routeros_api' ? 'routeros_api' : 'ssh';
}

function ensureColumn(db, table, column, definition) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  if (!columns.has(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function loadSqlite() {
  try {
    return await import('node:sqlite');
  } catch {
    return null;
  }
}

function nowIso() {
  return new Date().toISOString();
}

async function initDb() {
  const sqlite = await loadSqlite();
  if (!sqlite?.DatabaseSync) {
    throw new Error('SQLite nao esta disponivel nesta versao do Node.');
  }

  await mkdir(dataDir, { recursive: true });
  const db = new sqlite.DatabaseSync(dbFile);
  db.exec(`
    CREATE TABLE IF NOT EXISTS hotspot_locations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT DEFAULT '',
      latitude REAL,
      longitude REAL,
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mikrotik_devices (
      id TEXT PRIMARY KEY,
      location_id TEXT DEFAULT '',
      name TEXT NOT NULL,
      connection_type TEXT DEFAULT 'ssh',
      host TEXT NOT NULL,
      ssh_port INTEGER DEFAULT 22,
      ssh_user TEXT NOT NULL,
      ssh_password TEXT DEFAULT '',
      ssh_private_key TEXT DEFAULT '',
      reboot_command TEXT DEFAULT '/system reboot',
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hotspot_locations_name ON hotspot_locations(name);
    CREATE INDEX IF NOT EXISTS idx_mikrotik_devices_location ON mikrotik_devices(location_id);
    CREATE INDEX IF NOT EXISTS idx_mikrotik_devices_host ON mikrotik_devices(host);
  `);
  ensureColumn(db, 'mikrotik_devices', 'connection_type', "TEXT DEFAULT 'ssh'");
  return db;
}

async function getDb() {
  dbPromise ??= initDb();
  return dbPromise;
}

function locationFromRow(row = {}) {
  return {
    id: row.id,
    name: row.name || '',
    address: row.address || '',
    latitude: row.latitude ?? null,
    longitude: row.longitude ?? null,
    notes: row.notes || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function deviceFromRow(row = {}) {
  return {
    id: row.id,
    locationId: row.location_id || '',
    locationName: row.location_name || '',
    name: row.name || '',
    connectionType: row.connection_type || 'ssh',
    host: row.host || '',
    sshPort: row.ssh_port || 22,
    sshUser: row.ssh_user || '',
    hasPassword: Boolean(row.ssh_password),
    hasPrivateKey: Boolean(row.ssh_private_key),
    rebootCommand: row.reboot_command || '/system reboot',
    notes: row.notes || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function deviceSecretFromRow(row = {}) {
  return {
    ...deviceFromRow(row),
    sshPassword: row.ssh_password || '',
    sshPrivateKey: row.ssh_private_key || ''
  };
}

export async function listLocations() {
  const db = await getDb();
  return db
    .prepare('SELECT * FROM hotspot_locations ORDER BY name COLLATE NOCASE ASC')
    .all()
    .map(locationFromRow);
}

export async function saveLocation(input = {}) {
  const db = await getDb();
  const id = sanitize(input.id, 80) || crypto.randomUUID();
  const existing = db.prepare('SELECT id, created_at FROM hotspot_locations WHERE id = ?').get(id);
  const createdAt = existing?.created_at || nowIso();
  const updatedAt = nowIso();
  const location = {
    id,
    name: sanitize(input.name, 120),
    address: sanitize(input.address, 300),
    latitude: normalizeNumber(input.latitude),
    longitude: normalizeNumber(input.longitude),
    notes: sanitize(input.notes, 500),
    createdAt,
    updatedAt
  };

  if (!location.name) throw new Error('Informe o nome do local.');

  db.prepare(`
    INSERT INTO hotspot_locations (id, name, address, latitude, longitude, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      address = excluded.address,
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      notes = excluded.notes,
      updated_at = excluded.updated_at
  `).run(
    location.id,
    location.name,
    location.address,
    location.latitude,
    location.longitude,
    location.notes,
    location.createdAt,
    location.updatedAt
  );

  return location;
}

export async function deleteLocation(id) {
  const db = await getDb();
  const locationId = sanitize(id, 80);
  if (!locationId) throw new Error('Local invalido.');
  db.prepare('UPDATE mikrotik_devices SET location_id = ? WHERE location_id = ?').run('', locationId);
  db.prepare('DELETE FROM hotspot_locations WHERE id = ?').run(locationId);
  return { ok: true };
}

export async function listDevices() {
  const db = await getDb();
  return db
    .prepare(`
      SELECT d.*, l.name AS location_name
      FROM mikrotik_devices d
      LEFT JOIN hotspot_locations l ON l.id = d.location_id
      ORDER BY d.name COLLATE NOCASE ASC
    `)
    .all()
    .map(deviceFromRow);
}

export async function getDevice(id) {
  const db = await getDb();
  const deviceId = sanitize(id, 80);
  const row = db.prepare(`
    SELECT d.*, l.name AS location_name
    FROM mikrotik_devices d
    LEFT JOIN hotspot_locations l ON l.id = d.location_id
    WHERE d.id = ?
  `).get(deviceId);
  if (!row) throw new Error('Equipamento nao encontrado.');
  return deviceSecretFromRow(row);
}

export async function saveDevice(input = {}) {
  const db = await getDb();
  const id = sanitize(input.id, 80) || crypto.randomUUID();
  const existing = db.prepare('SELECT * FROM mikrotik_devices WHERE id = ?').get(id);
  const createdAt = existing?.created_at || nowIso();
  const updatedAt = nowIso();
  const password = sanitize(input.sshPassword, 500) || existing?.ssh_password || '';
  const privateKey = sanitize(input.sshPrivateKey, 5000) || existing?.ssh_private_key || '';
  const device = {
    id,
    locationId: sanitize(input.locationId, 80),
    name: sanitize(input.name, 120),
    connectionType: normalizeConnectionType(input.connectionType),
    host: sanitize(input.host, 180),
    sshPort: normalizePort(input.sshPort),
    sshUser: sanitize(input.sshUser, 120),
    sshPassword: password,
    sshPrivateKey: privateKey,
    rebootCommand: sanitize(input.rebootCommand, 300) || '/system reboot',
    notes: sanitize(input.notes, 500),
    createdAt,
    updatedAt
  };

  if (!device.name) throw new Error('Informe o nome do equipamento.');
  if (!device.host) throw new Error('Informe o IP ou host do equipamento.');
  if (!device.sshUser) throw new Error('Informe o usuario.');
  if (!device.sshPassword && !device.sshPrivateKey) {
    throw new Error('Informe senha ou chave privada.');
  }

  db.prepare(`
    INSERT INTO mikrotik_devices (
      id, location_id, name, connection_type, host, ssh_port, ssh_user, ssh_password,
      ssh_private_key, reboot_command, notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      location_id = excluded.location_id,
      name = excluded.name,
      connection_type = excluded.connection_type,
      host = excluded.host,
      ssh_port = excluded.ssh_port,
      ssh_user = excluded.ssh_user,
      ssh_password = excluded.ssh_password,
      ssh_private_key = excluded.ssh_private_key,
      reboot_command = excluded.reboot_command,
      notes = excluded.notes,
      updated_at = excluded.updated_at
  `).run(
    device.id,
    device.locationId,
    device.name,
    device.connectionType,
    device.host,
    device.sshPort,
    device.sshUser,
    device.sshPassword,
    device.sshPrivateKey,
    device.rebootCommand,
    device.notes,
    device.createdAt,
    device.updatedAt
  );

  return (await listDevices()).find((item) => item.id === device.id) || deviceFromRow({
    id: device.id,
    location_id: device.locationId,
    name: device.name,
    connection_type: device.connectionType,
    host: device.host,
    ssh_port: device.sshPort,
    ssh_user: device.sshUser,
    ssh_password: device.sshPassword,
    ssh_private_key: device.sshPrivateKey,
    reboot_command: device.rebootCommand,
    notes: device.notes,
    created_at: device.createdAt,
    updated_at: device.updatedAt
  });
}

export async function deleteDevice(id) {
  const db = await getDb();
  const deviceId = sanitize(id, 80);
  if (!deviceId) throw new Error('Equipamento invalido.');
  db.prepare('DELETE FROM mikrotik_devices WHERE id = ?').run(deviceId);
  return { ok: true };
}
