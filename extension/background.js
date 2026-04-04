// 扩展后台脚本。
//
// 这是插件运行时的总控层，负责：
// - 维护每个 tab 的状态
// - 维护到本地 server 的 websocket 注册
// - 处理 popup 的开关和配置修改
// - 在需要时给目标 tab 注入 content script
//
// 这里不写任何 provider 页面 DOM 细节。
// 页面细节全部留给：
// - content.js：负责执行页面动作
// - providers/*.js：负责每个 provider 的 DOM 适配
//
// 整个消息链可以理解成：
// popup -> background -> content -> provider 页面
//                      -> websocket -> 本地 server
//
// background 是唯一同时看见“扩展内部状态”和“本地 server 状态”的一层，
// 所以所有状态机、重连、注册、注入判断都应当集中放这里。
const PROVIDER_SCRIPT_FILES = [
  "providers/shared.js",
  "providers/qwen.js",
  "providers/chatgpt.js",
  "providers/gemini.js",
  "providers/kimi.js",
  "providers/yuanbao.js",
  "providers.js"
];

importScripts("helper.js", ...PROVIDER_SCRIPT_FILES);

const WEB_MODEL_EXTENSION_VERSION = "bg-2026-04-03-029";
const { createLogger, setDebugEnabled } = globalThis.WEB_MODEL_HELPERS;

const DEFAULT_CONFIG = {
  serverUrl: "ws://127.0.0.1:18080/ws",
  debugLogs: false
};
let runtimeConfig = { ...DEFAULT_CONFIG };

// 每个浏览器 tab 都对应一个后台 session。
// 这个 session 不是 provider 自己的会话，而是 background 维护的“这个 tab 当前状态”。
// 这样即使页面 port 或 websocket 短暂断开，popup 仍然有稳定状态可以展示。
const tabSessions = new Map();
const providerSequences = new Map();
let missingScriptingLogged = false;
const log = createLogger("[web-model:bg]");
const ACTION_BADGE_COLORS = {
  connected: "#1f9d55",
  connecting: "#c98a00",
  error: "#c53030"
};
const SOCKET_HEARTBEAT_INTERVAL_MS = 15000;
const SOCKET_HEARTBEAT_TIMEOUT_MS = 45000;
const TAB_HEARTBEAT_INTERVAL_MS = 15000;
const TAB_HEARTBEAT_TIMEOUT_MS = 45000;
const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
let offscreenReady = null;

function hasScriptingAPI() {
  return !!(chrome.scripting && typeof chrome.scripting.executeScript === "function");
}

function logMissingScriptingOnce(context = "") {
  if (missingScriptingLogged) {
    return;
  }
  missingScriptingLogged = true;
  console.warn(
    "[web-model:bg] chrome.scripting is unavailable; existing tabs must be refreshed to activate content scripts",
    context
  );
}

