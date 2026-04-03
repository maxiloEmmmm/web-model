(function registerQwenProvider(globalScope) {
  const shared = globalScope.WEB_MODEL_PROVIDER_SHARED;
  const {
    REQUEST_ACTIVE_POLL_INTERVAL_MS,
    clickLikeUser,
    createActivityMonitor,
    delay,
    estimateTokens,
    isVisible,
    normalizeText,
    readNodeText,
    registerProvider
  } = shared;

  function createQwenPageAdapter(log) {
    // Qwen 是当前最容易踩坑的 provider：
    // - 页面 class 层级深
    // - 新建聊天入口不是标准 button
    // - 回复结束判断以前也经常和页面渲染时机纠缠
    //
    // 所以这里保留了比较多的显式辅助函数，避免把逻辑挤成一团。
    // Qwen adapter. Submission and new-chat are DOM-driven; reply extraction prefers network
    // capture and falls back to DOM observation only when needed.
    const QWEN_USER_MESSAGE_SELECTOR = "#chat-messages-scroll-container .qwen-chat-message-user .user-message-content";
    const QWEN_ASSISTANT_MESSAGE_SELECTOR = "#chat-messages-scroll-container .qwen-chat-message-assistant .response-message-content.t2t.phase-answer .qwen-markdown";
    const QWEN_ASSISTANT_ERROR_SELECTOR = "#chat-messages-scroll-container .qwen-chat-message-assistant .qwen-messsage-status-description";
    const QWEN_SEND_BUTTON_SELECTOR = ".message-input-right-button-send .chat-prompt-send-button button";

    return {
      clearConversation() {
        // Intentionally a no-op. Earlier versions deleted chat DOM and broke the page.
        return 0;
      },

      findNewChatTrigger() {
        const items = Array.from(document.querySelectorAll(".sidebar-entry-fixed-list-content"));
        for (const item of items) {
          if (!(item instanceof Element) || !isVisible(item)) {
            continue;
          }
          if (item === document.documentElement || item === document.body) {
            continue;
          }
          return item;
        }
        return null;
      },

      async startNewChat() {
        // 这里只代表“尝试点击新建聊天入口”，不代表页面一定已经切到新会话。
        // 是否真的成功，最终要看页面后续行为和上报的 startedNewChat。
        const trigger = this.findNewChatTrigger();
        if (!trigger) {
          throw new Error("qwen new chat trigger not found");
        }
        log("start new chat", {
          tagName: trigger.tagName,
          text: normalizeText(trigger.textContent || ""),
          className: trigger.className || "",
          role: trigger.getAttribute("role") || "",
          tabIndex: trigger.getAttribute("tabindex") || ""
        });
        clickLikeUser(trigger);
        await delay(1000);
      },

      async waitForComposer(timeoutMs = 15000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const composer = this.findComposer();
          if (composer) {
            return composer;
          }
          await delay(200);
        }
        throw new Error("qwen composer not found");
      },

      findComposer() {
        // Qwen may expose textarea/contenteditable/textbox variants depending on page state.
        const selectors = [
          "textarea",
          "[contenteditable='true']",
          "[role='textbox']"
        ];

        const nodes = document.querySelectorAll(selectors.join(","));
        for (const node of nodes) {
          if (!isVisible(node)) {
            continue;
          }
          if (node.matches("textarea,input") && (node.disabled || node.readOnly)) {
            continue;
          }
          if (node.getAttribute("placeholder") === "Search Chats") {
            continue;
          }
          return node;
        }
        return null;
      },

      focusComposer(node) {
        node.focus();
      },

      setComposerValue(node, value) {
        // Framework-controlled inputs usually need native setters plus synthetic events.
        if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
          const prototype = Object.getPrototypeOf(node);
          const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
          if (descriptor?.set) {
            descriptor.set.call(node, value);
          } else {
            node.value = value;
          }
          node.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
          node.dispatchEvent(new Event("change", { bubbles: true }));
          return;
        }

        node.textContent = value;
        node.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
      },

      async ensureComposerValue(node, expected, attempts = 3, waitMs = 20) {
        // Confirm the page accepted the prompt before submit.
        for (let index = 0; index < attempts; index += 1) {
          const current = this.readComposerValue(node);
          if (normalizeText(current) === normalizeText(expected)) {
            log("composer value confirmed", {
              expected,
              attempt: index + 1
            });
            return;
          }
          await delay(waitMs);
        }

        const current = this.readComposerValue(node);
        log("composer value mismatch", {
          expected,
          actual: current
        });
        throw new Error("composer value mismatch after 3 retries");
      },

      readComposerValue(node) {
        if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
          return node.value || "";
        }
        return readNodeText(node);
      },

      async submitComposer(node, button = null) {
        // Prefer the Enter path first, then use a button fallback if the page ignored it.
        log("submit via Enter key");
        for (const type of ["keydown", "keypress", "keyup"]) {
          node.dispatchEvent(new KeyboardEvent(type, {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            which: 13,
            bubbles: true
          }));
        }

        button = button || this.findSubmitButton(node);
        if (button) {
          window.setTimeout(() => {
            if (this.isSubmitButtonReady(button)) {
              log("submit fallback via button", button.getAttribute("aria-label") || button.textContent || button.tagName);
              button.click();
            }
          }, 150);
        }
      },

      findSubmitButton(node) {
        // Prefer the known send selector; otherwise approximate with the nearest visible button.
        const direct = document.querySelector(QWEN_SEND_BUTTON_SELECTOR);
        if (direct && isVisible(direct)) {
          return direct;
        }

        const composerRect = node.getBoundingClientRect();
        const buttons = Array.from(document.querySelectorAll("button,[role='button']"));

        let best = null;
        let bestScore = Number.POSITIVE_INFINITY;

        for (const button of buttons) {
          if (!isVisible(button)) {
            continue;
          }
          const rect = button.getBoundingClientRect();
          const distance = Math.abs(rect.top - composerRect.top) + Math.abs(rect.left - composerRect.right);
          if (distance < bestScore && rect.width > 0 && rect.height > 0) {
            best = button;
            bestScore = distance;
          }
        }

        return bestScore < 240 ? best : null;
      },

      async waitForAssistantReply(requestId, composer, initialSubmitButton, prompt, baseline) {
        // Fallback-only path when network capture is unavailable or not supported.
        let sawBusy = false;
        let sawRecovered = false;
        let lastStreamedReply = "";
        let lastSettledReply = "";
        let stableReplyCount = 0;
        let lastProgressLogAt = 0;
        const waitRoot = document.querySelector("#chat-messages-scroll-container") || composer?.closest?.("#chat-message-container") || document.body;
        const activityMonitor = createActivityMonitor(waitRoot, REQUEST_ACTIVE_POLL_INTERVAL_MS);

        try {
          while (true) {
            const submitButton = this.findSubmitButton(composer) || initialSubmitButton;
            const submitControl = this.describeSubmitControl(submitButton);

            if (!sawBusy && submitControl.mode === "busy") {
              sawBusy = true;
              log("submit control changed", {
                prompt,
                control: submitControl
              });
            } else if (sawBusy && !sawRecovered && submitControl.mode !== "busy" && submitControl.mode !== "missing") {
              sawRecovered = true;
              log("submit control recovered", {
                prompt,
                control: submitControl
              });
            }

            const assistantErrors = this.listAssistantErrors();
            const latestError = assistantErrors.length > 0 ? normalizeText(readNodeText(assistantErrors[assistantErrors.length - 1])) : "";
            const assistantMessages = this.listAssistantMessages();
            const latestReply = assistantMessages.length > 0 ? normalizeText(readNodeText(assistantMessages[assistantMessages.length - 1])) : "";

            const hasNewAssistantError = assistantErrors.length > baseline.assistantErrorCount;
            const latestErrorChanged = latestError && latestError !== baseline.assistantErrorText;
            if ((hasNewAssistantError || latestErrorChanged) && latestError) {
              log("chat failure", {
                prompt,
                error: latestError
              });
              throw new Error(latestError);
            }

            const hasNewAssistantMessage = assistantMessages.length > baseline.assistantCount;
            const latestReplyChanged = latestReply && latestReply !== baseline.assistantText;
            const reply = hasNewAssistantMessage || latestReplyChanged ? latestReply : "";

            if (Date.now() - lastProgressLogAt >= 1000) {
              lastProgressLogAt = Date.now();
              log("wait progress", {
                requestId,
                prompt,
                visibilityState: document.visibilityState,
                hasFocus: document.hasFocus(),
                submitMode: submitControl.mode,
                assistantCount: assistantMessages.length,
                baselineAssistantCount: baseline.assistantCount,
                latestReplyLength: latestReply.length,
                stableReplyCount
              });
            }

            if (reply && !this.isLikelyUiNoise(reply)) {
              const delta = this.computeReplyDelta(lastStreamedReply, reply);
              if (delta) {
                lastStreamedReply = reply;
                log("assistant reply candidate", {
                  prompt,
                  reply,
                  delta,
                  buttonRecovered: sawRecovered
                });
                baseline.onDelta?.(requestId, delta);
              }
              if (reply === lastSettledReply) {
                stableReplyCount += 1;
              } else {
                lastSettledReply = reply;
                stableReplyCount = 1;
              }

              if (sawRecovered && stableReplyCount >= 2) {
                log("assistant reply after button recovered", {
                  prompt,
                  reply,
                  stableReplyCount
                });
                return reply;
              }

              if (!sawBusy && stableReplyCount >= 4 && submitControl.mode !== "busy") {
                log("assistant reply settled without busy signal", {
                  prompt,
                  reply,
                  stableReplyCount,
                  control: submitControl
                });
                return reply;
              }
            } else {
              stableReplyCount = 0;
              lastSettledReply = "";
            }

            await activityMonitor.next(REQUEST_ACTIVE_POLL_INTERVAL_MS);
          }
        } finally {
          activityMonitor.stop();
        }
      },

      captureBaseline() {
        // Baseline lets fallback logic ignore old assistant messages and focus on fresh output.
        return {
          assistantCount: this.listAssistantMessages().length,
          assistantText: this.readLastAssistantReply(),
          assistantErrorCount: this.listAssistantErrors().length,
          assistantErrorText: this.readLastAssistantError()
        };
      },

      listAssistantMessages() {
        return Array.from(document.querySelectorAll(QWEN_ASSISTANT_MESSAGE_SELECTOR))
          .filter((node) => isVisible(node))
          .filter((node) => normalizeText(readNodeText(node)).length > 0);
      },

      readLastAssistantReply() {
        const items = this.listAssistantMessages();
        if (!items.length) {
          return "";
        }
        return normalizeText(readNodeText(items[items.length - 1]));
      },

      listAssistantErrors() {
        return Array.from(document.querySelectorAll(QWEN_ASSISTANT_ERROR_SELECTOR))
          .filter((node) => isVisible(node))
          .filter((node) => normalizeText(readNodeText(node)).length > 0);
      },

      readLastAssistantError() {
        const items = this.listAssistantErrors();
        if (!items.length) {
          return "";
        }
        return normalizeText(readNodeText(items[items.length - 1]));
      },

      readLastUserPrompt() {
        const items = Array.from(document.querySelectorAll(QWEN_USER_MESSAGE_SELECTOR))
          .filter((node) => isVisible(node))
          .map((node) => normalizeText(readNodeText(node)))
          .filter(Boolean);
        if (!items.length) {
          return "";
        }
        return items[items.length - 1];
      },

      isLikelyUiNoise(text) {
        const compact = normalizeText(text);
        if (!compact) {
          return true;
        }

        const exactNoise = new Set([
          "快速",
          "Auto",
          "Search Chats",
          "New Chat",
          "Community",
          "Projects",
          "All chats",
          "Voice Input"
        ]);
        if (exactNoise.has(compact)) {
          return true;
        }

        if (compact.length <= 80 && compact.includes("人工智能生成的内容可能不准确")) {
          return true;
        }
        if (compact.length <= 80 && compact.includes("Thinking completed")) {
          return true;
        }
        return false;
      },

      isSubmitButtonReady(button) {
        if (!(button instanceof Element) || !isVisible(button)) {
          return false;
        }
        if (button instanceof HTMLButtonElement && button.disabled) {
          return false;
        }
        if (button.getAttribute("aria-disabled") === "true") {
          return false;
        }
        return true;
      },

      describeSubmitControl(button) {
        if (!(button instanceof Element) || !isVisible(button)) {
          return {
            present: false,
            mode: "missing"
          };
        }

        const iconNode = button.querySelector("use");
        const iconUse = iconNode?.getAttribute("xlink:href") || iconNode?.getAttribute("href") || "";
        const className = normalizeText(button.className || "");
        const mode = this.detectSubmitControlMode(button, iconUse);

        return {
          present: true,
          mode,
          disabled: button instanceof HTMLButtonElement ? !!button.disabled : false,
          ariaDisabled: button.getAttribute("aria-disabled") === "true",
          className,
          iconUse
        };
      },

      detectSubmitControlMode(button, iconUse) {
        const className = normalizeText(button.className || "");
        const hasStopClass = button.classList.contains("stop-button") || className.includes("stop-button");
        const hasStopIcon = !!button.querySelector(".icon-stop use") || iconUse === "#icon-fill-stop-011";
        const hasSendIcon = !!button.querySelector(".icon-send use") || iconUse === "#icon-line-arrow-up";

        if (hasStopClass || hasStopIcon) {
          return "busy";
        }
        if (hasSendIcon) {
          return "ready";
        }
        return "unknown";
      },

      computeReplyDelta(previous, current) {
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
      },

      estimateTokens
    };
  }

  registerProvider({
    type: "qwen",
    displayName: "Qwen",
    description: "Qwen bridge driven by the local web-model extension.",
    homepage: "https://chat.qwen.ai/",
    hostPatterns: ["https://chat.qwen.ai/*"],
    matchesURL(url) {
      return /^https:\/\/chat\.qwen\.ai\/.*/.test(String(url || ""));
    },
    buildTabKey(tabId) {
      return `qwen-tab-${tabId}`;
    },
    buildAutoKey(sequence) {
      return `qwen-${sequence}`;
    },
    createPageAdapter(log) {
      return createQwenPageAdapter(log);
    }
  });
})(typeof self !== "undefined" ? self : globalThis);
