(function registerYuanbaoProvider(globalScope) {
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

  function createYuanbaoPageAdapter(log) {
    const YUANBAO_USER_MESSAGE_SELECTOR = ".agent-chat__list__item--human .hyc-content-text";
    const YUANBAO_ASSISTANT_MESSAGE_SELECTOR = ".agent-chat__list__item--ai .hyc-common-markdown-style";
    const YUANBAO_COMPOSER_SELECTOR = ".ql-editor[contenteditable='true']";
    const YUANBAO_SEND_BUTTON_SELECTOR = "#yuanbao-send-btn";
    const YUANBAO_BUSY_BUTTON_SELECTOR = "a.style__send-btn___RwTm5:not(#yuanbao-send-btn)";
    const YUANBAO_NEW_CHAT_SELECTOR = "span.icon-yb-ic_newchat_20";

    return {
      clearConversation() {
        return 0;
      },

      async startNewChat() {
        const icon = document.querySelector(YUANBAO_NEW_CHAT_SELECTOR);
        const trigger = icon instanceof Element ? (icon.closest("button,[role='button'],a,div") || icon) : null;
        if (!(trigger instanceof Element) || !isVisible(trigger)) {
          throw new Error("yuanbao new chat trigger not found");
        }
        log("start new chat", {
          tagName: trigger.tagName,
          text: normalizeText(trigger.textContent || ""),
          className: trigger.className || "",
          role: trigger.getAttribute("role") || ""
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
        throw new Error("yuanbao composer not found");
      },

      findComposer() {
        const node = document.querySelector(YUANBAO_COMPOSER_SELECTOR);
        return node instanceof Element && isVisible(node) ? node : null;
      },

      focusComposer(node) {
        clickLikeUser(node);
        node.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(node);
        range.collapse(false);
        selection?.removeAllRanges();
        selection?.addRange(range);
      },

      setComposerValue(node, value) {
        this.focusComposer(node);
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(node);
        selection?.removeAllRanges();
        selection?.addRange(range);
        node.dispatchEvent(new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          data: value,
          inputType: "insertText"
        }));
        range.deleteContents();
        range.collapse(false);
        selection?.removeAllRanges();
        selection?.addRange(range);

        let inserted = false;
        try {
          document.execCommand("selectAll", false);
          inserted = document.execCommand("insertText", false, value);
        } catch (_error) {
        }

        if (normalizeText(readNodeText(node)) !== normalizeText(value || "")) {
          try {
            const clipboardData = new DataTransfer();
            clipboardData.setData("text/plain", value);
            node.dispatchEvent(new ClipboardEvent("paste", {
              bubbles: true,
              cancelable: true,
              clipboardData
            }));
          } catch (_error) {
          }
        }

        if (normalizeText(readNodeText(node)) !== normalizeText(value || "")) {
          const paragraph = document.createElement("p");
          paragraph.textContent = value || "";
          node.replaceChildren(paragraph);
        }

        if (value) {
          node.classList.remove("ql-blank");
        } else {
          node.classList.add("ql-blank");
        }

        const tailRange = document.createRange();
        tailRange.selectNodeContents(node);
        tailRange.collapse(false);
        selection?.removeAllRanges();
        selection?.addRange(tailRange);
        node.dispatchEvent(new InputEvent("input", {
          bubbles: true,
          data: value,
          inputType: inserted ? "insertText" : "insertFromPaste"
        }));
        if (!inserted) {
          node.dispatchEvent(new Event("change", { bubbles: true }));
        }
      },

      async ensureComposerValue(node, expected, attempts = 5, waitMs = 40) {
        for (let index = 0; index < attempts; index += 1) {
          const current = this.readComposerValue(node);
          const submitControl = this.describeSubmitControl(this.findSubmitButton(node));
          if (
            normalizeText(current) === normalizeText(expected) &&
            submitControl.mode === "ready"
          ) {
            log("composer value confirmed", {
              expected,
              attempt: index + 1,
              submitMode: submitControl.mode
            });
            return;
          }
          await delay(waitMs);
        }

        const current = this.readComposerValue(node);
        const submitControl = this.describeSubmitControl(this.findSubmitButton(node));
        log("composer value mismatch", {
          expected,
          actual: current,
          submitMode: submitControl.mode,
          submitControl
        });
        throw new Error("composer value mismatch after retries");
      },

      readComposerValue(node) {
        return readNodeText(node);
      },

      async submitComposer(node, button = null) {
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
        if (this.isSendButtonClickable(button)) {
          log("submit fallback via button", button.getAttribute("aria-label") || button.textContent || button.tagName);
          clickLikeUser(button);
        }
      },

      findSubmitButton() {
        const sendButton = document.querySelector(YUANBAO_SEND_BUTTON_SELECTOR);
        if (sendButton && isVisible(sendButton)) {
          return sendButton;
        }
        const busyButton = document.querySelector(YUANBAO_BUSY_BUTTON_SELECTOR);
        if (busyButton && isVisible(busyButton)) {
          return busyButton;
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
        const waitRoot = document.querySelector(".agent-chat__list__item--ai")?.parentElement || composer?.closest?.("main") || document.body;
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
            } else if (sawBusy && !sawRecovered && submitControl.mode === "ready") {
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
                baseline.onDelta?.(requestId, delta);
              }
              if (reply === lastSettledReply) {
                stableReplyCount += 1;
              } else {
                lastSettledReply = reply;
                stableReplyCount = 1;
              }
              if (sawRecovered && stableReplyCount >= 2) {
                return reply;
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
        return Array.from(document.querySelectorAll(YUANBAO_ASSISTANT_MESSAGE_SELECTOR))
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
        const items = Array.from(document.querySelectorAll(YUANBAO_USER_MESSAGE_SELECTOR))
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
        return this.describeSubmitControl(button).mode === "ready";
      },

      describeSubmitControl(button) {
        if (!(button instanceof Element) || !isVisible(button)) {
          return {
            present: false,
            mode: "missing"
          };
        }

        const hasSendID = button.id === "yuanbao-send-btn";
        const hasStopIcon = !!button.querySelector("svg rect");
        const className = normalizeText(button.className || "");
        const isDisabled = /disabled/i.test(className) ||
          button.getAttribute("aria-disabled") === "true" ||
          button.hasAttribute("disabled");

        return {
          present: true,
          mode: hasStopIcon ? "busy" : hasSendID && !isDisabled ? "ready" : hasSendID ? "disabled" : "unknown",
          className,
          hasSendID,
          hasStopIcon,
          isDisabled
        };
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
    type: "yuanbao",
    displayName: "Yuanbao",
    description: "Tencent Yuanbao bridge driven by the local web-model extension.",
    homepage: "https://yuanbao.tencent.com/",
    hostPatterns: ["https://yuanbao.tencent.com/*"],
    matchesURL(url) {
      return /^https:\/\/yuanbao\.tencent\.com\/.*/.test(String(url || ""));
    },
    buildTabKey(tabId) {
      return `yuanbao-tab-${tabId}`;
    },
    buildAutoKey(sequence) {
      return `yuanbao-${sequence}`;
    },
    createPageAdapter(log) {
      return createYuanbaoPageAdapter(log);
    }
  });
})(typeof self !== "undefined" ? self : globalThis);