function updateActionIndicator(session) {
  if (!chrome.action || typeof session?.tabId !== "number") {
    return;
  }

  let text = "";
  let color = null;
  let title = "web-model";

  if (session.state === "connected") {
    text = "ON";
    color = ACTION_BADGE_COLORS.connected;
    title = `web-model: ${session.provider?.type || "provider"} registered`;
  } else if (session.state === "connecting" || session.state === "waiting_page") {
    text = "...";
    color = ACTION_BADGE_COLORS.connecting;
    title = `web-model: ${session.detail || "waiting"}`;
  } else if (session.state === "error") {
    text = "!";
    color = ACTION_BADGE_COLORS.error;
    title = `web-model: ${session.lastError || session.detail || "error"}`;
  } else if (session.state === "unsupported") {
    title = "web-model: unsupported page";
  } else {
    title = "web-model";
  }

  chrome.action.setBadgeText({
    tabId: session.tabId,
    text
  }).catch(() => {
  });

  if (color) {
    chrome.action.setBadgeBackgroundColor({
      tabId: session.tabId,
      color
    }).catch(() => {
    });
  }

  chrome.action.setTitle({
    tabId: session.tabId,
    title
  }).catch(() => {
  });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "web-model-offscreen-keepalive") {
    log("offscreen keepalive connected");
    port.onMessage.addListener(() => {
    });
    port.onDisconnect.addListener(() => {
      log("offscreen keepalive disconnected");
    });
    return;
  }

  // Only provider page bridges should connect here.
  if (port.name !== "web-model-provider-page") {
    return;
  }

  const tabId = port.sender?.tab?.id;
  if (typeof tabId !== "number") {
    console.error("[web-model:bg] missing tab id for content port");
    port.disconnect();
    return;
  }

  const session = ensureSession(tabId);
  session.port = port;
  session.page = {
    url: port.sender?.tab?.url || "",
    title: port.sender?.tab?.title || "",
    tabId
  };
  session.provider = resolveProviderForSession(session);
  updateSessionState(session);
  startTabHeartbeat(session);

  log("content script connected", `tab=${tabId}`, session.provider?.type || "unknown", `enabled=${session.enabled}`);

  readConfig().then((config) => {
    port.postMessage({
      type: "debug.set",
      enabled: !!config.debugLogs
    });
  }).catch((error) => {
    console.error("[web-model:bg] read config for debug sync failed", error);
  });

  port.onMessage.addListener((message) => {
    handlePortMessage(tabId, message).catch((error) => {
      console.error("[web-model:bg] port message error", `tab=${tabId}`, error);
    });
  });

  port.onDisconnect.addListener(() => {
    const current = tabSessions.get(tabId);
    if (current && current.port === port) {
      log("content script disconnected", `tab=${tabId}`);
      clearTabHeartbeat(current);
      current.port = null;
      if (current.enabled) {
        current.state = "waiting_page";
        current.detail = "provider page reconnecting";
      }
      updateSessionState(current);
    }
  });

  hydrateSessionEnabledState(session).catch((error) => {
    console.error("[web-model:bg] hydrate session failed", `tab=${tabId}`, error);
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const tabId = normalizeTabID(message?.tabId);

  if (message?.type === "offscreen.keepalive") {
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "config.updated") {
    onConfigUpdated().then(async () => {
      const config = await readConfig();
      sendResponse(await buildStatus(config, tabId));
    }).catch((error) => {
      console.error("[web-model:bg] config update error", error);
      sendResponse({
        ok: false,
        error: String(error)
      });
    });
    return true;
  }

  if (message?.type === "connection.status") {
    readConfig().then(async (config) => {
      sendResponse(await buildStatus(config, tabId));
    }).catch((error) => {
      sendResponse({
        ok: false,
        error: String(error)
      });
    });
    return true;
  }

  if (message?.type === "provider.toggle") {
    setTabEnabled(tabId, !!message.enabled).then(async () => {
      const config = await readConfig();
      const session = ensureSession(tabId);
      session.enabled = !!message.enabled;
      if (!session.enabled) {
        clearTabHeartbeat(session);
        clearRetryTimer(session);
        closeSessionSocket(session, "disabled by user");
      } else if (typeof tabId === "number") {
        const needsInjection = !session.port;
        if (session.provider) {
          session.currentProviderKey = ensureProviderKey(session);
          if (!needsInjection) {
            scheduleReconnect(session, "enabled by user");
          }
        }

        const injected = needsInjection
          ? await ensureContentScriptInjectedForTab(tabId, session.page?.url || "")
          : true;
        if (!injected) {
          session.state = "waiting_page";
          session.detail = "refresh this tab to activate";
        } else if (session.provider && session.port) {
          scheduleReconnect(session, "enabled by user");
        }
      }
      updateSessionState(session);
      sendResponse(await buildStatus(config, tabId));
    }).catch((error) => {
      sendResponse({
        ok: false,
        error: String(error)
      });
    });
    return true;
  }

  return false;
});

