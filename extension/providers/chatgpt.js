(function registerChatGPTProvider(globalScope) {
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

  function createChatGPTPageAdapter(log) {
    // ChatGPT 的结构相对稳定很多，因此这里更多是状态判断问题，
    // 比如 idle / ready / busy 三种按钮形态怎么区分。
    // ChatGPT adapter. Stable ids and data-testid attributes make most controls easier to find.
    const CHATGPT_USER_MESSAGE_SELECTOR = "[data-message-author-role='user'] .whitespace-pre-wrap";
    const CHATGPT_ASSISTANT_MESSAGE_SELECTOR = "[data-message-author-role='assistant'] .markdown";
    const CHATGPT_COMPOSER_SELECTOR = "#prompt-textarea[contenteditable='true'][role='textbox']";
    const CHATGPT_SEND_BUTTON_SELECTOR = "#composer-submit-button";
    const CHATGPT_ACTIVE_SEND_BUTTON_SELECTOR = "#composer-submit-button[data-testid='send-button']";
    const CHATGPT_ACTIVE_STOP_BUTTON_SELECTOR = "#composer-submit-button[data-testid='stop-button']";
    const CHATGPT_IDLE_VOICE_BUTTON_SELECTOR = "button.composer-submit-button-color:not(#composer-submit-button):not([data-testid])";
    const CHATGPT_NEW_CHAT_SELECTOR = "a[data-testid='create-new-chat-button']";

    return {
      clearConversation() {
        return 0;
      },

      async startNewChat() {
        const trigger = document.querySelector(CHATGPT_NEW_CHAT_SELECTOR);
        if (!(trigger instanceof Element) || !isVisible(trigger)) {
          throw new Error("chatgpt new chat trigger not found");
        }
        log("start new chat", {
          tagName: trigger.tagName,
          text: normalizeText(trigger.textContent || ""),
          className: trigger.className || "",
          href: trigger.getAttribute("href") || ""
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
        throw new Error("chatgpt composer not found");
      },

      findComposer() {
        // Prefer the canonical prompt editor, then fall back to any visible textbox variant.
        const direct = document.querySelector(CHATGPT_COMPOSER_SELECTOR);
        if (direct && isVisible(direct)) {
          return direct;
        }

        const nodes = document.querySelectorAll("[contenteditable='true'][role='textbox'], textarea[name='prompt-textarea']");
        for (const node of nodes) {
          if (!isVisible(node)) {
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

        node.focus();
        node.textContent = "";
        document.execCommand("insertText", false, value);
        node.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
      },

      async ensureComposerValue(node, expected, attempts = 5, waitMs = 40) {
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
        throw new Error("composer value mismatch after retries");
      },

      readComposerValue(node) {
        if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
          return node.value || "";
        }
        return readNodeText(node);
      },

      async submitComposer(node, button = null) {
        // Enter is the primary submit path. Only click when the page surfaced a real send button.
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
        for (let attempt = 0; attempt < 5; attempt += 1) {
          await delay(120);
          const currentButton = this.findSubmitButton(node) || button;
          if (this.isSendButtonClickable(currentButton)) {
            log("submit fallback via button", currentButton.getAttribute("aria-label") || currentButton.textContent || currentButton.tagName);
            currentButton.click();
            return;
          }
        }
      },

      findSubmitButton() {
        const selectors = [
          CHATGPT_ACTIVE_STOP_BUTTON_SELECTOR,
          CHATGPT_ACTIVE_SEND_BUTTON_SELECTOR,
          CHATGPT_SEND_BUTTON_SELECTOR,
          CHATGPT_IDLE_VOICE_BUTTON_SELECTOR
        ];

        for (const selector of selectors) {
          const direct = document.querySelector(selector);
          if (direct && isVisible(direct)) {
            return direct;
          }
        }

        return null;
      },

      async waitForAssistantReply(requestId, composer, initialSubmitButton, prompt, baseline) {
        let sawBusy = false;
        let sawRecovered = false;
        let lastStreamedReply = "";
        let lastSettledReply = "";
        let stableReplyCount = 0;
        let lastProgressLogAt = 0;
        const waitRoot = document.querySelector("[data-message-author-role='assistant']")?.parentElement?.parentElement || composer?.closest?.("main") || document.body;
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
            } else if (sawBusy && !sawRecovered && (submitControl.mode === "ready" || submitControl.mode === "idle")) {
              sawRecovered = true;
              log("submit control recovered", {
                prompt,
                control: submitControl
              });
            }

            const assistantMessages = this.listAssistantMessages();
            const latestReply = assistantMessages.length > 0 ? normalizeText(readNodeText(assistantMessages[assistantMessages.length - 1])) : "";

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
              if (sawRecovered) {
                if (reply === lastSettledReply) {
                  stableReplyCount += 1;
                } else {
                  lastSettledReply = reply;
                  stableReplyCount = 1;
                }
                if (stableReplyCount >= 2) {
                  log("assistant reply after button recovered", {
                    prompt,
                    reply,
                    stableReplyCount
                  });
                  return reply;
                }
              }
            } else if (sawRecovered) {
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
        return {
          assistantCount: this.listAssistantMessages().length,
          assistantText: this.readLastAssistantReply(),
          assistantErrorCount: 0,
          assistantErrorText: ""
        };
      },

      listAssistantMessages() {
        return Array.from(document.querySelectorAll(CHATGPT_ASSISTANT_MESSAGE_SELECTOR))
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
        return [];
      },

      readLastAssistantError() {
        return "";
      },

      readLastUserPrompt() {
        const items = Array.from(document.querySelectorAll(CHATGPT_USER_MESSAGE_SELECTOR))
          .filter((node) => isVisible(node))
          .map((node) => normalizeText(readNodeText(node)))
          .filter(Boolean);
        if (!items.length) {
          return "";
        }
        return items[items.length - 1];
      },

      isLikelyUiNoise(text) {
        return !normalizeText(text);
      },

      isSubmitButtonReady(button) {
        return this.describeSubmitControl(button).mode === "ready";
      },

      isSendButtonClickable(button) {
        if (!(button instanceof Element) || !isVisible(button)) {
          return false;
        }
        const dataTestID = button.getAttribute("data-testid") || "";
        return button.id === "composer-submit-button" && dataTestID === "send-button";
      },

      describeSubmitControl(button) {
        if (!(button instanceof Element) || !isVisible(button)) {
          return {
            present: false,
            mode: "missing"
          };
        }

        const dataTestID = button.getAttribute("data-testid") || "";
        const ariaLabel = normalizeText(button.getAttribute("aria-label") || "");
        const className = normalizeText(button.className || "");
        const mode = this.detectSubmitControlMode(button, dataTestID, ariaLabel);

        return {
          present: true,
          mode,
          disabled: button instanceof HTMLButtonElement ? !!button.disabled : false,
          ariaDisabled: button.getAttribute("aria-disabled") === "true",
          className,
          dataTestID,
          ariaLabel
        };
      },

      detectSubmitControlMode(button, dataTestID, _ariaLabel) {
        if (button.id === "composer-submit-button" && dataTestID === "stop-button") {
          return "busy";
        }
        if (button.id === "composer-submit-button" && dataTestID === "send-button") {
          return "ready";
        }
        if (button.matches(CHATGPT_IDLE_VOICE_BUTTON_SELECTOR)) {
          return "idle";
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
    type: "chatgpt",
    displayName: "ChatGPT",
    description: "ChatGPT bridge driven by the local web-model extension.",
    homepage: "https://chatgpt.com/",
    hostPatterns: ["https://chatgpt.com/*"],
    matchesURL(url) {
      return /^https:\/\/chatgpt\.com\/.*/.test(String(url || ""));
    },
    buildTabKey(tabId) {
      return `chatgpt-tab-${tabId}`;
    },
    buildAutoKey(sequence) {
      return `chatgpt-${sequence}`;
    },
    createPageAdapter(log) {
      return createChatGPTPageAdapter(log);
    }
  });
})(typeof self !== "undefined" ? self : globalThis);
