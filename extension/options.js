import { checkHealth } from './lib/api-client.js';

const apiUrlInput = document.getElementById('api-url');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const sendHtmlCheckbox = document.getElementById('send-html');
const saveBtn = document.getElementById('save-btn');
const testBtn = document.getElementById('test-btn');
const messageEl = document.getElementById('message');

/**
 * Shows a message next to the action buttons.
 * @param {string} text
 * @param {'success'|'error'|'testing'} type
 */
function showMessage(text, type) {
  messageEl.textContent = text;
  messageEl.className = `message ${type}`;
}

/** Loads saved settings into the form. */
async function loadSettings() {
  const { apiBaseUrl, authUsername, authPassword, sendHtml } = await chrome.storage.sync.get([
    'apiBaseUrl',
    'authUsername',
    'authPassword',
    'sendHtml',
  ]);
  if (apiBaseUrl) apiUrlInput.value = apiBaseUrl;
  if (authUsername) usernameInput.value = authUsername;
  if (authPassword) passwordInput.value = authPassword;
  sendHtmlCheckbox.checked = sendHtml !== false;
}

/** Saves form values to chrome.storage. */
async function saveSettings() {
  const apiBaseUrl = apiUrlInput.value.trim();

  if (!apiBaseUrl) {
    showMessage('API URL is required.', 'error');
    return;
  }

  // Basic URL validation
  try {
    const parsed = new URL(apiBaseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      showMessage('URL must use http or https.', 'error');
      return;
    }
  } catch {
    showMessage('Invalid URL format.', 'error');
    return;
  }

  await chrome.storage.sync.set({
    apiBaseUrl,
    authUsername: usernameInput.value.trim(),
    authPassword: passwordInput.value,
    sendHtml: sendHtmlCheckbox.checked,
  });

  showMessage('Saved!', 'success');
}

/** Tests connection to the configured API. */
async function testConnection() {
  const apiBaseUrl = apiUrlInput.value.trim();
  if (!apiBaseUrl) {
    showMessage('Enter an API URL first.', 'error');
    return;
  }

  showMessage('Testing...', 'testing');
  testBtn.disabled = true;

  try {
    const auth = { username: usernameInput.value.trim(), password: passwordInput.value };
    const healthy = await checkHealth(apiBaseUrl, auth);
    if (healthy) {
      showMessage('Connected!', 'success');
    } else {
      showMessage('Server responded with an error.', 'error');
    }
  } catch {
    showMessage('Could not connect to server.', 'error');
  } finally {
    testBtn.disabled = false;
  }
}

saveBtn.addEventListener('click', saveSettings);
testBtn.addEventListener('click', testConnection);

loadSettings();