async function handlePortMessage(tabId, message) {
  if (!message || typeof message !== "object") {
    return;
  }

  const session = ensureSession(tabId);

  if (message.type === "page.ready") {
    // `page.ready` is the authoritative signal that the page script is alive and has already
    // detected which provider adapter matches the current URL.
    session.page = {
      url: message.url || session.page?.url || "",
      title: message.title || session.page?.title || "",
      tabId
    };
    const previousProviderType = session.provider?.type || "";
    session.provider = resolveProviderForSession(session);
    if (!session.provider) {
      updateSessionState(session);
      return;
    }
    if (!session.currentProviderKey || previousProviderType !== session.provider.type || shouldRegenerateProviderKey(session.provider, session.currentProviderKey, session.tabId)) {
      session.currentProviderKey = generateProviderKey(session.provider, session.tabId);
    }
    log("page ready", `tab=${tabId}`, session.page.url, session.provider.type, session.currentProviderKey);
    updateSessionState(session);
    if (session.enabled) {
      scheduleReconnect(session, "page ready");
    }
    return;
  }

  if (message.type === "ping") {
    // Heartbeat is only a liveness/status signal, not chat payload.
    session.page = {
      url: message.url || session.page?.url || "",
      title: message.title || session.page?.title || "",
      tabId
    };
    if (!session.provider) {
      session.provider = resolveProviderForSession(session);
    }
    updateSessionState(session);
    if (session.enabled && session.provider && !session.port) {
      session.state = "waiting_page";
      session.detail = "provider page reconnecting";
    }
    if (session.enabled && session.provider && !session.socket && session.port) {
      scheduleReconnect(session, "heartbeat");
    }
    try {
      session.port?.postMessage({
        type: "pong",
        at: Date.now()
      });
    } catch (_error) {
    }
    return;
  }

  if (message.type === "pong") {
    session.lastTabPongAt = Date.now();
    return;
  }


  if (message.type === "chat.done") {
    // Forward success to the local server. `startedNewChat` is important because the server
    // counts chats per provider key and needs to know when a fresh conversation started.
    session.lastError = "";
    if (session.socket?.readyState === WebSocket.OPEN && session.helloAcked) {
      session.state = "connected";
      session.detail = `${session.provider?.type || "provider"} registered`;
    }
    log("chat done", `tab=${tabId}`, message.requestId, `startedNewChat=${!!message.startedNewChat}`);
    sendToServer(session, {
      type: "chat.done",
      request_id: message.requestId,
      started_new_chat: !!message.startedNewChat,
      message: message.message,
      prompt_tokens: message.promptTokens || 0,
      completion_tokens: message.completionTokens || 0
    });
    return;
  }

  if (message.type === "chat.delta") {
    sendToServer(session, {
      type: "chat.delta",
      request_id: message.requestId,
      delta: message.delta || ""
    });
    return;
  }

  if (message.type === "chat.error") {
    session.lastError = message.error || "";
    if (session.socket?.readyState === WebSocket.OPEN && session.helloAcked) {
      session.state = "connected";
      session.detail = `${session.provider?.type || "provider"} registered`;
    } else {
      session.state = "disconnected";
      session.detail = "waiting to connect";
      scheduleReconnect(session, "chat error");
    }
    log("chat error", `tab=${tabId}`, message.requestId, `startedNewChat=${!!message.startedNewChat}`, message.error);
    sendToServer(session, {
      type: "chat.error",
      request_id: message.requestId,
      started_new_chat: !!message.startedNewChat,
      error: message.error || "unknown content-script error"
    });
  }
}

