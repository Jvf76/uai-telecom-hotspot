const params = new URLSearchParams(window.location.search);
const cpfInput = document.querySelector('#cpf');
const cpfForm = document.querySelector('#cpfForm');
const cpfButton = document.querySelector('#cpfButton');
const nameInput = document.querySelector('#name');
const phoneInput = document.querySelector('#phone');
const emailInput = document.querySelector('#email');
const statusEl = document.querySelector('#status');
const instagramBox = document.querySelector('#instagramBox');
const instagramLink = document.querySelector('#instagramLink');
const instagramText = document.querySelector('#instagramText');
const releaseButton = document.querySelector('#releaseButton');
let openedInstagram = false;

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function formatCpf(value) {
  return onlyDigits(value)
    .slice(0, 11)
    .replace(/^(\d{3})(\d)/, '$1.$2')
    .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d)/, '.$1-$2');
}

function formatPhone(value) {
  const digits = onlyDigits(value).slice(0, 11);
  if (digits.length <= 2) return digits;
  if (digits.length <= 7) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 3)} ${digits.slice(3, 7)}-${digits.slice(7)}`;
}

function contextPayload(extra = {}) {
  return {
    ip: params.get('ip') || params.get('client_ip') || '',
    mac: params.get('mac') || params.get('client_mac') || '',
    linkOrig: params.get('link-orig') || params.get('link_orig') || '',
    name: nameInput?.value || '',
    phone: phoneInput?.value || '',
    email: emailInput?.value || '',
    ...extra
  };
}

function setStatus(message, type = '') {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`.trim();
}

function redirectWhenReady(url) {
  setTimeout(() => {
    window.location.href = url || 'http://neverssl.com';
  }, 900);
}

instagramLink.addEventListener('click', (event) => {
  event.preventDefault();
  openedInstagram = true;
  releaseButton.disabled = false;
  setStatus('Abra o perfil @uaitelecom no Instagram. Depois volte aqui e toque em "Já segui".');
  window.location.href = 'instagram://user?username=uaitelecom';
});

cpfInput.addEventListener('input', () => {
  cpfInput.value = formatCpf(cpfInput.value);
});

phoneInput?.addEventListener('input', () => {
  phoneInput.value = formatPhone(phoneInput.value);
});

cpfForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  instagramBox.hidden = true;
  cpfButton.disabled = true;
  setStatus('Consultando cadastro...');

  try {
    const response = await fetch('/api/check-cpf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(contextPayload({ cpf: cpfInput.value }))
    });
    const payload = await response.json();

    if (!response.ok) throw new Error(payload.error || 'Falha ao consultar CPF.');

    if (payload.status === 'released') {
      setStatus(payload.message, 'success');
      redirectWhenReady(payload.redirect);
      return;
    }

    instagramLink.href = 'instagram://user?username=uaitelecom';
    instagramText.textContent = `${payload.message} Para liberar a internet completa, siga a UAI Telecom no Instagram e depois toque em "Já segui".`;
    instagramBox.hidden = false;
    openedInstagram = false;
    releaseButton.disabled = true;
    setStatus(payload.message, payload.message.includes('não está ativo') ? 'error' : '');
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    cpfButton.disabled = false;
  }
});

releaseButton.addEventListener('click', async () => {
  if (!openedInstagram) {
    setStatus('Abra o Instagram da UAI Telecom antes de confirmar.', 'error');
    return;
  }

  releaseButton.disabled = true;
  setStatus('Liberando acesso...');

  try {
    const response = await fetch('/api/instagram-release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(contextPayload({ cpf: cpfInput.value }))
    });
    const payload = await response.json();

    if (!response.ok) throw new Error(payload.error || 'Falha ao liberar acesso.');
    setStatus(payload.message, 'success');
    redirectWhenReady(payload.redirect);
  } catch (error) {
    setStatus(error.message, 'error');
    releaseButton.disabled = false;
  }
});
