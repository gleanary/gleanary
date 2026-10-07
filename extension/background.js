import { isValidTabUrl, saveArticle, getPageHtml } from './lib/api-client.js';

/**
 * Shows a Chrome notification with the Gleanary Clipper branding.
 * @param {string} message - Notification body text
 */
function notify(message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon-128.png',
    title: 'Gleanary Clipper',
    message,
  });
}

/**
 * Handles the keyboard shortcut command to save the current page.
 * Sends a notification with the result.
 */
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'save-page') return;

  const [settings, [tab]] = await Promise.all([
    chrome.storage.sync.get(['apiBaseUrl', 'authUsername', 'authPassword', 'sendHtml']),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ]);

  const { apiBaseUrl, authUsername, authPassword, sendHtml } = settings;
  const auth = { username: authUsername, password: authPassword };

  if (!apiBaseUrl) {
    notify('API URL not configured. Open extension options.');
    return;
  }

  const tabUrl = tab?.url;

  if (!tabUrl || !isValidTabUrl(tabUrl)) {
    notify('This page cannot be saved.');
    return;
  }

  const html = sendHtml !== false && tab.id ? await getPageHtml(tab.id) : null;

  try {
    const result = await saveArticle(apiBaseUrl, tabUrl, html, auth);

    if (result.status === 'created') {
      notify(`Saved: ${tabUrl}`);
    } else if (result.status === 'duplicate') {
      notify('Already saved.');
    } else {
      notify(result.error ?? 'Failed to save.');
    }
  } catch {
    notify('Could not connect to server.');
  }
});
