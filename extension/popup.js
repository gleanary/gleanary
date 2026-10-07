import { isValidTabUrl, saveArticle, getPageHtml, normalizeBaseUrl } from './lib/api-client.js';

const statusEl = document.getElementById('status');
const urlDisplayEl = document.getElementById('url-display');
const actionsEl = document.getElementById('actions');
const optionsRowEl = document.getElementById('options-row');
const sendHtmlCheckbox = document.getElementById('send-html');

// Persist checkbox changes (registered once, outside init)
sendHtmlCheckbox.addEventListener('change', () => {
  chrome.storage.sync.set({ sendHtml: sendHtmlCheckbox.checked });
});

/**
 * Updates the status display in the popup.
 * @param {'saving'|'success'|'duplicate'|'error'|'no-config'|'invalid-url'} type
 * @param {string} message
 */
function setStatus(type, message) {
  statusEl.className = `status ${type}`;
  statusEl.textContent = '';
  if (type === 'saving') {
    const spinner = document.createElement('div');
    spinner.className = 'spinner';
    const span = document.createElement('span');
    span.textContent = message;
    statusEl.appendChild(spinner);
    statusEl.appendChild(span);
  } else {
    statusEl.textContent = message;
  }
}

/**
 * Shows action buttons after save completes.
 * @param {Array<{label: string, href?: string, onClick?: Function, className?: string}>} buttons
 */
function showActions(buttons) {
  actionsEl.style.display = 'flex';
  actionsEl.replaceChildren();
  for (const btn of buttons) {
    if (btn.href) {
      const a = document.createElement('a');
      a.href = btn.href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = btn.label;
      if (btn.className) a.className = btn.className;
      actionsEl.appendChild(a);
    } else if (btn.onClick) {
      const button = document.createElement('button');
      button.textContent = btn.label;
      if (btn.className) button.className = btn.className;
      button.addEventListener('click', btn.onClick);
      actionsEl.appendChild(button);
    }
  }
}

/**
 * Main save flow. Reads settings, gets current tab, saves article.
 */
async function init() {
  // Load settings and current tab in parallel
  const [settings, [tab]] = await Promise.all([
    chrome.storage.sync.get(['apiBaseUrl', 'authUsername', 'authPassword', 'sendHtml']),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ]);

  const { apiBaseUrl, authUsername, authPassword, sendHtml } = settings;
  const auth = { username: authUsername, password: authPassword };

  if (!apiBaseUrl) {
    setStatus('no-config', 'API URL not configured.');
    showActions([
      {
        label: 'Open Settings',
        onClick: () => chrome.runtime.openOptionsPage(),
        className: 'link-options',
      },
    ]);
    return;
  }

  // Restore checkbox state
  sendHtmlCheckbox.checked = sendHtml !== false;
  optionsRowEl.style.display = 'flex';

  const tabUrl = tab?.url;

  if (!tabUrl || !isValidTabUrl(tabUrl)) {
    setStatus('invalid-url', 'This page cannot be saved.');
    return;
  }

  urlDisplayEl.textContent = tabUrl;

  // Save article
  setStatus('saving', 'Saving...');

  let html = null;
  if (sendHtml !== false && tab.id) {
    html = await getPageHtml(tab.id);
  }

  try {
    const result = await saveArticle(apiBaseUrl, tabUrl, html, auth);

    if (result.status === 'created') {
      setStatus('success', 'Saved!');
      const readerUrl = `${normalizeBaseUrl(apiBaseUrl)}/reader/${result.articleId}`;
      showActions([{ label: 'Open in Reader', href: readerUrl, className: 'link-reader' }]);
    } else if (result.status === 'duplicate') {
      setStatus('duplicate', 'Already saved.');
    } else {
      setStatus('error', result.error ?? 'Failed to save.');
      showActions([{ label: 'Retry', onClick: () => init(), className: 'link-options' }]);
    }
  } catch {
    setStatus('error', 'Could not connect to server.');
    showActions([
      { label: 'Retry', onClick: () => init(), className: 'link-options' },
      {
        label: 'Settings',
        onClick: () => chrome.runtime.openOptionsPage(),
        className: 'link-options',
      },
    ]);
  }
}

init();
