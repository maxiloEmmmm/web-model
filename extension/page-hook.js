// 页面主世界 fetch hook。
//
// content script 运行在 isolated world，看不到页面主世界真正消费的 fetch/response stream。
// 但我们又不想只靠最终 DOM 判断回复，因为后台标签页里 DOM 更新经常滞后。
//
// 所以这里在页面主世界旁路抓 provider 请求：
// - 命中已知 provider endpoint
// - clone response
// - 解析 SSE / JSON
// - 再通过 window.postMessage 把结果发回 content script
(function installWebModelPageHook() {
  const hookKey = "__WEB_MODEL_PAGE_HOOK__";
  if (window[hookKey]) {
    return;
  }

  const { clipText, createLogger, normalizeText } = globalThis.WEB_MODEL_HELPERS || {};
  if (!clipText || !createLogger || !normalizeText) {
    console.warn("[web-model:page-hook] helpers unavailable");
    return;
  }

  const providers = [
    { type: "qwen", path: "/api/v2/chat/completions" },
    { type: "chatgpt", path: "/backend-api/f/conversation" },
    { type: "gemini", path: "/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate" },
    { type: "kimi", path: "/apiv2/kimi.gateway.chat.v1.ChatService/Chat" },
    { type: "yuanbao", pathPrefix: "/api/chat/" }
  ];

  let nextCaptureId = 1;
  const originalFetch = window.fetch.bind(window);
  const originalXHROpen = window.XMLHttpRequest?.prototype?.open;
  const originalXHRSend = window.XMLHttpRequest?.prototype?.send;
  const log = createLogger("[web-model:page-hook]");

  function emit(type, payload) {
    // 这里不直接碰 background，而是先发给 content script。
    // 因为 requestId 绑定、错误处理、fallback 决策都还在 content 层。
    // Content script listens for these page-world events and binds them to chat request ids.
    window.postMessage({
      source: "web-model-page-hook",
      payload: {
        type,
        ...payload
      }
    }, "*");
  }

  function resolveProviderType(url) {
    // Only capture known provider endpoints. Everything else is forwarded untouched.
    try {
      const parsed = new URL(String(url || ""), location.href);
      const matched = providers.find((provider) => {
        if (provider.path && parsed.pathname === provider.path) {
          return true;
        }
        if (provider.pathPrefix && parsed.pathname.startsWith(provider.pathPrefix)) {
          return true;
        }
        return false;
      });
      return matched ? matched.type : "";
    } catch (_error) {
      return "";
    }
  }

  function decodeBinaryBody(body) {
    if (body instanceof ArrayBuffer) {
      return new Uint8Array(body);
    }
    if (ArrayBuffer.isView(body)) {
      return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    }
    return null;
  }

  function decodeInitBody(init) {
    if (!init || typeof init !== "object" || init.body == null) {
      return Promise.resolve("");
    }
    if (typeof init.body === "string") {
      return Promise.resolve(init.body);
    }
    if (init.body instanceof URLSearchParams) {
      return Promise.resolve(init.body.toString());
    }
    if (init.body instanceof Blob) {
      return init.body.text().catch(() => "");
    }
    const binary = decodeBinaryBody(init.body);
    if (binary) {
      return Promise.resolve(new TextDecoder().decode(binary));
    }
    return Promise.resolve("");
  }

  async function resolveRequestBody(input, init) {
    // Extract request body without consuming the original request object.
    const initBody = await decodeInitBody(init);
    if (initBody) {
      return initBody;
    }
    if (input instanceof Request) {
      try {
        const cloned = input.clone();
        const text = await cloned.text();
        if (text) {
          return text;
        }
      } catch (_error) {
      }
      try {
        const bytes = new Uint8Array(await input.clone().arrayBuffer());
        return new TextDecoder().decode(bytes);
      } catch (_error) {
        return "";
      }
    }
    return "";
  }

  function extractTextValue(value) {
    // Flatten common nested text/content/parts shapes across different providers.
    if (!value) {
      return "";
    }
    if (typeof value === "string") {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => extractTextValue(item)).filter(Boolean).join("");
    }
    if (typeof value === "object") {
      if (typeof value.text === "string") {
        return value.text;
      }
      if (typeof value.content === "string") {
        return value.content;
      }
      if (Array.isArray(value.parts)) {
        return value.parts.map((item) => extractTextValue(item)).filter(Boolean).join("");
      }
      if (Array.isArray(value.content)) {
        return value.content.map((item) => extractTextValue(item)).filter(Boolean).join("");
      }
    }
    return "";
  }

  function extractLastUserPrompt(payload) {
    // Used to match one network request to the current outgoing prompt.
    let latest = "";

    function visit(node) {
      if (!node) {
        return;
      }
      if (Array.isArray(node)) {
        for (const item of node) {
          visit(item);
        }
        return;
      }
      if (typeof node !== "object") {
        return;
      }

      const role = node.role || node.author?.role || node.message?.author?.role || "";
      if (role === "user") {
        const candidate = normalizeText(
          extractTextValue(node.content || node.message?.content || node.parts || node.text || "")
        );
        if (candidate) {
          latest = candidate;
        }
      }

      for (const value of Object.values(node)) {
        visit(value);
      }
    }

    visit(payload);
    return latest;
  }

  const fallbackParser = {
    // Generic parser for assistant-shaped payloads when no provider-specific rule matches.
    extractPrompt(payload) {
      return extractLastUserPrompt(payload);
    },

    extractAssistant(payload) {
      if (!payload || typeof payload !== "object") {
        return { mode: "", text: "" };
      }

      let best = "";

      function visit(node) {
        if (!node) {
          return;
        }
        if (Array.isArray(node)) {
          for (const item of node) {
            visit(item);
          }
          return;
        }
        if (typeof node !== "object") {
          return;
        }

        const role = node.role || node.author?.role || node.message?.author?.role || "";
        if (role === "assistant") {
          const candidate = normalizeText(
            extractTextValue(node.content || node.message?.content || node.parts || node.text || "")
          );
          if (candidate.length >= best.length) {
            best = candidate;
          }
        }

        for (const value of Object.values(node)) {
          visit(value);
        }
      }

      visit(payload);
      return best ? { mode: "replace", text: best } : { mode: "", text: "" };
    }
  };

  const providerParsers = {
    qwen: {
      // Qwen SSE frames are close to OpenAI-style delta payloads.
      extractPrompt(payload) {
        return extractLastUserPrompt(payload);
      },

      extractAssistant(payload) {
        if (!payload || typeof payload !== "object") {
          return { mode: "", text: "" };
        }

        const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
        const deltaContent = choice?.delta?.content;
        if (typeof deltaContent === "string" && deltaContent) {
          return { mode: "append", text: deltaContent };
        }
        const messageContent = choice?.message?.content;
        if (typeof messageContent === "string" && messageContent) {
          return { mode: "replace", text: messageContent };
        }
        if (Array.isArray(messageContent)) {
          const joined = normalizeText(extractTextValue(messageContent));
          if (joined) {
            return { mode: "replace", text: joined };
          }
        }

        return fallbackParser.extractAssistant(payload);
      }
    },

    chatgpt: {
      // ChatGPT emits patch-like SSE frames. Text may arrive as full assistant content or
      // incremental `/message/content/...` operations.
      extractPrompt(payload) {
        return extractLastUserPrompt(payload);
      },

      extractAssistant(payload) {
        if (!payload || typeof payload !== "object") {
          return { mode: "", text: "" };
        }

        const directRole = payload.message?.author?.role || payload.author?.role || "";
        if (directRole === "assistant") {
          const directText = extractTextValue(payload.message?.content || payload.content || "");
          if (directText) {
            return { mode: "replace", text: directText };
          }
        }

        if (payload.o === "add" && payload.v && typeof payload.v === "object") {
          const addedRole = payload.v.message?.author?.role || payload.v.author?.role || "";
          if (addedRole === "assistant") {
            const addedText = extractTextValue(payload.v.message?.content || payload.v.content || "");
            if (addedText) {
              return { mode: "replace", text: addedText };
            }
          }
        }

        const operations = Array.isArray(payload.v)
          ? payload.v
          : Array.isArray(payload.operations)
            ? payload.operations
            : [];

        for (const operation of operations) {
          if (!operation || typeof operation !== "object") {
            continue;
          }
          const path = String(operation.p || "");
          const op = String(operation.o || "");
          const value = operation.v;

          if (
            /\/message\/content\/parts\/\d+$/.test(path) ||
            /\/message\/content\/parts$/.test(path) ||
            /\/message\/content\/text$/.test(path) ||
            /\/message\/content\/result$/.test(path)
          ) {
            if (typeof value === "string" && value) {
              return {
                mode: op === "append" ? "append" : "replace",
                text: value
              };
            }
            if (Array.isArray(value)) {
              const joined = normalizeText(extractTextValue(value));
              if (joined) {
                return {
                  mode: op === "append" ? "append" : "replace",
                  text: joined
                };
              }
            }
            const richText = extractTextValue(value);
            if (richText) {
              return {
                mode: op === "append" ? "append" : "replace",
                text: richText
              };
            }
          }

          if (/\/message$/.test(path) && value && typeof value === "object") {
            const operationRole = value.author?.role || value.message?.author?.role || "";
            if (operationRole === "assistant") {
              const operationText = extractTextValue(value.content || value.message?.content || "");
              if (operationText) {
                return {
                  mode: op === "append" ? "append" : "replace",
                  text: operationText
                };
              }
            }
          }
        }

        return fallbackParser.extractAssistant(payload);
      }
    },

    yuanbao: {
      extractPrompt(payload) {
        if (!payload || typeof payload !== "object") {
          return "";
        }
        return normalizeText(payload.prompt || "");
      },

      extractAssistant(payload) {
        if (!payload || typeof payload !== "object") {
          return { mode: "", text: "" };
        }
        if (payload.type === "text" && typeof payload.msg === "string" && payload.msg) {
          return { mode: "append", text: payload.msg };
        }
        return { mode: "", text: "" };
      }
    },

    gemini: {
      extractPrompt(payload) {
        if (!Array.isArray(payload)) {
          return "";
        }
        const prompt = payload?.[0]?.[0];
        return typeof prompt === "string" ? normalizeText(prompt) : "";
      },

      extractAssistant(payload) {
        if (!Array.isArray(payload)) {
          return { mode: "", text: "" };
        }

        const responses = Array.isArray(payload[4]) ? payload[4] : [];
        const primary = responses[0];
        const primaryText = Array.isArray(primary?.[1])
          ? normalizeText(primary[1].filter((item) => typeof item === "string").join(""))
          : "";
        if (primaryText) {
          return { mode: "replace", text: primaryText };
        }

        return { mode: "", text: "" };
      }
    },

    kimi: {
      extractPrompt(payload) {
        if (!payload || typeof payload !== "object") {
          return "";
        }
        const blocks = Array.isArray(payload.message?.blocks) ? payload.message.blocks : [];
        for (const block of blocks) {
          const prompt = normalizeText(block?.text?.content || "");
          if (prompt) {
            return prompt;
          }
        }
        return "";
      },

      extractAssistant(payload) {
        if (!payload || typeof payload !== "object") {
          return { mode: "", text: "" };
        }

        const op = String(payload.op || "");
        const mask = String(payload.mask || "");
        const text = typeof payload.block?.text?.content === "string"
          ? payload.block.text.content
          : "";
        if (!text) {
          return { mode: "", text: "" };
        }

        if (op === "set" && mask === "block.text") {
          return { mode: "replace", text };
        }
        if (op === "append" && mask === "block.text.content") {
          return { mode: "append", text };
        }
        return { mode: "", text: "" };
      }
    }
  };

  function getProviderParser(providerType) {
    return providerParsers[providerType] || fallbackParser;
  }

  function extractAssistantText(payload, providerType) {
    return getProviderParser(providerType).extractAssistant(payload);
  }

  function extractProviderPrompt(payload, providerType) {
    return getProviderParser(providerType).extractPrompt(payload);
  }

  function parseGeminiBody(bodyText) {
    const params = new URLSearchParams(String(bodyText || ""));
    const raw = params.get("f.req");
    if (!raw) {
      return null;
    }
    const outer = JSON.parse(raw);
    const innerRaw = typeof outer?.[1] === "string" ? outer[1] : "";
    if (!innerRaw) {
      return null;
    }
    return JSON.parse(innerRaw);
  }

  function parseKimiBody(bodyText) {
    const bytes = new TextEncoder().encode(String(bodyText || ""));
    if (bytes.length < 5) {
      return null;
    }
    const frameLength =
      ((bytes[1] << 24) >>> 0) |
      (bytes[2] << 16) |
      (bytes[3] << 8) |
      bytes[4];
    if (frameLength <= 0 || bytes.length < 5 + frameLength) {
      return null;
    }
    const jsonText = new TextDecoder().decode(bytes.slice(5, 5 + frameLength));
    return JSON.parse(jsonText);
  }

  function buildCapture(providerType, url, bodyText = "") {
    let prompt = "";
    if (bodyText) {
      try {
        if (providerType === "gemini") {
          prompt = extractProviderPrompt(parseGeminiBody(bodyText), providerType);
        } else if (providerType === "kimi") {
          prompt = extractProviderPrompt(parseKimiBody(bodyText), providerType);
        } else {
          prompt = extractProviderPrompt(JSON.parse(bodyText), providerType);
        }
      } catch (_error) {
      }
    }

    const captureId = `${providerType}-${Date.now()}-${nextCaptureId++}`;
    return {
      captureId,
      providerType,
      prompt,
      url,
      bodyText
    };
  }

  function emitCaptureStart(capture) {
    log("fetch matched", {
      providerType: capture.providerType,
      captureId: capture.captureId,
      url: capture.url,
      prompt: capture.prompt,
      bodyPreview: clipText(capture.bodyText)
    });
    emit("capture.start", {
      captureId: capture.captureId,
      providerType: capture.providerType,
      prompt: capture.prompt,
      url: capture.url
    });
  }

  function parseSSEBlock(block, providerType, state) {
    // 一个 SSE block 解析完后，不直接决定“聊天完成”，这里只负责尽量提取文本。
    // “这次请求什么时候算结束”是 content 层根据 capture.done 再判断的。
    // Merge all `data:` lines inside one SSE frame, then let the provider parser interpret them.
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();

    if (!data || data === "[DONE]") {
      return;
    }

    try {
      const payload = JSON.parse(data);
      const extracted = extractAssistantText(payload, providerType);
      if (!extracted.text) {
        return;
      }
      if (extracted.mode === "append") {
        state.text += extracted.text;
      } else {
        state.text = extracted.text;
      }
    } catch (_error) {
    }
  }

  function parseGeminiFramePayload(frameText, state) {
    try {
      const outer = JSON.parse(frameText);
      if (!Array.isArray(outer)) {
        return;
      }

      for (const item of outer) {
        if (!Array.isArray(item) || item[0] !== "wrb.fr" || typeof item[2] !== "string") {
          continue;
        }
        const payload = JSON.parse(item[2]);
        const extracted = extractAssistantText(payload, "gemini");
        if (extracted.text) {
          state.text = extracted.text;
        }
      }
    } catch (_error) {
    }
  }

  function parseKimiFramePayload(frameText, state) {
    try {
      const payload = JSON.parse(frameText);
      const extracted = extractAssistantText(payload, "kimi");
      if (!extracted.text) {
        return;
      }
      if (extracted.mode === "append") {
        state.text += extracted.text;
      } else {
        state.text = extracted.text;
      }
    } catch (_error) {
    }
  }

  function flushStreamingState(state) {
    if (state.text && state.text !== state.lastEmitted) {
      state.lastEmitted = state.text;
      emit("capture.update", {
        captureId: state.captureId,
        providerType: state.providerType,
        text: state.text
      });
    }
  }

  function parseStreamingBufferChunk(chunk, providerType, state) {
    if (providerType === "gemini") {
      parseGeminiBufferChunk(chunk, state);
      return;
    }
    if (!chunk) {
      return;
    }
    state.buffer += chunk;
    let boundary = state.buffer.search(/\r?\n\r?\n/);
    while (boundary >= 0) {
      const block = state.buffer.slice(0, boundary);
      state.buffer = state.buffer.slice(boundary + (state.buffer[boundary] === "\r" ? 4 : 2));
      parseSSEBlock(block, providerType, state);
      flushStreamingState(state);
      boundary = state.buffer.search(/\r?\n\r?\n/);
    }
  }

  function finalizeStreamingState(state) {
    if (state.providerType === "gemini") {
      flushGeminiBufferState(state);
      flushStreamingState(state);
      return;
    }
    if (state.buffer) {
      parseSSEBlock(state.buffer, state.providerType, state);
      state.buffer = "";
    }
    flushStreamingState(state);
  }

  function ensureBinaryBuffer(value) {
    if (!value || !value.length) {
      return new Uint8Array(0);
    }
    if (value instanceof Uint8Array) {
      return value;
    }
    return new Uint8Array(value);
  }

  function appendBinaryBuffer(current, next) {
    const head = ensureBinaryBuffer(current);
    const tail = ensureBinaryBuffer(next);
    if (!head.length) {
      return tail;
    }
    if (!tail.length) {
      return head;
    }
    const merged = new Uint8Array(head.length + tail.length);
    merged.set(head, 0);
    merged.set(tail, head.length);
    return merged;
  }

  function parseKimiBinaryChunk(chunk, state) {
    if (chunk?.length) {
      state.binaryBuffer = appendBinaryBuffer(state.binaryBuffer, chunk);
    }

    const decoder = state.binaryDecoder || (state.binaryDecoder = new TextDecoder());
    let offset = 0;
    const buffer = ensureBinaryBuffer(state.binaryBuffer);

    while (buffer.length - offset >= 5) {
      const flags = buffer[offset];
      const frameLength =
        ((buffer[offset + 1] << 24) >>> 0) |
        (buffer[offset + 2] << 16) |
        (buffer[offset + 3] << 8) |
        buffer[offset + 4];
      if (buffer.length - offset - 5 < frameLength) {
        break;
      }

      const frameBytes = buffer.slice(offset + 5, offset + 5 + frameLength);
      const frameText = decoder.decode(frameBytes);
      if (flags === 0x00 || flags === 0x01 || flags === 0x02) {
        parseKimiFramePayload(frameText, state);
      }
      flushStreamingState(state);
      offset += 5 + frameLength;
    }

    state.binaryBuffer = offset ? buffer.slice(offset) : buffer;
  }

  function flushKimiBufferState(state) {
    parseKimiBinaryChunk(null, state);
  }

  function trimGeminiBufferPrefix(state) {
    if (state.prefixTrimmed) {
      return;
    }
    state.buffer = state.buffer.replace(/^\)\]\}'\s*/, "");
    state.prefixTrimmed = true;
  }

  function parseGeminiBufferChunk(chunk, state) {
    if (chunk) {
      state.buffer += chunk;
    }
    trimGeminiBufferPrefix(state);

    while (true) {
      const lengthLineEnd = state.buffer.indexOf("\n");
      if (lengthLineEnd < 0) {
        return;
      }

      const lengthLine = state.buffer.slice(0, lengthLineEnd).trim();
      if (!lengthLine) {
        state.buffer = state.buffer.slice(lengthLineEnd + 1);
        continue;
      }

      const frameLength = Number.parseInt(lengthLine, 10);
      if (!Number.isFinite(frameLength) || frameLength < 0) {
        return;
      }

      const frameStart = lengthLineEnd + 1;
      const frame = extractGeminiJSONArrayFrame(state.buffer, frameStart);
      if (!frame) {
        return;
      }

      parseGeminiFramePayload(frame.text, state);
      state.buffer = state.buffer.slice(frame.end);
      flushStreamingState(state);
      if (state.buffer.startsWith("\r\n")) {
        state.buffer = state.buffer.slice(2);
      } else if (state.buffer.startsWith("\n") || state.buffer.startsWith("\r")) {
        state.buffer = state.buffer.slice(1);
      }
    }
  }

  function flushGeminiBufferState(state) {
    if (!state.buffer) {
      return;
    }
    parseGeminiBufferChunk("", state);
  }

  function extractGeminiJSONArrayFrame(buffer, startIndex) {
    let index = startIndex;
    while (index < buffer.length && /\s/.test(buffer[index])) {
      index += 1;
    }
    if (index >= buffer.length || buffer[index] !== "[") {
      return null;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let cursor = index; cursor < buffer.length; cursor += 1) {
      const char = buffer[cursor];
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
        continue;
      }

      if (char === "[") {
        depth += 1;
        continue;
      }

      if (char === "]") {
        depth -= 1;
        if (depth === 0) {
          return {
            text: buffer.slice(index, cursor + 1),
            end: cursor + 1
          };
        }
      }
    }

    return null;
  }

  async function tapStreamingClone(providerType, captureId, response) {
    // 这里专门读取 clone，是为了保证页面自己的 fetch 消费链完全不被打断。
    // 如果直接读原 response，页面本身就可能报网络错误。
    // Parse a clone, not the original response, so the page keeps its own fetch behavior.
    const state = {
      captureId,
      providerType,
      text: "",
      lastEmitted: "",
      buffer: ""
    };

    try {
      const cloned = response.clone();
      const reader = cloned.body?.getReader?.();
      if (!reader) {
        emit("capture.done", {
          captureId,
          providerType,
          text: ""
        });
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (providerType === "kimi") {
          parseKimiBinaryChunk(value, state);
          continue;
        }
        buffer += decoder.decode(value, { stream: true });
        parseStreamingBufferChunk(buffer, providerType, state);
        buffer = "";
      }

      if (providerType === "kimi") {
        flushKimiBufferState(state);
      } else {
        parseStreamingBufferChunk(decoder.decode(), providerType, state);
        finalizeStreamingState(state);
      }

      log("capture done", {
        providerType,
        captureId,
        textLength: state.text.length,
        textPreview: clipText(state.text)
      });
      emit("capture.done", {
        captureId,
        providerType,
        text: state.text
      });
    } catch (error) {
      log("capture error", {
        providerType,
        captureId,
        error: String(error && error.message ? error.message : error)
      });
      emit("capture.error", {
        captureId,
        providerType,
        error: String(error && error.message ? error.message : error)
      });
    }
  }

  async function tapNonStreamingClone(providerType, captureId, response) {
    // Fallback for providers that return a final JSON payload instead of SSE.
    try {
      const cloned = response.clone();
      const text = await cloned.text();
      let answer = "";

      try {
        const payload = JSON.parse(text);
        answer = extractAssistantText(payload, providerType).text;
      } catch (_error) {
      }

      log("capture done", {
        providerType,
        captureId,
        textLength: answer.length,
        textPreview: clipText(answer)
      });
      emit("capture.done", {
        captureId,
        providerType,
        text: answer
      });
    } catch (error) {
      log("capture error", {
        providerType,
        captureId,
        error: String(error && error.message ? error.message : error)
      });
      emit("capture.error", {
        captureId,
        providerType,
        error: String(error && error.message ? error.message : error)
      });
    }
  }

  function decodeXHRBody(body) {
    if (typeof body === "string") {
      return body;
    }
    if (body instanceof URLSearchParams) {
      return body.toString();
    }
    return "";
  }

  log("installed", { href: location.href });

  window.fetch = async function webModelFetch(input, init) {
    // 这里的原则非常重要：
    // - 识别 provider 请求
    // - 自己旁路解析
    // - 原始 response 原样还给页面
    //
    // 也就是说：我们“观察”页面网络流，但不“接管”页面网络流。
    // Wrap fetch, emit capture lifecycle events, and always return the original response
    // untouched back to the page.
    const url = input instanceof Request ? input.url : String(input || "");
    const providerType = resolveProviderType(url);
    if (!providerType) {
      return originalFetch(input, init);
    }

    const bodyText = await resolveRequestBody(input, init);
    const capture = buildCapture(providerType, url, bodyText);
    emitCaptureStart(capture);

    const response = await originalFetch(input, init);
    const contentType = response.headers.get("content-type") || "";

    if (capture.providerType === "gemini" || capture.providerType === "kimi" || contentType.includes("text/event-stream")) {
      tapStreamingClone(capture.providerType, capture.captureId, response);
    } else {
      tapNonStreamingClone(capture.providerType, capture.captureId, response);
    }

    return response;
  };

  if (originalXHROpen && originalXHRSend) {
    window.XMLHttpRequest.prototype.open = function webModelOpen(method, url, ...rest) {
      this.__webModelHook = {
        method: String(method || ""),
        url: String(url || ""),
        providerType: resolveProviderType(url),
        capture: null,
        responseLength: 0,
        streamingState: null
      };
      return originalXHROpen.call(this, method, url, ...rest);
    };

    window.XMLHttpRequest.prototype.send = function webModelSend(body) {
      const hook = this.__webModelHook;
      if (!hook?.providerType) {
        return originalXHRSend.call(this, body);
      }

      const bodyText = decodeXHRBody(body);
      hook.capture = buildCapture(hook.providerType, hook.url, bodyText);
      hook.streamingState = {
        captureId: hook.capture.captureId,
        providerType: hook.capture.providerType,
        text: "",
        lastEmitted: "",
        buffer: ""
      };
      emitCaptureStart(hook.capture);

      this.addEventListener("progress", () => {
        if (typeof this.responseText !== "string") {
          return;
        }
        const chunk = this.responseText.slice(hook.responseLength);
        hook.responseLength = this.responseText.length;
        parseStreamingBufferChunk(chunk, hook.capture.providerType, hook.streamingState);
      });

      this.addEventListener("load", () => {
        if (typeof this.responseText === "string" && this.responseText.length > hook.responseLength) {
          const chunk = this.responseText.slice(hook.responseLength);
          hook.responseLength = this.responseText.length;
          parseStreamingBufferChunk(chunk, hook.capture.providerType, hook.streamingState);
        }
        finalizeStreamingState(hook.streamingState);
        log("capture done", {
          providerType: hook.capture.providerType,
          captureId: hook.capture.captureId,
          textLength: hook.streamingState.text.length,
          textPreview: clipText(hook.streamingState.text)
        });
        emit("capture.done", {
          captureId: hook.capture.captureId,
          providerType: hook.capture.providerType,
          text: hook.streamingState.text
        });
      });

      this.addEventListener("error", () => {
        log("capture error", {
          providerType: hook.capture.providerType,
          captureId: hook.capture.captureId,
          error: "xhr error"
        });
        emit("capture.error", {
          captureId: hook.capture.captureId,
          providerType: hook.capture.providerType,
          error: "xhr error"
        });
      });

      this.addEventListener("abort", () => {
        log("capture error", {
          providerType: hook.capture.providerType,
          captureId: hook.capture.captureId,
          error: "xhr aborted"
        });
        emit("capture.error", {
          captureId: hook.capture.captureId,
          providerType: hook.capture.providerType,
          error: "xhr aborted"
        });
      });

      return originalXHRSend.call(this, body);
    };
  }

  window[hookKey] = true;
})();
