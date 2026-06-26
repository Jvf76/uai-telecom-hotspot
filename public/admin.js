const leadsBody = document.querySelector('#leadsBody');
const locationsBody = document.querySelector('#locationsBody');
const devicesBody = document.querySelector('#devicesBody');
const searchInput = document.querySelector('#search');
const locationFilter = document.querySelector('#locationFilter');
const refreshButton = document.querySelector('#refresh');
const exportButton = document.querySelector('#exportCsv');
const logoutButton = document.querySelector('#logout');
const totalCount = document.querySelector('#totalCount');
const releasedCount = document.querySelector('#releasedCount');
const pendingCount = document.querySelector('#pendingCount');
const locationCount = document.querySelector('#locationCount');
const locationForm = document.querySelector('#locationForm');
const deviceForm = document.querySelector('#deviceForm');
const clearLocationButton = document.querySelector('#clearLocation');
const clearDeviceButton = document.querySelector('#clearDevice');
const deviceLocation = document.querySelector('#deviceLocation');
const consoleDevice = document.querySelector('#consoleDevice');
const consoleCommand = document.querySelector('#consoleCommand');
const consoleOutput = document.querySelector('#consoleOutput');
const runConsoleButton = document.querySelector('#runConsole');
const locationMap = document.querySelector('#locationMap');
const openMap = document.querySelector('#openMap');
const lookupLocationButton = document.querySelector('#lookupLocation');
const consoleCard = document.querySelector('#consoleCard');
const consoleHeader = document.querySelector('#consoleHeader');
const closeConsoleButton = document.querySelector('#closeConsole');
const selectedConsoleDeviceName = document.querySelector('#selectedConsoleDeviceName');
const locationDevicesModal = document.querySelector('#locationDevicesModal');
const locationDevicesTitle = document.querySelector('#locationDevicesTitle');
const locationDevicesList = document.querySelector('#locationDevicesList');
const linkDeviceSelect = document.querySelector('#linkDeviceSelect');
const linkDeviceToLocationButton = document.querySelector('#linkDeviceToLocation');
const newDeviceForLocationButton = document.querySelector('#newDeviceForLocation');
const closeLocationDevicesButton = document.querySelector('#closeLocationDevices');
const adminPath = window.location.pathname.replace(/\/$/, '') || '/admin';
const adminLoginPath = `${adminPath}/login`;

let leads = [];
let locations = [];
let devices = [];
let consoleLog = 'Aguardando comando...';
let locationLookupTimer;
let selectedLocationForDevices = null;

function field(id) {
  return document.querySelector(`#${id}`);
}

function leadKey(lead) {
  if (lead.cpf) return `cpf:${lead.cpf}`;
  if (lead.mac) return `mac:${lead.mac}`;
  if (lead.ip) return `ip:${lead.ip}`;
  return `id:${lead.id}`;
}

function finalLeads() {
  const grouped = new Map();

  for (const lead of leads) {
    const key = leadKey(lead);
    if (!grouped.has(key)) grouped.set(key, lead);
  }

  return [...grouped.values()];
}

