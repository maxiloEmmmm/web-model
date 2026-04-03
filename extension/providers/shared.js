(function registerWebModelProviderShared(globalScope) {
  const { delay, estimateTokens, normalizeText } = globalScope.WEB_MODEL_HELPERS;
  const providerDefinitions = globalScope.WEB_MODEL_PROVIDER_DEFINITIONS instanceof Map
    ? globalScope.WEB_MODEL_PROVIDER_DEFINITIONS
    : new Map();

  function registerProvider(definition) {
    if (!definition || typeof definition !== "object" || !definition.type) {
      throw new Error("provider definition with a type is required");
    }
    providerDefinitions.set(definition.type, definition);
  }

  function listProviders() {
    return Array.from(providerDefinitions.values());
  }

  function isVisible(node) {
    // Hidden/background tabs often have unreliable layout boxes. In that case we only check
    // semantic visibility and skip strict width/height requirements.
    if (!(node instanceof Element)) {
      return false;
    }
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }
    if (node.getAttribute("aria-hidden") === "true" || node.hasAttribute("hidden")) {
      return false;
    }
    if (shouldUsePassiveDomReads()) {
      return true;
    }
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function shouldUsePassiveDomReads() {
    return document.visibilityState === "hidden" || !document.hasFocus();
  }

  function readNodeText(node) {
    // `innerText` can lag in background tabs. Prefer `textContent` there.
    if (!(node instanceof Node)) {
      return "";
    }
    if (shouldUsePassiveDomReads()) {
      return node.textContent || "";
    }
    if (node instanceof HTMLElement && typeof node.innerText === "string" && node.innerText) {
      return node.innerText;
    }
    return node.textContent || "";
  }

  function clickLikeUser(node) {
    // Dispatch a fuller pointer/mouse sequence because many sites do more than listen to `click`.
    if (!(node instanceof Element)) {
      return;
    }
    try {
      node.scrollIntoView({ block: "center", inline: "center" });
    } catch (_error) {
    }

    const events = [
      "pointerdown",
      "mousedown",
      "pointerup",
      "mouseup",
      "click"
    ];
    for (const eventType of events) {
      try {
        node.dispatchEvent(new MouseEvent(eventType, {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window
        }));
      } catch (_error) {
      }
    }

    if (typeof node.click === "function") {
      node.click();
    }
  }

  const REQUEST_ACTIVE_POLL_INTERVAL_MS = 10;

  function createActivityMonitor(rootNode, intervalMs = REQUEST_ACTIVE_POLL_INTERVAL_MS) {
    // DOM fallback reply detection uses both mutation wakeups and a short interval while a
    // request is active.
    const root = rootNode instanceof Node ? rootNode : document.body;
    const waiters = new Set();
    let intervalID = null;
    let observer = null;

    function emit() {
      if (!waiters.size) {
        return;
      }
      const pending = Array.from(waiters);
      waiters.clear();
      for (const finish of pending) {
        try {
          finish();
        } catch (_error) {
        }
      }
    }

    if (root instanceof Node) {
      try {
        observer = new MutationObserver(() => {
          emit();
        });
        observer.observe(root, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: ["class", "style", "aria-label", "data-testid", "disabled", "aria-disabled"]
        });
      } catch (_error) {
      }
    }

    intervalID = window.setInterval(() => {
      emit();
    }, intervalMs);

    return {
      next(timeoutMs = REQUEST_ACTIVE_POLL_INTERVAL_MS) {
        return new Promise((resolve) => {
          let settled = false;
          const timeoutID = window.setTimeout(() => {
            finish();
          }, timeoutMs);

          function finish() {
            if (settled) {
              return;
            }
            settled = true;
            window.clearTimeout(timeoutID);
            waiters.delete(finish);
            resolve();
          }

          waiters.add(finish);
        });
      },

      stop() {
        if (observer) {
          observer.disconnect();
          observer = null;
        }
        if (intervalID) {
          window.clearInterval(intervalID);
          intervalID = null;
        }
        emit();
      }
    };
  }

  globalScope.WEB_MODEL_PROVIDER_DEFINITIONS = providerDefinitions;
  globalScope.WEB_MODEL_PROVIDER_SHARED = {
    REQUEST_ACTIVE_POLL_INTERVAL_MS,
    clickLikeUser,
    createActivityMonitor,
    delay,
    estimateTokens,
    isVisible,
    listProviders,
    normalizeText,
    readNodeText,
    registerProvider
  };
})(typeof self !== "undefined" ? self : globalThis);
