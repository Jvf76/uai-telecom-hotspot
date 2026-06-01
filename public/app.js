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
const browserLink = document.querySelector('#browserLink');
let instagramUrl = 'https://www.instagram.com/uaitelecom/';
let openedInstagram = false;
let instagramToken = '';
let confirmDelaySeconds = 15;

function isCaptivePortalBrowser() {
  const ua = navigator.userAgent || '';
  return /CaptivePortal|CaptiveNetwork|CaptiveNetworkSupport|wispr|NetworkConnectivity|wv\)/i.test(ua);
}

const isBrowserMode = params.get('browser') === '1' || !isCaptivePortalBrowser();

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

function androidIntentUrl(url) {
  const scheme = url.protocol.replace(':', '') || 'http';
  const path = `${url.host}${url.pathname}${url.search}`;
  return `intent://${path}#Intent;scheme=${scheme};S.browser_fallback_url=${encodeURIComponent(url.href)};end`;
}

function setupBrowserLink() {
  if (!browserLink) return;

  const portalUrl = new URL(window.location.href);
  portalUrl.searchParams.set('browser', '1');
  browserLink.href = portalUrl.href;

  cpfForm.hidden = !isBrowserMode;
  browserLink.hidden = isBrowserMode;

  if (isBrowserMode) return;

  if (/Android/i.test(navigator.userAgent)) {
    browserLink.href = androidIntentUrl(portalUrl);
    browserLink.removeAttribute('target');
  }
}

function showInstagramStep(message) {
  const text = message || 'Para liberar a internet completa, siga a UAI Telecom no Instagram.';
  instagramLink.href = instagramUrl;
  instagramLink.textContent = 'Abrir Instagram';
  instagramText.textContent = `${text} Abra o Instagram, siga a UAI Telecom e depois toque em "Ja segui".`;
  setStatus(text, text.includes('nao esta ativo') ? 'error' : '');

  instagramBox.hidden = false;
  openedInstagram = false;
  releaseButton.disabled = true;
}

instagramLink.addEventListener('click', async (event) => {
  event.preventDefault();
  releaseButton.disabled = true;

  try {
    const response = await fetch('/api/instagram-opened', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(contextPayload({
        cpf: cpfInput.value,
        instagramToken
      }))
    });
    const payload = await response.json();

    if (!response.ok) throw new Error(payload.error || 'Falha ao registrar abertura do Instagram.');
    openedInstagram = true;
    releaseButton.disabled = false;
    setStatus(`Abra o perfil @uaitelecom, siga a UAI Telecom, volte aqui e aguarde ${confirmDelaySeconds} segundos antes de tocar em "Ja segui".`, 'success');
    window.location.href = instagramUrl;
  } catch (error) {
    openedInstagram = false;
    setStatus(error.message, 'error');
  }
});

cpfInput.addEventListener('input', () => {
  cpfInput.value = formatCpf(cpfInput.value);
});

phoneInput?.addEventListener('input', () => {
  phoneInput.value = formatPhone(phoneInput.value);
});

setupBrowserLink();

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

    instagramUrl = payload.instagramUrl || instagramUrl;
    instagramToken = payload.instagramToken || '';
    confirmDelaySeconds = Number(payload.confirmDelaySeconds ?? confirmDelaySeconds);
    showInstagramStep(payload.message);
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
      body: JSON.stringify(contextPayload({
        cpf: cpfInput.value,
        instagramToken
      }))
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
