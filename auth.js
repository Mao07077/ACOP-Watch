async function request(path, options) {
  const response = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Request failed.');
  return body;
}

const form = document.querySelector('#authForm');
const error = document.querySelector('#authError');
const setup = document.body.dataset.setup === 'true';
const submitButton = form.querySelector('button[type="submit"]');

if (!setup) {
  request('/api/auth/me', { method: 'GET', headers: {} })
    .then((body) => {
      if (body.user) window.location.replace('/index.html#dashboard');
    })
  .catch((requestError) => {
    error.textContent = requestError.message || 'Unable to check the current login session.';
    error.hidden = false;
  });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.hidden = true;
  submitButton.disabled = true;
  submitButton.textContent = setup ? 'Creating account…' : 'Logging in…';
  const data = Object.fromEntries(new FormData(form));
  try {
    if (setup) {
      await request('/api/auth/setup', { method: 'POST', body: JSON.stringify(data) });
      await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: data.username, password: data.password }) });
    } else {
      await request('/api/auth/login', { method: 'POST', body: JSON.stringify(data) });
    }
    const session = await request('/api/auth/me', { method: 'GET', headers: {} });
    if (!session.user) throw new Error('Login succeeded but the session could not be verified. Please try again.');
    window.location.replace('/index.html#dashboard');
  } catch (requestError) {
    error.textContent = requestError.message;
    error.hidden = false;
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = setup ? 'Create Admin account' : 'Log in';
  }
});
