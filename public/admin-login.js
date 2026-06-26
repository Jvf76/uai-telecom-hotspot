const form = document.querySelector('#loginForm');
const statusEl = document.querySelector('#loginStatus');
const userInput = document.querySelector('#user');
const passwordInput = document.querySelector('#password');
const adminPath = window.location.pathname.replace(/\/login\/?$/, '') || '/admin';

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  statusEl.textContent = 'Entrando...';
  statusEl.className = 'login-status';

  try {
    const response = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user: userInput.value,
        password: passwordInput.value
      })
    });

    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Falha ao entrar.');
    window.location.href = adminPath;
  } catch (error) {
    statusEl.textContent = error.message;
    statusEl.className = 'login-status error';
  }
});