async function connectTab(tabId, reason = "auto connect") {
  // Open or reopen the websocket registration for one enabled tab/provider page.
  if (typeof tabId !== "number") {
    return { ok: false, error: "active provider tab not found" };
  }

  const config = await readConfig();
  const session = ensureSession(tabId);
  session.provider = resolveProviderForSession(session);

  if (!session.enabled) {
    updateSessionState(session);
    return {
      ok: false,
      error: "provider registration is disabled for this tab"
    };
  }

  if (!session.provider) {
    updateSessionState(session);
    return {
      ok: false,
      error: "current tab is not a supported provider page"
    };
  }

  if (!session.port || !session.page?.url) {
    updateSessionState(session);
    return {
      ok: false,
      error: "current tab is not ready"
    };
  }

  if (session.socket && (session.socket.readyState === WebSocket.OPEN || session.socket.readyState === WebSocket.CONNECTING)) {
    return buildStatus(config, tabId);
  }

  clearRetryTimer(session);
  closeSessionSocket(session, reason);

  session.currentProviderKey = ensureProviderKey(session);

  session.lastError = "";
  session.state = "connecting";
  session.detail = `${config.serverUrl} | ${reason}`;

  log("connecting websocket", `tab=${tabId}`, config.serverUrl, session.currentProviderKey, session.provider.type);
  const socket = new WebSocket(config.serverUrl);
  session.socket = socket;

  socket.addEventListener("open", () => {
    if (session.socket !== socket) {
      return;
    }
    log("websocket open", `tab=${tabId}`);
    sendToServer(session, {
      type: "hello",
      key: session.currentProviderKey,
      provider_type: session.provider.type,
      display_name: session.provider.displayName,
      description: session.provider.description,
      homepage: session.provider.homepage,
      tags: ["extension", browserTag(), session.provider.type],
      page_url: session.page?.url || "",
      page_title: session.page?.title || ""
    });
  });

  socket.addEventListener("message", (event) => {
    if (session.socket !== socket) {
      return;
    }
    try {
      const payload = JSON.parse(event.data);
      onSocketMessage(session, payload);
    } catch (error) {
      console.error("[web-model:bg] socket decode error", `tab=${tabId}`, error);
    }
  });

  socket.addEventListener("close", () => {
    if (session.socket !== socket) {
      return;
    }
    log("websocket close", `tab=${tabId}`);
    clearSocketHeartbeat(session);
    session.socket = null;
    session.helloAcked = false;
    session.lastSocketPongAt = 0;
    if (session.state !== "error") {
      session.state = "disconnected";
      session.detail = "socket closed";
    }
    scheduleReconnect(session, "socket closed");
  });

  socket.addEventListener("error", (error) => {
    if (session.socket !== socket) {
      return;
    }
    console.error("[web-model:bg] socket error", `tab=${tabId}`, error);
    clearSocketHeartbeat(session);
    session.lastError = "websocket error";
    session.state = "error";
    session.detail = "websocket error";
    scheduleReconnect(session, "websocket error");
  });

  return buildStatus(config, tabId);
}

function onSocketMessage(session, payload) {
  if (!payload || typeof payload !== "object") {
    return;
  }

  if (payload.type === "hello.ack") {
    session.helloAcked = true;
    session.currentProviderKey = payload.key || session.currentProviderKey;
    session.lastSocketPongAt = Date.now();
    startSocketHeartbeat(session);
    session.state = "connected";
    session.detail = `${session.provider?.type || "provider"} registered`;
    log("provider registered", `tab=${session.tabId}`, session.currentProviderKey);
    return;
  }

  if (payload.type === "pong") {
    session.lastSocketPongAt = Date.now();
    return;
  }

  if (payload.type === "chat.request") {
    // Server chose this provider key for a request. Background forwards both the request and the
    // "new chat before send" instruction to the page bridge.
    if (!session.port) {
      session.lastError = "no active provider tab";
      session.state = "error";
      session.detail = "no active provider tab";
      sendToServer(session, {
        type: "chat.error",
        request_id: payload.request_id,
        error: "no active provider tab"
      });
      return;
    }

    log(
      "chat request",
      `tab=${session.tabId}`,
      payload.request_id,
      session.provider?.type || "",
      `startNewChatBeforeSend=${!!payload.start_new_chat_before_send}`
    );
    if (payload.start_new_chat_before_send) {
      log(
        "server requested new chat before send",
        `tab=${session.tabId}`,
        payload.request_id,
        session.provider?.type || "",
        session.currentProviderKey || "pending-key"
      );
    }
    session.port.postMessage({
      type: "chat.request",
      providerType: session.provider?.type || "",
      startNewChatBeforeSend: !!payload.start_new_chat_before_send,
      requestId: payload.request_id,
      request: payload.request
    });
    return;
  }

  if (payload.type === "error") {
    session.lastError = payload.message || "server rejected registration";
    session.state = "error";
    session.detail = session.lastError;
    console.error("[web-model:bg] server rejected extension registration", `tab=${session.tabId}`, payload.message || payload);
  }
}

function sendToServer(session, payload) {
  // Background is the only place that talks to the local websocket server directly.
  if (!session.socket || session.socket.readyState !== WebSocket.OPEN) {
    log("drop outbound payload: socket not open", `tab=${session.tabId}`, payload.type);
    return;
  }
  session.socket.send(JSON.stringify(payload));
}

function closeSessionSocket(session, reason = "") {
  clearSocketHeartbeat(session);
  if (session.socket) {
    log("closing websocket", `tab=${session.tabId}`, reason);
    try {
      session.socket.close();
    } catch (_error) {
    }
    session.socket = null;
  }
  session.helloAcked = false;
  session.lastSocketPongAt = 0;
}