function leadLocation(lead) {
  return lead.location || 'Sem local';
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  if (response.status === 401) {
    window.location.href = adminLoginPath;
    return null;
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Falha na requisicao.');
  return payload;
}

function syncLocationFilter() {
  const selected = locationFilter.value;
  const locationNames = [...new Set([
    ...finalLeads().map(leadLocation),
    ...locations.map((location) => location.name)
  ])].sort((a, b) => a.localeCompare(b, 'pt-BR'));

  locationFilter.replaceChildren();

  const allOption = document.createElement('option');
  allOption.value = '';
  allOption.textContent = 'Todos os locais';
  locationFilter.append(allOption);

  for (const location of locationNames) {
    const option = document.createElement('option');
    option.value = location;
    option.textContent = location;
    locationFilter.append(option);
  }

  locationFilter.value = locationNames.includes(selected) ? selected : '';
}

function syncDeviceLocationSelects() {
  const selectedDeviceLocation = deviceLocation.value;
  const selectedConsoleDevice = consoleDevice.value;

  deviceLocation.replaceChildren();
  const emptyLocation = document.createElement('option');
  emptyLocation.value = '';
  emptyLocation.textContent = 'Sem local';
  deviceLocation.append(emptyLocation);

  for (const location of locations) {
    const option = document.createElement('option');
    option.value = location.id;
    option.textContent = location.name;
    deviceLocation.append(option);
  }
  deviceLocation.value = locations.some((location) => location.id === selectedDeviceLocation) ? selectedDeviceLocation : '';

  consoleDevice.replaceChildren();
  const emptyDevice = document.createElement('option');
  emptyDevice.value = '';
  emptyDevice.textContent = 'Selecione o equipamento';
  consoleDevice.append(emptyDevice);

  for (const device of devices) {
    const option = document.createElement('option');
    option.value = device.id;
    option.textContent = `${device.name} (${device.host})`;
    consoleDevice.append(option);
  }
  consoleDevice.value = devices.some((device) => device.id === selectedConsoleDevice) ? selectedConsoleDevice : '';
}

function formatCpf(value = '') {
  return String(value)
    .replace(/\D/g, '')
    .slice(0, 11)
    .replace(/^(\d{3})(\d)/, '$1.$2')
    .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d)/, '.$1-$2');
}

