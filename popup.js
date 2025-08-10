// Popup script for managing extension settings
class PopupManager {
  constructor() {
    this.settings = null;
    this.currentDomain = null;
    this.init();
  }

  async init() {
    await this.loadSettings();
    await this.getCurrentDomain();
    this.setupEventListeners();
    this.updateUI();
  }

  async loadSettings() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "getSettings" }, (response) => {
        this.settings = response || {
          enabled: true,
          whitelist: [],
          blurIntensity: 10,
        };
        resolve();
      });
    });
  }

  async getCurrentDomain() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0] && tabs[0].url) {
          try {
            this.currentDomain = new URL(tabs[0].url).hostname;
          } catch (e) {
            this.currentDomain = null;
          }
        }
        resolve();
      });
    });
  }

  setupEventListeners() {
    // Enable toggle
    const enableToggle = document.getElementById("enableToggle");
    enableToggle.checked = this.settings.enabled;
    enableToggle.addEventListener("change", () => {
      this.settings.enabled = enableToggle.checked;
      this.saveSettings();
    });

    // Blur intensity slider
    const blurIntensity = document.getElementById("blurIntensity");
    const blurValue = document.getElementById("blurValue");
    blurIntensity.value = this.settings.blurIntensity;
    blurValue.textContent = this.settings.blurIntensity;

    blurIntensity.addEventListener("input", () => {
      const newIntensity = parseInt(blurIntensity.value);
      this.settings.blurIntensity = newIntensity;
      blurValue.textContent = newIntensity;

      // Save and notify content script immediately
      this.saveSettings();

      // Also notify current tab directly for immediate update
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs
            .sendMessage(tabs[0].id, {
              action: "updateBlurIntensity",
              intensity: newIntensity,
            })
            .catch(() => {
              // Ignore errors if content script not ready
            });
        }
      });
    });

    // Current site whitelist toggle
    const toggleWhitelist = document.getElementById("toggleWhitelist");
    if (this.currentDomain) {
      const isWhitelisted = this.settings.whitelist.includes(
        this.currentDomain
      );
      toggleWhitelist.textContent = isWhitelisted
        ? "Remove from Whitelist"
        : "Add to Whitelist";

      toggleWhitelist.addEventListener("click", () => {
        this.toggleCurrentDomainWhitelist();
      });
    } else {
      toggleWhitelist.disabled = true;
      toggleWhitelist.textContent = "Invalid URL";
    }

    // Add domain input
    const domainInput = document.getElementById("domainInput");
    const addDomain = document.getElementById("addDomain");

    addDomain.addEventListener("click", () => {
      const domain = domainInput.value.trim().toLowerCase();
      if (domain && !this.settings.whitelist.includes(domain)) {
        this.settings.whitelist.push(domain);
        this.saveSettings();
        domainInput.value = "";
        this.updateWhitelistUI();
      }
    });

    domainInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        addDomain.click();
      }
    });

    // Unblur all button
    const unblurAll = document.getElementById("unblurAll");
    unblurAll.addEventListener("click", () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        chrome.tabs.sendMessage(tabs[0].id, { action: "unblurAll" });
      });
    });
  }

  updateUI() {
    // Update current domain display
    const currentDomainSpan = document.getElementById("currentDomain");
    currentDomainSpan.textContent = this.currentDomain || "Invalid URL";

    // Update whitelist
    this.updateWhitelistUI();
  }

  updateWhitelistUI() {
    const whitelistItems = document.getElementById("whitelistItems");
    whitelistItems.innerHTML = "";

    this.settings.whitelist.forEach((domain) => {
      const li = document.createElement("li");
      li.className = "whitelist-item";
      li.innerHTML = `
        <span>${domain}</span>
        <button class="remove-domain" data-domain="${domain}">Remove</button>
      `;

      const removeBtn = li.querySelector(".remove-domain");
      removeBtn.addEventListener("click", () => {
        this.removeDomain(domain);
      });

      whitelistItems.appendChild(li);
    });

    // Update current site button
    if (this.currentDomain) {
      const toggleWhitelist = document.getElementById("toggleWhitelist");
      const isWhitelisted = this.settings.whitelist.includes(
        this.currentDomain
      );
      toggleWhitelist.textContent = isWhitelisted
        ? "Remove from Whitelist"
        : "Add to Whitelist";
    }
  }

  toggleCurrentDomainWhitelist() {
    if (!this.currentDomain) return;

    const index = this.settings.whitelist.indexOf(this.currentDomain);
    if (index > -1) {
      this.settings.whitelist.splice(index, 1);
    } else {
      this.settings.whitelist.push(this.currentDomain);
    }

    this.saveSettings();
    this.updateWhitelistUI();
  }

  removeDomain(domain) {
    const index = this.settings.whitelist.indexOf(domain);
    if (index > -1) {
      this.settings.whitelist.splice(index, 1);
      this.saveSettings();
      this.updateWhitelistUI();
    }
  }

  saveSettings() {
    chrome.runtime.sendMessage({
      action: "updateSettings",
      settings: this.settings,
    });
  }
}

// Initialize popup when DOM is loaded
document.addEventListener("DOMContentLoaded", () => {
  new PopupManager();
});