function startSocketHeartbeat(session) {
  clearSocketHeartbeat(session);
  session.lastSocketPongAt = Date.now();
  session.socketHeartbeatTimer = setInterval(() => {
    if (!session.socket || session.socket.readyState !== WebSocket.OPEN || !session.helloAcked) {
      return;
    }
    if (session.lastSocketPongAt && Date.now() - session.lastSocketPongAt > SOCKET_HEARTBEAT_TIMEOUT_MS) {
      log("socket heartbeat timeout", `tab=${session.tabId}`, session.currentProviderKey || "");
      clearSocketHeartbeat(session);
      session.lastError = "heartbeat timeout";
      session.state = "disconnected";
      session.detail = "heartbeat timeout";
      try {
        session.socket.close();
      } catch (_error) {
      }
      return;
    }
    sendToServer(session, {
      type: "ping",
      at: Date.now()
    });
  }, SOCKET_HEARTBEAT_INTERVAL_MS);
}

function clearSocketHeartbeat(session) {
  if (!session?.socketHeartbeatTimer) {
    return;
  }
  clearInterval(session.socketHeartbeatTimer);
  session.socketHeartbeatTimer = null;
}

function startTabHeartbeat(session) {
  clearTabHeartbeat(session);
  if (!session?.port) {
    return;
  }
  session.lastTabPongAt = Date.now();
  session.tabHeartbeatTimer = setInterval(() => {
    if (!session.port) {
      return;
    }
    if (session.lastTabPongAt && Date.now() - session.lastTabPongAt > TAB_HEARTBEAT_TIMEOUT_MS) {
      log("tab heartbeat timeout", `tab=${session.tabId}`, session.currentProviderKey || "");
      clearTabHeartbeat(session);
      try {
        session.port.disconnect();
      } catch (_error) {
      }
      return;
    }
    try {
      session.port.postMessage({
        type: "ping",
        at: Date.now()
      });
    } catch (_error) {
    }
  }, TAB_HEARTBEAT_INTERVAL_MS);
}

function clearTabHeartbeat(session) {
  if (!session?.tabHeartbeatTimer) {
    return;
  }
  clearInterval(session.tabHeartbeatTimer);
  session.tabHeartbeatTimer = null;
}

function scheduleReconnect(session, reason) {
  // Reconnect is serialized through one timer per tab session to avoid reconnect storms.
  if (session.retryTimer || !session.provider || !session.enabled) {
    return;
  }
  if (!session.port || !session.page?.url) {
    updateSessionState(session);
    return;
  }

  session.state = "connecting";
  session.detail = `${reason}; retry in 1s`;
  session.retryTimer = setTimeout(() => {
    session.retryTimer = null;
    connectTab(session.tabId, "auto reconnect").catch((error) => {
      session.lastError = String(error);
      session.state = "error";
      session.detail = String(error);
      scheduleReconnect(session, "retry failed");
    });
  }, 1000);
}

function clearRetryTimer(session) {
  if (!session.retryTimer) {
    return;
  }
  clearTimeout(session.retryTimer);
  session.retryTimer = null;
}

function ensureSession(tabId) {
  // Lazily create tab state the first time the tab is seen by background.
  let session = tabSessions.get(tabId);
  if (!session) {
    session = {
      tabId,
      port: null,
      page: null,
      provider: null,
      socket: null,
      helloAcked: false,
      enabled: false,
      state: "disabled",
      detail: "registration disabled",
      lastError: "",
      currentProviderKey: "",
      retryTimer: null,
      tabHeartbeatTimer: null,
      lastTabPongAt: 0,
      socketHeartbeatTimer: null,
      lastSocketPongAt: 0
    };
    tabSessions.set(tabId, session);
  }
  return session;
}

async function readConfig() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_CONFIG));
  return {
    ...DEFAULT_CONFIG,
    ...stored
  };
}