function formatPhone(value = '') {
  const digits = String(value).replace(/\D/g, '').slice(0, 11);
  if (!digits) return '';
  if (digits.length <= 2) return digits;
  if (digits.length <= 6) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
  if (digits.length <= 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 3)} ${digits.slice(3, 7)}-${digits.slice(7)}`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function statusLabel(lead) {
  if (lead.releaseMethod === 'cpf_active') return 'Cliente ativo';
  if (lead.releaseMethod === 'instagram') return 'Instagram';
  return 'Pendente Instagram';
}

function statusClass(lead) {
  if (lead.status === 'released') return 'released';
  if (lead.status === 'instagram_required') return 'instagram_required';
  return '';
}

function visibleLeads() {
  const term = searchInput.value.trim().toLowerCase();
  let rows = metricLeads();

  if (!term) return rows;
  return rows.filter((lead) => JSON.stringify({ ...lead, location: leadLocation(lead) }).toLowerCase().includes(term));
}

function metricLeads() {
  const selectedLocation = locationFilter.value;
  const rows = finalLeads();

  if (!selectedLocation) return rows;
  return rows.filter((lead) => leadLocation(lead) === selectedLocation);
}

function renderLeads() {
  const rows = visibleLeads();
  const totals = metricLeads();
  totalCount.textContent = totals.length;
  releasedCount.textContent = totals.filter((lead) => lead.status === 'released').length;
  pendingCount.textContent = totals.filter((lead) => lead.status !== 'released').length;
  locationCount.textContent = new Set(totals.map(leadLocation)).size;

  if (!rows.length) {
    leadsBody.innerHTML = '<tr><td colspan="8">Nenhum lead encontrado.</td></tr>';
    return;
  }

  leadsBody.innerHTML = rows.map((lead) => `
    <tr>
      <td>${escapeHtml(formatDate(lead.createdAt))}</td>
      <td class="client-cell">
        <strong>${escapeHtml(lead.name || lead.customerName || '-')}</strong>
        <small>${escapeHtml(lead.customerName && lead.customerName !== lead.name ? lead.customerName : '')}</small>
      </td>
      <td class="contact-cell">
        <span>${escapeHtml(formatPhone(lead.phone) || '-')}</span>
        <small>${escapeHtml(lead.email || '')}</small>
      </td>
      <td>${escapeHtml(formatCpf(lead.cpf) || '-')}</td>
      <td>${escapeHtml(leadLocation(lead))}</td>
      <td class="status-cell">
        <span class="badge ${statusClass(lead)}">${escapeHtml(statusLabel(lead))}</span>
        <small>${escapeHtml(lead.message || '')}</small>
      </td>
      <td>${escapeHtml(lead.ip || '-')}<small>${escapeHtml(lead.mac || '')}</small></td>
      <td>
        <div class="row-actions">
          <button class="danger" type="button" data-action="delete-lead" data-id="${escapeHtml(lead.id)}">Excluir</button>
        </div>
      </td>
    </tr>
  `).join('');
}

function coordsText(location) {
  if (location.latitude === null || location.longitude === null) return '-';
  return `${Number(location.latitude).toFixed(6)}, ${Number(location.longitude).toFixed(6)}`;
}

function parseCoordinates(value = '') {
  const match = String(value)
    .trim()
    .replace(';', ',')
    .match(/^(-?\d+(?:[.,]\d+)?)\s*,\s*(-?\d+(?:[.,]\d+)?)$/);

  if (!match) return { latitude: '', longitude: '' };
  return {
    latitude: match[1].replace(',', '.'),
    longitude: match[2].replace(',', '.')
  };
}

function renderLocations() {
  if (!locations.length) {
    locationsBody.innerHTML = '<tr><td colspan="4">Nenhum local cadastrado.</td></tr>';
    return;
  }

  locationsBody.innerHTML = locations.map((location) => `
    <tr>
      <td>${escapeHtml(location.name)}<small>${escapeHtml(location.notes || '')}</small></td>
      <td>${escapeHtml(location.address || '-')}</td>
      <td>${escapeHtml(coordsText(location))}</td>
      <td>
        <div class="row-actions">
          <button type="button" data-action="edit-location" data-id="${escapeHtml(location.id)}">Editar</button>
          <button type="button" data-action="add-device-location" data-id="${escapeHtml(location.id)}">Equipamentos</button>
          <button class="danger" type="button" data-action="delete-location" data-id="${escapeHtml(location.id)}">Remover</button>
        </div>
      </td>
    </tr>
  `).join('');
}

function renderDevices() {
  if (!devices.length) {
    devicesBody.innerHTML = '<tr><td colspan="5">Nenhum equipamento cadastrado.</td></tr>';
    return;
  }

  devicesBody.innerHTML = devices.map((device) => `
    <tr>
      <td>${escapeHtml(device.name)}<small>${escapeHtml(device.notes || '')}</small></td>
      <td>${escapeHtml(device.locationName || 'Sem local')}</td>
      <td>${escapeHtml(device.host)}:${escapeHtml(device.sshPort)}<small>${device.connectionType === 'routeros_api' ? 'API RouterOS' : 'SSH'} · ${escapeHtml(device.sshUser)}</small></td>
      <td>${device.hasPrivateKey ? 'Chave SSH' : ''}${device.hasPrivateKey && device.hasPassword ? ' + ' : ''}${device.hasPassword ? 'Senha' : '-'}</td>
      <td>
        <div class="row-actions">
          <button type="button" data-action="edit-device" data-id="${escapeHtml(device.id)}">Editar</button>
          <button type="button" data-action="console-device" data-id="${escapeHtml(device.id)}">Console</button>
          <button class="danger" type="button" data-action="reboot-device" data-id="${escapeHtml(device.id)}">Reboot</button>
          <button class="danger" type="button" data-action="delete-device" data-id="${escapeHtml(device.id)}">Remover</button>
        </div>
      </td>
    </tr>
  `).join('');
}

function devicesForLocation(locationId) {
  return devices.filter((device) => device.locationId === locationId);
}

function openLocationDevices(location) {
  selectedLocationForDevices = location;
  locationDevicesTitle.textContent = location.name;
  renderLocationDevicesModal();
  locationDevicesModal.classList.remove('is-hidden');
}

function closeLocationDevices() {
  selectedLocationForDevices = null;
  locationDevicesModal.classList.add('is-hidden');
}

function renderLocationDevicesModal() {
  if (!selectedLocationForDevices) return;

  const linked = devicesForLocation(selectedLocationForDevices.id);
  locationDevicesList.innerHTML = linked.length
    ? linked.map((device) => `
      <article class="device-item">
        <div>
          <strong>${escapeHtml(device.name)}</strong>
          <small>${escapeHtml(device.host)}:${escapeHtml(device.sshPort)} · ${device.connectionType === 'routeros_api' ? 'API RouterOS' : 'SSH'}</small>
        </div>
        <button type="button" data-action="unlink-device-location" data-id="${escapeHtml(device.id)}">Desvincular</button>
      </article>
    `).join('')
    : '<p class="topbar-copy">Nenhum equipamento vinculado a este local.</p>';

  linkDeviceSelect.replaceChildren();
  const emptyOption = document.createElement('option');
  emptyOption.value = '';
  emptyOption.textContent = 'Selecione um equipamento';
  linkDeviceSelect.append(emptyOption);

  for (const device of devices.filter((item) => item.locationId !== selectedLocationForDevices.id)) {
    const option = document.createElement('option');
    option.value = device.id;
    option.textContent = `${device.name} (${device.host})`;
    linkDeviceSelect.append(option);
  }
}

function openConsoleForDevice(device) {
  consoleCard.classList.remove('is-hidden');
  consoleDevice.value = device.id;
  selectedConsoleDeviceName.textContent = `${device.name} (${device.host})`;
  consoleLog = `Conectado ao equipamento selecionado: ${device.name} (${device.host})`;
  consoleOutput.textContent = consoleLog;
  consoleCommand.focus();
}

function closeConsole() {
  consoleCard.classList.add('is-hidden');
  consoleDevice.value = '';
  selectedConsoleDeviceName.textContent = 'Selecione um equipamento';
}

function appendConsole(text) {
  consoleLog = consoleLog === 'Aguardando comando...' ? text : `${consoleLog}\n${text}`;
  consoleOutput.textContent = consoleLog;
  consoleOutput.scrollTop = consoleOutput.scrollHeight;
}

function renderAll() {
  syncLocationFilter();
  syncDeviceLocationSelects();
  renderLeads();
  renderLocations();
  renderDevices();
  renderLocationDevicesModal();
  updateMapPreview();
}

async function loadLeads() {
  const payload = await requestJson('/api/admin/leads');
  if (!payload) return;
  leads = payload.leads || [];
  renderAll();
}

async function loadLocations() {
  const payload = await requestJson('/api/admin/locations');
  if (!payload) return;
  locations = payload.locations || [];
  renderAll();
}

async function loadDevices() {
  const payload = await requestJson('/api/admin/devices');
  if (!payload) return;
  devices = payload.devices || [];
  renderAll();
}

async function loadAdminData() {
  const [leadsPayload, locationsPayload, devicesPayload] = await Promise.all([
    requestJson('/api/admin/leads'),
    requestJson('/api/admin/locations'),
    requestJson('/api/admin/devices')
  ]);

  if (!leadsPayload || !locationsPayload || !devicesPayload) return;
  leads = leadsPayload.leads || [];
  locations = locationsPayload.locations || [];
  devices = devicesPayload.devices || [];
  renderAll();
}

function exportCsv() {
  const header = ['Data', 'Local', 'Nome', 'Telefone', 'Email', 'CPF', 'Status', 'Metodo', 'IP', 'MAC', 'Cliente IXC'];
  const lines = visibleLeads().map((lead) => [
    formatDate(lead.createdAt),
    leadLocation(lead),
    lead.name,
    formatPhone(lead.phone),
    lead.email,
    formatCpf(lead.cpf),
    statusLabel(lead),
    lead.releaseMethod,
    lead.ip,
    lead.mac,
    lead.customerName
  ].map((value) => `"${String(value || '').replaceAll('"', '""')}"`).join(';'));

  const csv = `\ufeff${[header.join(';'), ...lines].join('\r\n')}`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `leads-hotspot-uai-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function clearLocationForm() {
  locationForm.reset();
  field('locationId').value = '';
  updateMapPreview();
}

function fillLocationForm(location) {
  field('locationId').value = location.id;
  field('locationName').value = location.name || '';
  field('locationAddress').value = location.address || '';
  field('locationCoordinates').value = location.latitude !== null && location.longitude !== null
    ? coordsText(location)
    : '';
  field('locationNotes').value = location.notes || '';
  updateMapPreview();
  field('locationName').focus();
}

function clearDeviceForm() {
  deviceForm.reset();
  field('deviceId').value = '';
  field('deviceConnectionType').value = 'ssh';
  field('devicePort').value = '22';
  field('deviceRebootCommand').value = '/system reboot';
  field('devicePassword').placeholder = 'Manter atual se vazio';
  field('devicePrivateKey').placeholder = 'Opcional. Manter atual se vazio.';
}

function fillDeviceForm(device) {
  field('deviceId').value = device.id;
  field('deviceName').value = device.name || '';
  field('deviceLocation').value = device.locationId || '';
  field('deviceConnectionType').value = device.connectionType || 'ssh';
  field('deviceHost').value = device.host || '';
  field('devicePort').value = device.sshPort || 22;
  field('deviceUser').value = device.sshUser || '';
  field('devicePassword').value = '';
  field('devicePassword').placeholder = device.hasPassword ? 'Senha atual cadastrada' : 'Senha SSH';
  field('devicePrivateKey').value = '';
  field('devicePrivateKey').placeholder = device.hasPrivateKey ? 'Chave atual cadastrada' : 'Opcional';
  field('deviceRebootCommand').value = device.rebootCommand || '/system reboot';
  field('deviceNotes').value = device.notes || '';
  field('deviceName').focus();
}

function newDeviceForLocation(location) {
  clearDeviceForm();
  setActiveTab('devicesPanel');
  field('deviceLocation').value = location.id;
  field('deviceName').value = `MikroTik ${location.name}`;
  field('deviceName').focus();
  closeLocationDevices();
}

async function saveDeviceLocation(device, locationId) {
  await requestJson('/api/admin/devices', {
    method: 'POST',
    body: JSON.stringify({
      id: device.id,
      name: device.name,
      locationId,
      connectionType: device.connectionType,
      host: device.host,
      sshPort: device.sshPort,
      sshUser: device.sshUser,
      rebootCommand: device.rebootCommand,
      notes: device.notes
    })
  });
  await loadDevices();
}

function updateMapPreview() {
  const coordinates = parseCoordinates(field('locationCoordinates').value);
  const latitude = Number.parseFloat(coordinates.latitude);
  const longitude = Number.parseFloat(coordinates.longitude);
  const address = field('locationAddress').value.trim();

  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    const delta = 0.01;
    locationMap.src = `https://www.openstreetmap.org/export/embed.html?bbox=${longitude - delta}%2C${latitude - delta}%2C${longitude + delta}%2C${latitude + delta}&layer=mapnik&marker=${latitude}%2C${longitude}`;
    openMap.href = `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=16/${latitude}/${longitude}`;
    return;
  }

  const query = encodeURIComponent(address || 'Brasil');
  locationMap.src = `https://www.openstreetmap.org/export/embed.html?bbox=-74.0%2C-34.0%2C-34.0%2C6.0&layer=mapnik`;
  openMap.href = `https://www.openstreetmap.org/search?query=${query}`;
}

