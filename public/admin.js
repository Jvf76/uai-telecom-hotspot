const leadsBody = document.querySelector('#leadsBody');
const searchInput = document.querySelector('#search');
const refreshButton = document.querySelector('#refresh');
const exportButton = document.querySelector('#exportCsv');
const logoutButton = document.querySelector('#logout');
const totalCount = document.querySelector('#totalCount');
const releasedCount = document.querySelector('#releasedCount');
const instagramCount = document.querySelector('#instagramCount');

let leads = [];

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

function visibleLeads() {
  const term = searchInput.value.trim().toLowerCase();
  if (!term) return leads;
  return leads.filter((lead) => JSON.stringify(lead).toLowerCase().includes(term));
}

function render() {
  const rows = visibleLeads();
  totalCount.textContent = leads.length;
  releasedCount.textContent = leads.filter((lead) => lead.releaseMethod === 'cpf_active').length;
  instagramCount.textContent = leads.filter((lead) => lead.releaseMethod === 'instagram').length;

  if (!rows.length) {
    leadsBody.innerHTML = '<tr><td colspan="7">Nenhum lead encontrado.</td></tr>';
    return;
  }

  leadsBody.innerHTML = rows.map((lead) => `
    <tr>
      <td>${formatDate(lead.createdAt)}</td>
      <td>${lead.name || '-'}<small>${lead.customerName || ''}</small></td>
      <td>${formatPhone(lead.phone) || '-'}</td>
      <td>${lead.email || '-'}</td>
      <td>${formatCpf(lead.cpf) || '-'}</td>
      <td><span class="badge ${lead.status}">${statusLabel(lead)}</span><small>${lead.message || ''}</small></td>
      <td>${lead.ip || '-'}<small>${lead.mac || ''}</small></td>
    </tr>
  `).join('');
}

async function loadLeads() {
  const response = await fetch('/api/admin/leads');
  if (response.status === 401) {
    window.location.href = '/admin/login';
    return;
  }
  if (!response.ok) throw new Error('Falha ao carregar leads.');
  const payload = await response.json();
  leads = payload.leads || [];
  render();
}

function exportCsv() {
  const header = ['Data', 'Nome', 'Telefone', 'Email', 'CPF', 'Status', 'Metodo', 'IP', 'MAC', 'Cliente IXC'];
  const lines = visibleLeads().map((lead) => [
    formatDate(lead.createdAt),
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

searchInput.addEventListener('input', render);
refreshButton.addEventListener('click', loadLeads);
exportButton.addEventListener('click', exportCsv);
logoutButton.addEventListener('click', async () => {
  await fetch('/api/admin/logout', { method: 'POST' });
  window.location.href = '/admin/login';
});

loadLeads().catch((error) => {
  leadsBody.innerHTML = `<tr><td colspan="7">${error.message}</td></tr>`;
});
