// Background script for managing extension state
const DEFAULT_SETTINGS = {
  enabled: true,
  whitelist: [],
  blurIntensity: 10,
};

// Initialize extension
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(["settings"], (result) => {
    if (!result.settings) {
      chrome.storage.sync.set({ settings: DEFAULT_SETTINGS });
    }
  });
});

// Handle messages from content script and popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getSettings") {
    chrome.storage.sync.get(["settings"], (result) => {
      sendResponse(result.settings || DEFAULT_SETTINGS);
    });
    return true;
  }

  if (request.action === "updateSettings") {
    chrome.storage.sync.set({ settings: request.settings }, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (request.action === "checkWhitelist") {
    chrome.storage.sync.get(["settings"], (result) => {
      const settings = result.settings || DEFAULT_SETTINGS;
      const hostname = new URL(request.url).hostname;
      const isWhitelisted = settings.whitelist.some(
        (domain) => hostname === domain || hostname.endsWith("." + domain)
      );
      sendResponse({ isWhitelisted, enabled: settings.enabled });
    });
    return true;
  }
});

// Update badge based on current tab
chrome.tabs.onActivated.addListener((activeInfo) => {
  updateBadge(activeInfo.tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete") {
    updateBadge(tabId);
  }
});

function updateBadge(tabId) {
  chrome.tabs.get(tabId, (tab) => {
    if (tab.url) {
      chrome.storage.sync.get(["settings"], (result) => {
        const settings = result.settings || DEFAULT_SETTINGS;
        if (!settings.enabled) {
          chrome.action.setBadgeText({ text: "OFF", tabId });
          chrome.action.setBadgeBackgroundColor({ color: "#666", tabId });
          return;
        }

        const hostname = new URL(tab.url).hostname;
        const isWhitelisted = settings.whitelist.some(
          (domain) => hostname === domain || hostname.endsWith("." + domain)
        );

        if (isWhitelisted) {
          chrome.action.setBadgeText({ text: "", tabId });
        } else {
          chrome.action.setBadgeText({ text: "ON", tabId });
          chrome.action.setBadgeBackgroundColor({ color: "#4CAF50", tabId });
        }
      });
    }
  });
}
