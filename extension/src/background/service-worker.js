// Service worker is intentionally thin.
// All extraction happens in content scripts; all export happens in the popup.
// This file exists so we can register install / update hooks if needed later.

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    console.log('[chat-exporter] installed');
  }
  chrome.storage.session?.remove?.(['bulkJob', 'bulkListed']).catch(() => {});
});
chrome.storage.session?.remove?.(['bulkJob', 'bulkListed']).catch(() => {});

