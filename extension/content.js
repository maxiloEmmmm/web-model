// content script 桥接层。
//
// 这个文件夹在 background 和真实 provider 页面之间，负责：
// - 和 background 保持控制 port
// - 在需要时向页面主世界注入 page-hook
// - 调 provider adapter 去找输入框、提交、点新建聊天
// - 把页面结果重新组织后发回 background
//
// 它不是状态总控层，而是“页面动作执行层”。
// background 决定这次请求应该怎么走，content 负责把这个决定真正执行到页面里。
(async function bootstrap() {
  const helpers = globalThis.WEB_MODEL_HELPERS;
  const { clipText, createLogger, delay, normalizeText, setDebugEnabled } = helpers;
  try {
    const stored = await chrome.storage.local.get(["debugLogs"]);
    setDebugEnabled(!!stored.debugLogs);
  } catch (_error) {
    setDebugEnabled(false);
  }
  const providers = globalThis.WEB_MODEL_PROVIDERS;
  const provider = providers?.resolveByURL?.(location.href);
  if (!provider) {
    return;
  }

  // 防止扩展 reload / reinject 后同一个页面里出现多个 bridge 实例。
  const bridgeKey = "__WEB_MODEL_PROVIDER_BRIDGE__";
  if (window[bridgeKey] && typeof window[bridgeKey].reconnect === "function") {
    try {
      const reused = window[bridgeKey].reconnect("reinject");
      if (reused !== false) {
        return;
      }
    } catch (_error) {
    }
  }

  const log = createLogger("[web-model:content]", provider.type);

  const adapter = provider.createPageAdapter(log);
  let port = null;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let watchdogTimer = null;
  let extensionContextInvalidated = false;
  const pageHookState = createPageHookState();

  // Install the page-world fetch hook before the next request starts.
  ensurePageHookInjected();
  connectPort("boot");
  announcePageReady();
  startWatchdog();
  document.addEventListener("visibilitychange", handlePageActivity);
  window.addEventListener("focus", handlePageActivity);
  window.addEventListener("message", handlePageHookMessage);

  window[bridgeKey] = {
    reconnect(reason = "manual reconnect") {
      if (extensionContextInvalidated) {
        return false;
      }
      const connected = connectPort(reason);
      if (connected === false) {
        return false;
      }
      announcePageReady();
      return true;
    }
  };

  function announcePageReady() {
    // 注意：这里的 ready 不是“网页 onload 完成”。
    // 它表示“当前 provider 页面桥已经就绪，可以让 background 把这个 tab 当成可注册对象”。
    // Background uses this to learn page URL/title/provider readiness for the current tab.
    if (extensionContextInvalidated) {
      return;
    }
    if (!port) {
      scheduleReconnect("page ready without port");
      return;
    }
    if (!safePostMessage({
      type: "page.ready",
      providerType: provider.type,
      url: location.href,
      title: document.title
    })) {
      return;
    }
  }

  function ensurePageHookInjected() {
    // Network capture currently exists only for providers with page-hook parsers.
    if (!provider || (provider.type !== "chatgpt" && provider.type !== "qwen" && provider.type !== "yuanbao" && provider.type !== "gemini" && provider.type !== "kimi")) {
      return;
    }
    const helperScriptID = "__web_model_helper_script__";
    const pageHookScriptID = "__web_model_page_hook_script__";
    if (document.getElementById(pageHookScriptID)) {
      log("page hook already present");
      return;
    }

    if (!(document.documentElement || document.head || document.body)) {
      log("page hook mount target missing");
      return;
    }

    injectPageScript({
      id: helperScriptID,
      src: chrome.runtime.getURL("helper.js"),
      beforeAppend(script) {
        script.dataset.webModelDebug = helpers.isDebugEnabled() ? "true" : "false";
      },
      removeOnLoad: false,
      onload: () => {
        syncPageDebugFlag(helpers.isDebugEnabled());
        injectPageScript({
          id: pageHookScriptID,
          src: chrome.runtime.getURL("page-hook.js"),
          onload: () => {
            log("page hook loaded");
          }
        });
      }
    });
  }

  function injectPageScript({ id, src, onload = null, removeOnLoad = true, beforeAppend = null }) {
    const existing = document.getElementById(id);
    if (existing) {
      if (existing.dataset.webModelLoaded === "true") {
        if (typeof onload === "function") {
          onload();
        }
        return;
      }
      if (typeof onload === "function") {
        existing.addEventListener("load", onload, { once: true });
      }
      existing.addEventListener("error", () => {
        log("page script failed to load", { id, src });
      }, { once: true });
      return;
    }

    const script = document.createElement("script");
    script.id = id;
    script.src = src;
    script.async = false;
    log("page script inject", { id, src });
    script.onload = () => {
      script.dataset.webModelLoaded = "true";
      if (removeOnLoad) {
        script.remove();
      }
      if (typeof onload === "function") {
        onload();
      }
    };
    script.onerror = () => {
      log("page script failed to load", { id, src });
    };
    if (typeof beforeAppend === "function") {
      beforeAppend(script);
    }
    (document.documentElement || document.head || document.body).appendChild(script);
  }

  function syncPageDebugFlag(enabled) {
    window.postMessage({
      source: "web-model-debug-control",
      payload: {
        type: "debug.set",
        enabled: !!enabled
      }
    }, "*");
  }

  function createPageHookState() {
    // 这里分成 captures 和 watchers 两层，是为了把“页面主世界网络事件”和
    // “background 发下来的 requestId”解耦：
    //
    // - page-hook 只能产出 captureId
    // - content 才知道当前正在处理哪个 requestId
    //
    // 两者通过 providerType + prompt + 时间窗口绑定起来。
    // `captures` store live network results by capture id.
    // `watchers` bind one chat request id to the capture that matches its prompt/provider.
    return {
      captures: new Map(),
      watchers: new Map()
    };
  }

  function computeStreamDelta(previous, current) {
    const before = String(previous || "");
    const after = String(current || "");
    if (!after || after === before) {
      return "";
    }
    if (!before) {
      return after;
    }
    if (after.startsWith(before)) {
      return after.slice(before.length);
    }
    return after;
  }

  function forwardNetworkCaptureDelta(capture) {
    if (!capture || !capture.captureId || !capture.text) {
      return;
    }

    for (const watcher of pageHookState.watchers.values()) {
      if (watcher.captureId !== capture.captureId) {
        continue;
      }
      const delta = computeStreamDelta(watcher.lastForwardedText, capture.text);
      if (!delta || !port) {
        continue;
      }
      watcher.lastForwardedText = capture.text;
      safePostMessage({
        type: "chat.delta",
        requestId: watcher.requestId,
        delta
      });
    }
  }

  function handlePageHookMessage(event) {
    if (event.source !== window) {
      return;
    }
    if (event.data?.source !== "web-model-page-hook" || !event.data.payload) {
      return;
    }
    const payload = event.data.payload;
    onPageHookPayload(payload);
  }

  function onPageHookPayload(payload) {
    if (!payload || typeof payload !== "object") {
      return;
    }
    if (payload.type === "capture.start") {
      log("network capture start", {
        captureId: payload.captureId,
        providerType: payload.providerType,
        prompt: payload.prompt || "",
        promptPreview: clipText(payload.prompt || ""),
        url: payload.url || ""
      });
      pageHookState.captures.set(payload.captureId, {
        captureId: payload.captureId,
        providerType: payload.providerType || "",
        prompt: payload.prompt || "",
        url: payload.url || "",
        text: "",
        error: "",
        done: false,
        startedAt: Date.now(),
        updatedAt: Date.now()
      });

      for (const watcher of pageHookState.watchers.values()) {
        if (watcher.captureId) {
          continue;
        }
        if (watcher.providerType !== payload.providerType) {
          continue;
        }
        if (
          payload.prompt &&
          watcher.prompt &&
          normalizeText(payload.prompt) !== normalizeText(watcher.prompt)
        ) {
          continue;
        }
        if (Date.now() + 1000 < watcher.createdAt) {
          continue;
        }
        watcher.captureId = payload.captureId;
        log("network capture bound", {
          requestId: watcher.requestId,
          captureId: payload.captureId,
          providerType: payload.providerType,
          promptPreview: clipText(watcher.prompt || payload.prompt || "")
        });
      }
      return;
    }

    const capture = pageHookState.captures.get(payload.captureId);
    if (!capture) {
      return;
    }

    capture.updatedAt = Date.now();
    if (payload.type === "capture.update") {
      capture.text = String(payload.text || "");
      forwardNetworkCaptureDelta(capture);
    } else if (payload.type === "capture.done") {
      capture.text = String(payload.text || capture.text || "");
      forwardNetworkCaptureDelta(capture);
      capture.done = true;
      log("network capture done", {
        captureId: payload.captureId,
        providerType: capture.providerType,
        textLength: capture.text.length,
        textPreview: clipText(capture.text)
      });
    } else if (payload.type === "capture.error") {
      capture.error = String(payload.error || "unknown capture error");
      capture.done = true;
      log("network capture error", {
        captureId: payload.captureId,
        providerType: capture.providerType,
        error: capture.error
      });
    }
  }

  function createNetworkCapture(providerType, prompt, requestId) {
    // 这个对象代表“本次请求优先等待网络层结果，而不是等待最终 DOM”。
    // 这样在后台标签页里，哪怕页面渲染慢，回复也能更早被拿到。
    // Wait for the page-world hook to emit a completed capture for this request.
    const watcher = {
      requestId,
      providerType,
      prompt,
      captureId: "",
      createdAt: Date.now(),
      lastForwardedText: ""
    };
    pageHookState.watchers.set(requestId, watcher);

    return {
      async waitForResult(timeoutMs = 120000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const capture = watcher.captureId ? pageHookState.captures.get(watcher.captureId) : null;
          if (capture?.error) {
            pageHookState.watchers.delete(requestId);
            throw new Error(capture.error);
          }
          if (capture?.done) {
            pageHookState.watchers.delete(requestId);
            return capture.text || "";
          }
          await delay(25);
        }
        pageHookState.watchers.delete(requestId);
        throw new Error("network capture timed out");
      },

      cleanup() {
        pageHookState.watchers.delete(requestId);
      }
    };
  }

  function handlePageActivity() {
    if (extensionContextInvalidated) {
      return;
    }
    if (!port) {
      connectPort("page activity");
    }
    announcePageReady();
  }

  function connectPort(reason) {
    // background <-> content 之间只保留这一条控制通道，
    // 这样所有注册、请求、成功、失败的来源都很清晰。
    // Control channel to background for registration, chat dispatch, and results.
    if (extensionContextInvalidated) {
      return false;
    }
    clearReconnectTimer();
    if (port) {
      try {
        port.disconnect();
      } catch (_error) {
      }
    }

    let currentPort = null;
    try {
      currentPort = chrome.runtime.connect({ name: "web-model-provider-page" });
    } catch (error) {
      if (isExtensionContextInvalidated(error)) {
        invalidateExtensionContext("connect failed");
        return false;
      }
      throw error;
    }
    port = currentPort;
    log("content script port connected", reason);

    currentPort.onMessage.addListener((message) => {
      if (message?.type === "debug.set") {
        const enabled = !!message.enabled;
        setDebugEnabled(enabled);
        syncPageDebugFlag(enabled);
        return;
      }

      if (message?.type !== "chat.request") {
        return;
      }
      if (message.providerType && message.providerType !== provider.type) {
        return;
      }

      log("chat request", message.requestId, message.request);
      handleChatRequest(message.requestId, message.request, {
        startNewChatBeforeSend: !!message.startNewChatBeforeSend
      }).catch((error) => {
        console.error("[web-model:content] chat error", provider.type, error);
        if (!port) {
          return;
        }
        safePostMessage({
          type: "chat.error",
          requestId: message.requestId,
          startedNewChat: !!error?.startedNewChat,
          error: String(error && error.message ? error.message : error)
        });
      });
    });

    currentPort.onDisconnect.addListener(() => {
      if (port !== currentPort) {
        return;
      }
      log("content script port disconnected");
      clearHeartbeatTimer();
      port = null;
      scheduleReconnect("port disconnected");
    });

    startHeartbeat();
  }

  function scheduleReconnect(reason) {
    if (extensionContextInvalidated || reconnectTimer || port) {
      return;
    }
    log("schedule reconnect", reason);
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connectPort("auto reconnect");
      announcePageReady();
    }, 1000);
  }

  function clearReconnectTimer() {
    if (!reconnectTimer) {
      return;
    }
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function startHeartbeat() {
    // Liveness only. This does not carry any chat content.
    clearHeartbeatTimer();
    heartbeatTimer = window.setInterval(() => {
      if (!port || extensionContextInvalidated) {
        return;
      }
      safePostMessage({
        type: "ping",
        providerType: provider.type,
        url: location.href,
        title: document.title
      });
    }, 15000);
  }

  function startWatchdog() {
    // If the port disappears, periodically try to reattach without requiring a manual refresh.
    clearWatchdogTimer();
    watchdogTimer = window.setInterval(() => {
      if (port || extensionContextInvalidated) {
        return;
      }
      connectPort("watchdog reconnect");
      announcePageReady();
    }, 5000);
  }

  function clearHeartbeatTimer() {
    if (!heartbeatTimer) {
      return;
    }
    window.clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  function clearWatchdogTimer() {
    if (!watchdogTimer) {
      return;
    }
    window.clearInterval(watchdogTimer);
    watchdogTimer = null;
  }

  function safePostMessage(payload) {
    if (!port || extensionContextInvalidated) {
      return false;
    }
    try {
      port.postMessage(payload);
      return true;
    } catch (error) {
      if (isExtensionContextInvalidated(error)) {
        invalidateExtensionContext("postMessage failed");
        return false;
      }
      throw error;
    }
  }

  function isExtensionContextInvalidated(error) {
    return String(error && error.message ? error.message : error).includes("Extension context invalidated");
  }

  function invalidateExtensionContext(reason) {
    if (extensionContextInvalidated) {
      return;
    }
    extensionContextInvalidated = true;
    log("extension context invalidated", reason);
    clearReconnectTimer();
    clearHeartbeatTimer();
    clearWatchdogTimer();
    if (port) {
      try {
        port.disconnect();
      } catch (_error) {
      }
      port = null;
    }
    window.removeEventListener("message", handlePageHookMessage);
  }

  async function handleChatRequest(requestId, request, options = {}) {
    // 这里是 content 的主执行入口。
    // background 把结构化请求发下来后，真正落到页面动作上的部分都从这里开始。
    // One full page-side request lifecycle:
    // 1. extract latest user prompt
    // 2. optionally start a fresh conversation
    // 3. fill and submit the composer
    // 4. prefer network capture, otherwise use DOM fallback
    // 5. report success/error back to background
    const prompt = extractPrompt(request);
    if (!prompt) {
      throw new Error("missing user message content");
    }
    let startedNewChat = false;
    let networkCapture = null;
    try {
      log("chat start", { requestId, prompt, startNewChatBeforeSend: !!options.startNewChatBeforeSend });
      log(
        options.startNewChatBeforeSend
          ? "chat request flagged to start new chat before send"
          : "chat request will reuse current chat",
        { requestId, providerType: provider.type }
      );

      if (options.startNewChatBeforeSend && typeof adapter.startNewChat === "function") {
        log("new chat required before send", {
          requestId,
          providerType: provider.type,
          reason: "server requested startNewChatBeforeSend"
        });
        await adapter.startNewChat();
        // Returned to the server so server-side counters can reset only when the page actually
        // attempted to switch to a fresh conversation.
        startedNewChat = true;
        log("new chat started before send", {
          requestId,
          providerType: provider.type
        });
        announcePageReady();
      }

      const composer = await adapter.waitForComposer();
      log("composer found", composer.tagName, composer.getAttribute("placeholder") || composer.getAttribute("role") || "");

      const baseline = adapter.captureBaseline();
      // DOM fallback can still emit deltas even when network capture is unavailable.
      baseline.onDelta = (streamRequestID, delta) => {
        if (!port || !delta) {
          return;
        }
        port.postMessage({
          type: "chat.delta",
          requestId: streamRequestID,
          delta
        });
      };
      if (provider.type === "chatgpt" || provider.type === "qwen" || provider.type === "yuanbao" || provider.type === "gemini" || provider.type === "kimi") {
        networkCapture = createNetworkCapture(provider.type, prompt, requestId);
      }

      const submitButton = adapter.findSubmitButton(composer);
      const initialSubmitControl = adapter.describeSubmitControl(submitButton);
      log("submit control initial", initialSubmitControl);

      adapter.focusComposer(composer);
      adapter.setComposerValue(composer, prompt);
      await adapter.ensureComposerValue(composer, prompt);
      await adapter.submitComposer(composer, submitButton);
      log("submitted prompt", { requestId, prompt });

      const answer = networkCapture
        ? await networkCapture.waitForResult()
        : await adapter.waitForAssistantReply(
          requestId,
          composer,
          submitButton,
          prompt,
          baseline
        );
      networkCapture?.cleanup?.();
      if (!answer) {
        throw new Error("assistant reply was empty");
      }

      log("chat success", {
        requestId,
        startedNewChat,
        answer
      });

      safePostMessage({
        type: "chat.done",
        requestId,
        startedNewChat,
        message: {
          role: "assistant",
          content: answer
        },
        promptTokens: adapter.estimateTokens(prompt),
        completionTokens: adapter.estimateTokens(answer)
      });
    } catch (error) {
      networkCapture?.cleanup?.();
      if (startedNewChat && error && typeof error === "object") {
        error.startedNewChat = true;
      }
      throw error;
    }
  }

  function extractPrompt(request) {
    // We only drive the page with the latest user message from the OpenAI-style request array.
    const messages = Array.isArray(request?.messages) ? request.messages : [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role === "user" && typeof message.content === "string" && message.content.trim()) {
        return message.content.trim();
      }
    }
    return "";
  }
})();
