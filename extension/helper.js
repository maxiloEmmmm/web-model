(function registerWebModelHelpers(globalScope) {
  if (globalScope.WEB_MODEL_HELPERS) {
    return;
  }

  let debugEnabled = resolveInitialDebugEnabled();

  function resolveInitialDebugEnabled() {
    if (globalScope.WEB_MODEL_DEBUG === true || globalScope.__WEB_MODEL_DEBUG__ === true) {
      return true;
    }
    if (typeof document === "undefined" || typeof document.currentScript === "undefined") {
      return false;
    }
    return document.currentScript?.dataset?.webModelDebug === "true";
  }

  function padNumber(value, width) {
    return String(value).padStart(width, "0");
  }

  function formatLogTime() {
    const now = new Date();
    return `${padNumber(now.getHours(), 2)}:${padNumber(now.getMinutes(), 2)}:${padNumber(now.getSeconds(), 2)}.${padNumber(now.getMilliseconds(), 3)}`;
  }

  function createLogger(prefix, context = "") {
    return function log(...args) {
      if (!debugEnabled) {
        return;
      }
      if (context) {
        console.log(prefix, formatLogTime(), context, ...args);
        return;
      }
      console.log(prefix, formatLogTime(), ...args);
    };
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function clipText(value, maxLength = 240) {
    const text = String(value || "");
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
  }

  function delay(ms) {
    return new Promise((resolve) => globalScope.setTimeout(resolve, ms));
  }

  function estimateTokens(value) {
    return Math.max(1, Math.ceil(String(value || "").length / 4));
  }

  function isDebugEnabled() {
    return debugEnabled;
  }

  function setDebugEnabled(value) {
    debugEnabled = value === true;
    globalScope.WEB_MODEL_DEBUG = debugEnabled;
    globalScope.__WEB_MODEL_DEBUG__ = debugEnabled;
  }

  if (typeof window !== "undefined" && globalScope === window) {
    window.addEventListener("message", (event) => {
      if (event.source !== window) {
        return;
      }
      if (event.data?.source !== "web-model-debug-control") {
        return;
      }
      if (event.data?.payload?.type !== "debug.set") {
        return;
      }
      setDebugEnabled(!!event.data.payload.enabled);
    });
  }

  globalScope.WEB_MODEL_HELPERS = {
    clipText,
    createLogger,
    delay,
    estimateTokens,
    formatLogTime,
    isDebugEnabled,
    normalizeText,
    setDebugEnabled
  };
})(typeof self !== "undefined" ? self : globalThis);