async function buildStatus(config, tabId) {
  if (typeof tabId !== "number") {
    return {
      ok: false,
      error: "active provider tab not found"
    };
  }

  const session = tabSessions.get(tabId);
  if (!session) {
    const enabled = await readTabEnabled(tabId);
    let page = null;
    let provider = null;
    if (enabled) {
      try {
        const tab = await chrome.tabs.get(tabId);
        page = {
          url: tab?.url || "",
          title: tab?.title || "",
          tabId
        };
        provider = globalThis.WEB_MODEL_PROVIDERS?.resolveByURL?.(page.url || "") || null;
      } catch (_error) {
      }
    }
    return {
      ok: true,
      serverUrl: config.serverUrl,
      debugLogs: !!config.debugLogs,
      enabled,
      providerType: provider?.type || "",
      providerKey: "",
      state: enabled ? "waiting_page" : "disabled",
      detail: enabled ? "provider page reconnecting" : "registration disabled",
      lastError: "",
      page,
      socketReadyState: null
    };
  }

  updateSessionState(session);

  return {
    ok: true,
    serverUrl: config.serverUrl,
    debugLogs: !!config.debugLogs,
    enabled: session.enabled,
    providerType: session.provider?.type || "",
    providerKey: session.currentProviderKey || "",
    state: session.state,
    detail: session.detail,
    lastError: session.lastError,
    page: session.page,
    socketReadyState: session.socket ? session.socket.readyState : null
  };
}

async function onConfigUpdated() {
  // Config changes mainly affect websocket destination. Enabled tabs reconnect, disabled tabs
  // only refresh their derived UI state.
  const previousConfig = runtimeConfig;
  const config = await readConfig();
  runtimeConfig = { ...config };
  setDebugEnabled(!!config.debugLogs);
  const serverURLChanged = previousConfig.serverUrl !== config.serverUrl;

  for (const session of tabSessions.values()) {
    if (session.port) {
      try {
        session.port.postMessage({
          type: "debug.set",
          enabled: !!config.debugLogs
        });
      } catch (_error) {
      }
    }
    if (serverURLChanged) {
      clearRetryTimer(session);
      closeSessionSocket(session, "config updated");
      if (session.enabled) {
        scheduleReconnect(session, "config updated");
      } else {
        updateSessionState(session);
      }
      continue;
    }
    updateSessionState(session);
  }
}

readConfig().then((config) => {
  runtimeConfig = { ...config };
  setDebugEnabled(!!config.debugLogs);
  ensureOffscreenKeepalive().catch((error) => {
    console.error("[web-model:bg] offscreen keepalive setup failed", error);
  });
}).catch(() => {
  runtimeConfig = { ...DEFAULT_CONFIG };
  setDebugEnabled(false);
  ensureOffscreenKeepalive().catch(() => {
  });
});

async function hydrateSessionEnabledState(session) {
  // Enabled state lives in session storage so it survives MV3 worker restarts within the same
  // browser session, without persisting forever across full browser restarts.
  session.enabled = await readTabEnabled(session.tabId);
  updateSessionState(session);
  if (session.enabled && session.provider) {
    session.currentProviderKey = ensureProviderKey(session);
    scheduleReconnect(session, "tab enabled");
  }
}

async function readTabEnabled(tabId) {
  if (typeof tabId !== "number") {
    return false;
  }
  const stored = await chrome.storage.session.get(tabStateKey(tabId));
  return !!stored[tabStateKey(tabId)]?.enabled;
}

async function setTabEnabled(tabId, enabled) {
  if (typeof tabId !== "number") {
    return;
  }
  await chrome.storage.session.set({
    [tabStateKey(tabId)]: {
      enabled: !!enabled
    }
  });
}

async function ensureOffscreenKeepalive() {
  if (!chrome.offscreen?.createDocument) {
    return;
  }
  if (offscreenReady) {
    return offscreenReady;
  }

  offscreenReady = (async () => {
    const documentURL = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
    if (chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [documentURL]
      });
      if (contexts.length > 0) {
        return;
      }
    }

    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: ["WORKERS"],
        justification: "Keep extension runtime alive so provider tab registrations stay connected."
      });
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      if (!message.includes("Only a single offscreen document may be created")) {
        throw error;
      }
    }
  })();

  return offscreenReady;
}

