// High-performance content script for instant image blurring
class ImageBlurFilter {
  constructor() {
    this.settings = null;
    this.isWhitelisted = false;
    this.observer = null;
    this.intersectionObserver = null;
    this.blurredElements = new Set();
    this.overlays = new Map();
    this.processingQueue = new Set();
    this.isProcessing = false;

    // Start initialization immediately
    this.init();
  }

  // CRITICAL: Inject CSS immediately to prevent any image flash
  injectPreBlurCSS() {
    const style = document.createElement("style");
    style.id = "blur-extension-preload";
    style.textContent = `
      img:not([data-blur-unblurred]):not([data-blur-processed]) {
        filter: blur(${this.settings?.blurIntensity || 10}px) !important;
        transition: filter 0.1s ease !important;
      }
    `;

    // Inject as early as possible
    if (document.head) {
      document.head.appendChild(style);
    } else {
      // If head doesn't exist yet, inject into document
      document.appendChild(style);
    }
  }

  async init() {
    // Get settings from background with caching
    this.settings = await this.getSettings();
    this.isWhitelisted = await this.checkWhitelist();

    // Remove or update pre-blur CSS based on settings
    if (!this.settings.enabled || this.isWhitelisted) {
      this.removePreBlurCSS();
      return;
    }

    // Update CSS with actual blur intensity from settings
    this.updatePreBlurCSS();

    // Process existing images in batches for better performance
    this.batchProcessExistingImages();

    // Set up optimized observers
    this.setupOptimizedObservers();

    // Listen for settings changes
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.settings) {
        this.handleSettingsChange(changes.settings.newValue);
      }
    });

    // Listen for messages from popup
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === "unblurAll") {
        this.removeAllBlurs();
      } else if (request.action === "updateBlurIntensity") {
        // Immediately update blur intensity for existing images
        this.settings.blurIntensity = request.intensity;
        this.updatePreBlurCSS();

        for (const element of this.blurredElements) {
          element.style.filter = `blur(${request.intensity}px)`;
        }
      }
    });
  }

  // Remove default blur CSS when extension is disabled or site is whitelisted
  removePreBlurCSS() {
    const style = document.createElement("style");
    style.id = "blur-extension-disable";
    style.textContent = `
      img:not([data-blur-unblurred]):not([data-blur-processed]) {
        filter: none !important;
      }
    `;

    if (document.head) {
      document.head.appendChild(style);
    }
  }

  // Update CSS with custom blur intensity
  updatePreBlurCSS() {
    // Remove any existing override
    const existingOverride = document.getElementById("blur-extension-override");
    if (existingOverride) {
      existingOverride.remove();
    }

    // Only add override if intensity is different from default (10px)
    if (this.settings && this.settings.blurIntensity !== 10) {
      const style = document.createElement("style");
      style.id = "blur-extension-override";
      style.textContent = `
        img:not([data-blur-unblurred]):not([data-blur-processed]) {
          filter: blur(${this.settings.blurIntensity}px) !important;
        }
      `;

      if (document.head) {
        document.head.appendChild(style);
      }
    }
  }

  getSettings() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "getSettings" }, (response) => {
        resolve(response);
      });
    });
  }

  checkWhitelist() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          action: "checkWhitelist",
          url: window.location.href,
        },
        (response) => {
          resolve(response.isWhitelisted);
        }
      );
    });
  }

  // Optimized batch processing for existing images
  batchProcessExistingImages() {
    // Use requestAnimationFrame for smooth processing
    const processInBatches = (elements, batchSize = 10) => {
      const batches = [];
      for (let i = 0; i < elements.length; i += batchSize) {
        batches.push(elements.slice(i, i + batchSize));
      }

      const processBatch = (batchIndex) => {
        if (batchIndex >= batches.length) return;

        batches[batchIndex].forEach((element) => {
          if (element.tagName === "IMG") {
            this.blurImage(element);
          } else {
            this.blurBackgroundImage(element);
          }
        });

        // Process next batch on next frame
        requestAnimationFrame(() => processBatch(batchIndex + 1));
      };

      processBatch(0);
    };

    // Get images
    const images = document.querySelectorAll("img");
    processInBatches(Array.from(images));

    // Get background images (more expensive, process separately)
    requestAnimationFrame(() => {
      const bgElements = this.getBackgroundImageElements();
      processInBatches(bgElements);
    });
  }

  // Optimized background image detection
  getBackgroundImageElements() {
    const elements = [];
    const treeWalker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode: (node) => {
          // Skip if already processed
          if (
            node.getAttribute("data-blur-bg-processed") ||
            node.getAttribute("data-blur-bg-unblurred")
          ) {
            return NodeFilter.FILTER_REJECT;
          }

          // Quick check for background image
          const bgImage = node.style.backgroundImage;
          if (bgImage && bgImage !== "none" && !bgImage.includes("data:")) {
            return NodeFilter.FILTER_ACCEPT;
          }

          return NodeFilter.FILTER_SKIP;
        },
      }
    );

    let node;
    while ((node = treeWalker.nextNode())) {
      elements.push(node);
    }

    return elements;
  }

  blurImage(img) {
    if (
      this.blurredElements.has(img) ||
      img.getAttribute("data-blur-processed") ||
      img.getAttribute("data-blur-unblurred") ||
      this.processingQueue.has(img)
    )
      return;

    // Skip if image has no meaningful src or is too small
    if (!this.isValidImage(img)) return;

    // Add to processing queue to prevent duplicate processing
    this.processingQueue.add(img);

    // Mark as processed immediately
    img.setAttribute("data-blur-processed", "true");

    // Apply blur (CSS already pre-applied, just ensure it's correct)
    img.style.filter = `blur(${this.settings.blurIntensity}px)`;
    img.style.transition = "filter 0.1s ease";

    // Create overlay asynchronously for performance
    requestAnimationFrame(() => {
      this.createImageOverlay(img);
      this.processingQueue.delete(img);
    });

    this.blurredElements.add(img);
  }

  // Optimized image validation
  isValidImage(img) {
    // Check if image has meaningful source
    if (!img.src && !img.srcset && !img.dataset.src) return false;

    // Use getBoundingClientRect for accurate size (faster than naturalWidth check)
    const rect = img.getBoundingClientRect();
    if (rect.width < 30 || rect.height < 30) return false;

    // Skip common UI elements
    const className = img.className.toLowerCase();
    const id = img.id.toLowerCase();
    const skipPatterns = ["icon", "logo", "avatar", "thumb", "button", "ui-"];

    for (const pattern of skipPatterns) {
      if (className.includes(pattern) || id.includes(pattern)) {
        return false;
      }
    }

    return true;
  }

  createImageOverlay(img) {
    // Skip if already has overlay or being processed
    if (this.overlays.has(img)) return;

    // Create overlay container
    const overlay = document.createElement("div");
    overlay.className = "blur-overlay";
    overlay.style.cssText = `
      position: absolute !important;
      top: 0 !important;
      left: 0 !important;
      right: 0 !important;
      bottom: 0 !important;
      pointer-events: none !important;
      opacity: 0 !important;
      transition: opacity 0.2s ease !important;
      z-index: 10000 !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
    `;

    // Create unblur button
    const unblurBtn = document.createElement("button");
    unblurBtn.className = "unblur-btn";
    unblurBtn.innerHTML = "👁️";
    unblurBtn.style.cssText = `
      background: rgba(0, 0, 0, 0.8) !important;
      color: white !important;
      border: none !important;
      padding: 8px 12px !important;
      border-radius: 50% !important;
      font-size: 16px !important;
      cursor: pointer !important;
      pointer-events: auto !important;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3) !important;
      transition: all 0.2s ease !important;
      min-width: 40px !important;
      min-height: 40px !important;
    `;

    // Optimized event handlers
    const mouseEnterHandler = () => {
      unblurBtn.style.background = "rgba(0, 0, 0, 0.9)";
      unblurBtn.style.transform = "scale(1.1)";
    };

    const mouseLeaveHandler = () => {
      unblurBtn.style.background = "rgba(0, 0, 0, 0.8)";
      unblurBtn.style.transform = "scale(1)";
    };

    const clickHandler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.unblurImage(img);
    };

    unblurBtn.addEventListener("mouseenter", mouseEnterHandler, {
      passive: true,
    });
    unblurBtn.addEventListener("mouseleave", mouseLeaveHandler, {
      passive: true,
    });
    unblurBtn.addEventListener("click", clickHandler);

    overlay.appendChild(unblurBtn);

    // Position overlay relative to image
    const wrapper = this.wrapImage(img);
    if (wrapper) {
      wrapper.appendChild(overlay);

      // Optimized hover handlers
      const showOverlay = () => (overlay.style.opacity = "1");
      const hideOverlay = () => (overlay.style.opacity = "0");

      wrapper.addEventListener("mouseenter", showOverlay, { passive: true });
      wrapper.addEventListener("mouseleave", hideOverlay, { passive: true });

      this.overlays.set(img, { overlay, wrapper, showOverlay, hideOverlay });
    }
  }

  wrapImage(img) {
    // Check if already wrapped
    if (
      img.parentElement &&
      img.parentElement.classList.contains("blur-wrapper")
    ) {
      return img.parentElement;
    }

    // Don't wrap if parent can't contain absolute positioning
    const parent = img.parentElement;
    if (!parent) return null;

    const wrapper = document.createElement("div");
    wrapper.className = "blur-wrapper";
    wrapper.style.cssText = `
      position: relative !important;
      display: inline-block !important;
      max-width: 100% !important;
      line-height: 0 !important;
    `;

    // Insert wrapper efficiently
    parent.insertBefore(wrapper, img);
    wrapper.appendChild(img);

    return wrapper;
  }

  unblurImage(img) {
    if (!this.blurredElements.has(img)) return;

    // Mark as intentionally unblurred
    img.setAttribute("data-blur-unblurred", "true");
    img.removeAttribute("data-blur-processed");

    // Remove blur immediately
    img.style.filter = "none";

    // Clean up overlay
    const overlayData = this.overlays.get(img);
    if (overlayData) {
      const {
        wrapper,
        overlay,
        showOverlay,
        hideOverlay,
        mouseEnterHandler,
        mouseLeaveHandler,
        clickHandler,
      } = overlayData;

      // Remove all event listeners for memory efficiency
      if (wrapper) {
        wrapper.removeEventListener("mouseenter", showOverlay);
        wrapper.removeEventListener("mouseleave", hideOverlay);

        // Unwrap image
        if (wrapper.parentNode) {
          wrapper.parentNode.insertBefore(img, wrapper);
          wrapper.remove();
        }
      }

      // Remove button event listeners
      const unblurBtn = overlay.querySelector(".unblur-btn");
      if (unblurBtn) {
        unblurBtn.removeEventListener("mouseenter", mouseEnterHandler);
        unblurBtn.removeEventListener("mouseleave", mouseLeaveHandler);
        unblurBtn.removeEventListener("click", clickHandler);
      }

      overlay.remove();
      this.overlays.delete(img);
    }

    this.blurredElements.delete(img);
  }

  blurBackgroundImage(element) {
    if (
      this.blurredElements.has(element) ||
      element.getAttribute("data-blur-bg-processed") ||
      element.getAttribute("data-blur-bg-unblurred") ||
      this.processingQueue.has(element)
    )
      return;

    // Quick validation
    const rect = element.getBoundingClientRect();
    if (rect.width < 50 || rect.height < 50) return;

    this.processingQueue.add(element);

    element.setAttribute("data-blur-bg-processed", "true");
    element.style.filter = `blur(${this.settings.blurIntensity}px)`;
    element.style.transition = "filter 0.1s ease";

    // Create overlay asynchronously
    requestAnimationFrame(() => {
      this.createBackgroundOverlay(element);
      this.processingQueue.delete(element);
    });

    this.blurredElements.add(element);
  }

  createBackgroundOverlay(element) {
    if (this.overlays.has(element)) return;

    const overlay = document.createElement("div");
    overlay.className = "blur-bg-overlay";
    overlay.style.cssText = `
      position: absolute !important;
      top: 0 !important;
      left: 0 !important;
      right: 0 !important;
      bottom: 0 !important;
      pointer-events: none !important;
      opacity: 0 !important;
      transition: opacity 0.2s ease !important;
      z-index: 10000 !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
    `;

    const unblurBtn = document.createElement("button");
    unblurBtn.className = "unblur-bg-btn";
    unblurBtn.innerHTML = "👁️";
    unblurBtn.style.cssText = `
      background: rgba(0, 0, 0, 0.8) !important;
      color: white !important;
      border: none !important;
      padding: 8px 12px !important;
      border-radius: 50% !important;
      font-size: 16px !important;
      cursor: pointer !important;
      pointer-events: auto !important;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3) !important;
      transition: all 0.2s ease !important;
      min-width: 40px !important;
      min-height: 40px !important;
    `;

    // Optimized event handlers
    const mouseEnterHandler = () => {
      unblurBtn.style.background = "rgba(0, 0, 0, 0.9)";
      unblurBtn.style.transform = "scale(1.1)";
    };

    const mouseLeaveHandler = () => {
      unblurBtn.style.background = "rgba(0, 0, 0, 0.8)";
      unblurBtn.style.transform = "scale(1)";
    };

    const clickHandler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.unblurBackgroundImage(element);
    };

    unblurBtn.addEventListener("mouseenter", mouseEnterHandler, {
      passive: true,
    });
    unblurBtn.addEventListener("mouseleave", mouseLeaveHandler, {
      passive: true,
    });
    unblurBtn.addEventListener("click", clickHandler);

    overlay.appendChild(unblurBtn);

    // Ensure element has relative positioning
    const originalPosition = getComputedStyle(element).position;
    if (originalPosition === "static") {
      element.style.position = "relative";
    }

    element.appendChild(overlay);

    // Optimized hover handlers
    const showOverlay = () => (overlay.style.opacity = "1");
    const hideOverlay = () => (overlay.style.opacity = "0");

    element.addEventListener("mouseenter", showOverlay, { passive: true });
    element.addEventListener("mouseleave", hideOverlay, { passive: true });

    this.overlays.set(element, {
      overlay,
      isBackground: true,
      showOverlay,
      hideOverlay,
    });
  }

  unblurBackgroundImage(element) {
    if (!this.blurredElements.has(element)) return;

    // Mark as intentionally unblurred
    element.setAttribute("data-blur-bg-unblurred", "true");
    element.removeAttribute("data-blur-bg-processed");

    element.style.filter = "none";

    const overlayData = this.overlays.get(element);
    if (overlayData) {
      const {
        overlay,
        showOverlay,
        hideOverlay,
        mouseEnterHandler,
        mouseLeaveHandler,
        clickHandler,
      } = overlayData;

      // Remove event listeners from element
      element.removeEventListener("mouseenter", showOverlay);
      element.removeEventListener("mouseleave", hideOverlay);

      // Remove button event listeners
      const unblurBtn = overlay.querySelector(".unblur-bg-btn");
      if (unblurBtn) {
        unblurBtn.removeEventListener("mouseenter", mouseEnterHandler);
        unblurBtn.removeEventListener("mouseleave", mouseLeaveHandler);
        unblurBtn.removeEventListener("click", clickHandler);
      }

      overlay.remove();
      this.overlays.delete(element);
    }

    this.blurredElements.delete(element);
  }

  // Highly optimized observers with throttling
  setupOptimizedObservers() {
    // Throttled mutation observer
    let mutationTimeout;
    this.observer = new MutationObserver((mutations) => {
      // Throttle mutations for better performance
      clearTimeout(mutationTimeout);
      mutationTimeout = setTimeout(() => {
        this.processMutations(mutations);
      }, 50);
    });

    // Start observing with optimized settings
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "srcset", "data-src", "style"],
      attributeOldValue: false,
    });

    // Optimized intersection observer for lazy loading
    this.intersectionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.target.tagName === "IMG") {
            if (
              !entry.target.getAttribute("data-blur-processed") &&
              !entry.target.getAttribute("data-blur-unblurred")
            ) {
              this.blurImage(entry.target);
            }
          }
        }
      },
      {
        rootMargin: "50px", // Start processing slightly before image enters viewport
      }
    );

    // Observe all images
    document.querySelectorAll("img").forEach((img) => {
      this.intersectionObserver.observe(img);
    });

    // Reduced frequency fallback check
    setInterval(() => {
      this.fallbackImageCheck();
    }, 3000);
  }

  // Optimized mutation processing
  processMutations(mutations) {
    const imagesToProcess = new Set();
    const elementsToCheck = new Set();

    for (const mutation of mutations) {
      // Handle added nodes efficiently
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.tagName === "IMG") {
            imagesToProcess.add(node);
          } else if (node.querySelectorAll) {
            // Batch collect images
            const images = node.querySelectorAll("img");
            for (const img of images) {
              imagesToProcess.add(img);
            }
            elementsToCheck.add(node);
          }
        }
      }

      // Handle attribute changes efficiently
      if (mutation.type === "attributes") {
        const target = mutation.target;
        if (
          mutation.attributeName === "src" ||
          mutation.attributeName === "srcset" ||
          mutation.attributeName === "data-src"
        ) {
          if (target.tagName === "IMG") {
            imagesToProcess.add(target);
          }
        }
      }
    }

    // Process collected images
    for (const img of imagesToProcess) {
      if (
        !img.getAttribute("data-blur-processed") &&
        !img.getAttribute("data-blur-unblurred")
      ) {
        this.blurImage(img);
        this.intersectionObserver.observe(img);
      }
    }

    // Check for background images in new elements
    if (elementsToCheck.size > 0) {
      requestAnimationFrame(() => {
        for (const element of elementsToCheck) {
          this.checkElementForBackgroundImages(element);
        }
      });
    }
  }

  // Optimized background image checking
  checkElementForBackgroundImages(element) {
    if (
      !element.getAttribute("data-blur-bg-processed") &&
      !element.getAttribute("data-blur-bg-unblurred")
    ) {
      const style =
        element.style.backgroundImage ||
        getComputedStyle(element).backgroundImage;
      if (
        style &&
        style !== "none" &&
        !style.includes("data:") &&
        !style.includes("gradient")
      ) {
        this.blurBackgroundImage(element);
      }
    }

    // Check immediate children only (not deep traversal for performance)
    for (const child of element.children || []) {
      this.checkElementForBackgroundImages(child);
    }
  }

  // Lightweight fallback check
  fallbackImageCheck() {
    // Only check images that might have been missed
    const uncheckedImages = document.querySelectorAll(
      "img:not([data-blur-processed]):not([data-blur-unblurred])"
    );

    if (uncheckedImages.length > 0) {
      // Process in small batches to avoid blocking
      let index = 0;
      const processBatch = () => {
        const batchEnd = Math.min(index + 5, uncheckedImages.length);
        for (let i = index; i < batchEnd; i++) {
          this.blurImage(uncheckedImages[i]);
        }
        index = batchEnd;

        if (index < uncheckedImages.length) {
          requestAnimationFrame(processBatch);
        }
      };
      processBatch();
    }
  }

  handleSettingsChange(newSettings) {
    this.settings = newSettings;

    // Remove any existing overrides first
    const existingDisable = document.getElementById("blur-extension-disable");
    const existingOverride = document.getElementById("blur-extension-override");
    if (existingDisable) existingDisable.remove();
    if (existingOverride) existingOverride.remove();

    if (!newSettings.enabled) {
      this.removeAllBlurs();
      this.removePreBlurCSS();
      return;
    }

    // Update CSS with new intensity
    this.updatePreBlurCSS();

    // Re-check whitelist
    this.checkWhitelist().then((isWhitelisted) => {
      this.isWhitelisted = isWhitelisted;
      if (isWhitelisted) {
        this.removeAllBlurs();
        this.removePreBlurCSS();
      } else {
        // Update existing blurred images with new intensity
        for (const element of this.blurredElements) {
          element.style.filter = `blur(${newSettings.blurIntensity}px)`;
        }

        // Re-process images if needed
        this.batchProcessExistingImages();
      }
    });
  }

  removeAllBlurs() {
    // Clean up observers first
    if (this.observer) {
      this.observer.disconnect();
    }
    if (this.intersectionObserver) {
      this.intersectionObserver.disconnect();
    }

    // Clean up CSS overrides
    const existingDisable = document.getElementById("blur-extension-disable");
    const existingOverride = document.getElementById("blur-extension-override");
    if (existingDisable) existingDisable.remove();
    if (existingOverride) existingOverride.remove();

    // Efficiently remove all blurs
    for (const element of this.blurredElements) {
      element.style.filter = "none";
      element.removeAttribute("data-blur-processed");
      element.removeAttribute("data-blur-bg-processed");
      element.removeAttribute("data-blur-unblurred");
      element.removeAttribute("data-blur-bg-unblurred");

      // Clean up overlays with all event listeners
      const overlayData = this.overlays.get(element);
      if (overlayData) {
        const {
          overlay,
          wrapper,
          showOverlay,
          hideOverlay,
          mouseEnterHandler,
          mouseLeaveHandler,
          clickHandler,
        } = overlayData;

        // Remove wrapper event listeners
        if (wrapper) {
          wrapper.removeEventListener("mouseenter", showOverlay);
          wrapper.removeEventListener("mouseleave", hideOverlay);

          // Unwrap images
          if (wrapper.parentNode) {
            wrapper.parentNode.insertBefore(element, wrapper);
            wrapper.remove();
          }
        } else if (showOverlay && hideOverlay) {
          // Background image element listeners
          element.removeEventListener("mouseenter", showOverlay);
          element.removeEventListener("mouseleave", hideOverlay);
        }

        // Remove button event listeners
        const unblurBtn = overlay.querySelector(".unblur-btn, .unblur-bg-btn");
        if (
          unblurBtn &&
          mouseEnterHandler &&
          mouseLeaveHandler &&
          clickHandler
        ) {
          unblurBtn.removeEventListener("mouseenter", mouseEnterHandler);
          unblurBtn.removeEventListener("mouseleave", mouseLeaveHandler);
          unblurBtn.removeEventListener("click", clickHandler);
        }

        overlay.remove();
      }
    }

    // Clear remaining unblurred elements
    const unblurredElements = document.querySelectorAll(
      "[data-blur-unblurred], [data-blur-bg-unblurred]"
    );
    for (const element of unblurredElements) {
      element.removeAttribute("data-blur-unblurred");
      element.removeAttribute("data-blur-bg-unblurred");
    }

    this.blurredElements.clear();
    this.overlays.clear();
    this.processingQueue.clear();
  }
}

// Initialize immediately for fastest possible blurring
const blurFilter = new ImageBlurFilter();