async function lookupLocationAddress({ silent = false } = {}) {
  const address = field('locationAddress').value.trim();
  if (!address) {
    if (!silent) field('locationAddress').focus();
    return;
  }

  lookupLocationButton.disabled = true;
  lookupLocationButton.textContent = 'Buscando...';
  try {
    const payload = await requestJson(`/api/admin/geocode?address=${encodeURIComponent(address)}`);
    if (!payload?.location) throw new Error('Endereco nao encontrado.');
    field('locationCoordinates').value = `${payload.location.latitude}, ${payload.location.longitude}`;
    if (payload.location.displayName && !field('locationName').value.trim()) {
      field('locationName').value = field('locationAddress').value.trim();
    }
    updateMapPreview();
  } catch (error) {
    if (!silent) window.alert(error.message);
  } finally {
    lookupLocationButton.disabled = false;
    lookupLocationButton.textContent = 'Buscar no mapa';
  }
}

function scheduleLocationLookup() {
  clearTimeout(locationLookupTimer);
  const address = field('locationAddress').value.trim();
  if (address.length < 8) return;

  locationLookupTimer = setTimeout(() => {
    lookupLocationAddress({ silent: true });
  }, 900);
}

function setActiveTab(panelId) {
  for (const button of document.querySelectorAll('.tab-button')) {
    button.classList.toggle('active', button.dataset.tab === panelId);
  }

  for (const panel of document.querySelectorAll('.tab-panel')) {
    panel.classList.toggle('active', panel.id === panelId);
  }
}