chrome.tabs?.onRemoved?.addListener((tabId) => {
  const session = tabSessions.get(tabId);
  if (!session) {
    chrome.storage.session.remove(tabStateKey(tabId)).catch(() => {
    });
    return;
  }
  clearTabHeartbeat(session);
  clearRetryTimer(session);
  closeSessionSocket(session, "tab removed");
  tabSessions.delete(tabId);
  chrome.storage.session.remove(tabStateKey(tabId)).catch(() => {
  });
});

function tabStateKey(tabId) {
  return `tabState:${tabId}`;
}

function updateSessionState(session) {
  // Single place that derives popup-visible state from raw runtime fields.
  if (!session.enabled) {
    session.state = "disabled";
    session.detail = "registration disabled";
    updateActionIndicator(session);
    return;
  }
  if (!session.provider) {
    if (session.page?.url) {
      session.state = "unsupported";
      session.detail = "unsupported page";
    } else {
      session.state = "waiting_page";
      session.detail = hasScriptingAPI() ? "provider page not ready" : "refresh this tab to activate";
    }
    updateActionIndicator(session);
    return;
  }
  if (!session.port || !session.page?.url) {
    session.state = "waiting_page";
    session.detail = hasScriptingAPI() ? "provider page not ready" : "refresh this tab to activate";
    updateActionIndicator(session);
    return;
  }
  if (session.socket?.readyState === WebSocket.OPEN && session.helloAcked) {
    session.state = "connected";
    session.detail = `${session.provider.type} registered`;
    updateActionIndicator(session);
    return;
  }
  if (session.socket?.readyState === WebSocket.CONNECTING || session.retryTimer) {
    session.state = "connecting";
    if (!session.detail) {
      session.detail = "connecting";
    }
    updateActionIndicator(session);
    return;
  }
  if (session.state === "error") {
    if (!session.detail) {
      session.detail = session.lastError || "unknown error";
    }
    updateActionIndicator(session);
    return;
  }
  if (!session.socket) {
    session.state = "disconnected";
    session.detail = "waiting to connect";
  }
  updateActionIndicator(session);
}


function resolveProviderForSession(session) {
  return globalThis.WEB_MODEL_PROVIDERS?.resolveByURL?.(session.page?.url || "") || null;
}

function ensureProviderKey(session) {
  // Provider keys must be stable per tab so server-side counters remain consistent across
  // reconnects for the same page.
  if (!session?.provider) {
    return "";
  }
  if (!session.currentProviderKey || shouldRegenerateProviderKey(session.provider, session.currentProviderKey, session.tabId)) {
    session.currentProviderKey = generateProviderKey(session.provider, session.tabId);
  }
  return session.currentProviderKey;
}

function shouldRegenerateProviderKey(provider, currentKey, tabId) {
  if (!provider || !currentKey) {
    return true;
  }
  if (typeof provider.buildTabKey === "function" && typeof tabId === "number") {
    return currentKey !== provider.buildTabKey(tabId);
  }
  return false;
}

function generateProviderKey(provider, tabId) {
  if (typeof provider?.buildTabKey === "function" && typeof tabId === "number") {
    return provider.buildTabKey(tabId);
  }
  const current = providerSequences.get(provider.type) || 0;
  providerSequences.set(provider.type, current + 1);
  return provider.buildAutoKey(current);
}

function browserTag() {
  const agent = navigator.userAgent || "";
  if (agent.includes("Edg/")) {
    return "edge";
  }
  return "chrome";
}

function normalizeTabID(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function ensureContentScriptInjectedForTab(tabId, tabURL = "") {
  // Content scripts are injected on demand because provider registration is opt-in per tab.
  if (typeof tabId !== "number") {
    throw new Error("tab id is required for script injection");
  }
  if (!hasScriptingAPI()) {
    logMissingScriptingOnce(`tab=${tabId}`);
    return false;
  }
  let resolvedURL = String(tabURL || "");
  if (!resolvedURL) {
    const tab = await chrome.tabs.get(tabId);
    resolvedURL = String(tab?.url || "");
  }
  const provider = globalThis.WEB_MODEL_PROVIDERS?.resolveByURL?.(resolvedURL) || null;
  if (!provider) {
    throw new Error("current tab is not a supported provider page");
  }

  log("inject content scripts", `tab=${tabId}`, tabURL);
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["helper.js", ...PROVIDER_SCRIPT_FILES, "content.js"]
  });
  return true;
}