async function saveLocation(event) {
  event.preventDefault();
  const coordinates = parseCoordinates(field('locationCoordinates').value);
  const payload = {
    id: field('locationId').value,
    name: field('locationName').value,
    address: field('locationAddress').value,
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    notes: field('locationNotes').value
  };

  await requestJson('/api/admin/locations', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  clearLocationForm();
  await loadLocations();
}

async function saveDevice(event) {
  event.preventDefault();
  const payload = {
    id: field('deviceId').value,
    name: field('deviceName').value,
    locationId: field('deviceLocation').value,
    connectionType: field('deviceConnectionType').value,
    host: field('deviceHost').value,
    sshPort: field('devicePort').value,
    sshUser: field('deviceUser').value,
    sshPassword: field('devicePassword').value,
    sshPrivateKey: field('devicePrivateKey').value,
    rebootCommand: field('deviceRebootCommand').value,
    notes: field('deviceNotes').value
  };

  await requestJson('/api/admin/devices', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  clearDeviceForm();
  await loadDevices();
}

async function runConsole() {
  const id = consoleDevice.value;
  const command = consoleCommand.value.trim();
  if (!id) {
    appendConsole('Selecione um equipamento.');
    return;
  }
  if (!command) {
    appendConsole('Digite um comando.');
    return;
  }

  appendConsole(`> ${command}`);
  consoleCommand.value = '';
  try {
    const payload = await requestJson(`/api/admin/devices/${encodeURIComponent(id)}/console`, {
      method: 'POST',
      body: JSON.stringify({ command })
    });
    const result = payload.result || {};
    appendConsole([
      result.stdout || '',
      result.stderr ? `\n[stderr]\n${result.stderr}` : '',
      `\n[exit ${result.code ?? 0}]`
    ].join('').trim());
  } catch (error) {
    appendConsole(`[erro] ${error.message}`);
  }
}

async function rebootDevice(id) {
  const device = devices.find((item) => item.id === id);
  if (!device) return;
  if (!window.confirm(`Reiniciar ${device.name}?`)) return;

  consoleCard.classList.remove('is-hidden');
  consoleDevice.value = device.id;
  selectedConsoleDeviceName.textContent = `${device.name} (${device.host})`;
  appendConsole(`> ${device.rebootCommand || '/system reboot'}`);
  appendConsole(`Enviando reboot para ${device.name}...`);
  setActiveTab('devicesPanel');
  try {
    const payload = await requestJson(`/api/admin/devices/${encodeURIComponent(id)}/reboot`, {
      method: 'POST',
      body: JSON.stringify({})
    });
    appendConsole(`${payload.message}\n${payload.result?.stdout || ''}${payload.result?.stderr || ''}`.trim());
  } catch (error) {
    appendConsole(`[erro] ${error.message}`);
  }
}

function startConsoleDrag(event) {
  if (event.button !== 0) return;
  const rect = consoleCard.getBoundingClientRect();
  const offsetX = event.clientX - rect.left;
  const offsetY = event.clientY - rect.top;

  function move(pointerEvent) {
    const maxLeft = window.innerWidth - consoleCard.offsetWidth - 8;
    const maxTop = window.innerHeight - consoleCard.offsetHeight - 8;
    const left = Math.max(8, Math.min(pointerEvent.clientX - offsetX, maxLeft));
    const top = Math.max(8, Math.min(pointerEvent.clientY - offsetY, maxTop));
    consoleCard.style.left = `${left}px`;
    consoleCard.style.top = `${top}px`;
    consoleCard.style.right = 'auto';
    consoleCard.style.bottom = 'auto';
  }

  function stop() {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', stop);
  }

  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', stop);
}

searchInput.addEventListener('input', renderLeads);
locationFilter.addEventListener('change', renderLeads);
refreshButton.addEventListener('click', loadLeads);
exportButton.addEventListener('click', exportCsv);
leadsBody.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action="delete-lead"]');
  if (!button) return;

  const lead = leads.find((item) => item.id === button.dataset.id);
  const label = lead?.name || lead?.customerName || lead?.cpf || 'este cliente';
  if (!window.confirm(`Excluir os dados de ${label}?`)) return;

  await requestJson(`/api/admin/leads/${encodeURIComponent(button.dataset.id)}`, { method: 'DELETE' });
  await loadLeads();
});
clearLocationButton.addEventListener('click', clearLocationForm);
clearDeviceButton.addEventListener('click', clearDeviceForm);
locationForm.addEventListener('submit', saveLocation);
deviceForm.addEventListener('submit', saveDevice);
runConsoleButton.addEventListener('click', runConsole);
lookupLocationButton.addEventListener('click', () => lookupLocationAddress());
closeConsoleButton.addEventListener('click', closeConsole);
closeLocationDevicesButton.addEventListener('click', closeLocationDevices);
newDeviceForLocationButton.addEventListener('click', () => {
  if (selectedLocationForDevices) newDeviceForLocation(selectedLocationForDevices);
});
linkDeviceToLocationButton.addEventListener('click', async () => {
  if (!selectedLocationForDevices) return;
  const device = devices.find((item) => item.id === linkDeviceSelect.value);
  if (!device) return;
  await saveDeviceLocation(device, selectedLocationForDevices.id);
});
consoleHeader.addEventListener('mousedown', startConsoleDrag);
field('deviceConnectionType').addEventListener('change', () => {
  const port = field('devicePort');
  if (field('deviceConnectionType').value === 'routeros_api' && (!port.value || port.value === '22')) {
    port.value = '2012';
  }
  if (field('deviceConnectionType').value === 'ssh' && (!port.value || port.value === '2012')) {
    port.value = '22';
  }
});
consoleCommand.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    runConsole();
  }
});
consoleDevice.addEventListener('change', () => {
  const device = devices.find((item) => item.id === consoleDevice.value);
  selectedConsoleDeviceName.textContent = device ? `${device.name} (${device.host})` : 'Selecione um equipamento';
});
field('locationCoordinates').addEventListener('input', updateMapPreview);
field('locationAddress').addEventListener('input', () => {
  updateMapPreview();
  scheduleLocationLookup();
});
field('locationAddress').addEventListener('change', () => lookupLocationAddress({ silent: true }));

document.querySelector('.tabs').addEventListener('click', (event) => {
  const button = event.target.closest('.tab-button');
  if (button) setActiveTab(button.dataset.tab);
});

locationsBody.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;

  const location = locations.find((item) => item.id === button.dataset.id);
  if (!location) return;

  if (button.dataset.action === 'edit-location') {
    fillLocationForm(location);
  }

  if (button.dataset.action === 'add-device-location') {
    openLocationDevices(location);
  }

  if (button.dataset.action === 'delete-location' && window.confirm(`Remover local ${location.name}?`)) {
    await requestJson(`/api/admin/locations/${encodeURIComponent(location.id)}`, { method: 'DELETE' });
    await loadLocations();
  }
});

locationDevicesList.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button || !selectedLocationForDevices) return;

  const device = devices.find((item) => item.id === button.dataset.id);
  if (!device) return;

  if (button.dataset.action === 'unlink-device-location') {
    await saveDeviceLocation(device, '');
  }
});

devicesBody.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;

  const device = devices.find((item) => item.id === button.dataset.id);
  if (!device) return;

  if (button.dataset.action === 'edit-device') {
    fillDeviceForm(device);
  }

  if (button.dataset.action === 'console-device') {
    openConsoleForDevice(device);
  }

  if (button.dataset.action === 'reboot-device') {
    await rebootDevice(device.id);
  }

  if (button.dataset.action === 'delete-device' && window.confirm(`Remover equipamento ${device.name}?`)) {
    await requestJson(`/api/admin/devices/${encodeURIComponent(device.id)}`, { method: 'DELETE' });
    await loadDevices();
  }
});

logoutButton.addEventListener('click', async () => {
  await fetch('/api/admin/logout', { method: 'POST' });
  window.location.href = adminLoginPath;
});

loadAdminData().catch((error) => {
  leadsBody.innerHTML = `<tr><td colspan="8">${escapeHtml(error.message)}</td></tr>`;
  locationsBody.innerHTML = `<tr><td colspan="4">${escapeHtml(error.message)}</td></tr>`;
  devicesBody.innerHTML = `<tr><td colspan="5">${escapeHtml(error.message)}</td></tr>`;
});
