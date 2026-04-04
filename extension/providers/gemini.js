(function registerGeminiProvider(globalScope) {
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

  function createGeminiPageAdapter(log) {
    const GEMINI_USER_MESSAGE_SELECTOR = "user-query .query-text";
    const GEMINI_ASSISTANT_MESSAGE_SELECTOR = "model-response .markdown.markdown-main-panel";
    const GEMINI_COMPOSER_SELECTOR = "rich-textarea .ql-editor[contenteditable='true'][role='textbox']";
    const GEMINI_SEND_BUTTON_SELECTOR = "button.send-button.submit[aria-label='发送']";
    const GEMINI_BUSY_BUTTON_SELECTOR = ".blue-circle.stop-icon, mat-icon[fonticon='stop']";
    const GEMINI_NEW_CHAT_SELECTOR = "a.side-nav-action-button[href='/app'][aria-label='发起新对话']";

    return {
      clearConversation() {
        return 0;
      },

      async startNewChat() {
        const trigger = document.querySelector(GEMINI_NEW_CHAT_SELECTOR);
        if (!(trigger instanceof Element) || !isVisible(trigger)) {
          throw new Error("gemini new chat trigger not found");
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
        throw new Error("gemini composer not found");
      },

      findComposer() {
        const node = document.querySelector(GEMINI_COMPOSER_SELECTOR);
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
          if (normalizeText(current) === normalizeText(expected) && submitControl.mode === "ready") {
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
        for (let attempt = 0; attempt < 5; attempt += 1) {
          await delay(120);
          const currentButton = this.findSubmitButton(node) || button;
          const currentControl = this.describeSubmitControl(currentButton);
          if (currentControl.mode === "busy") {
            return;
          }
          if (this.isSendButtonClickable(currentButton)) {
            log("submit fallback via button", currentButton.getAttribute("aria-label") || currentButton.textContent || currentButton.tagName);
            clickLikeUser(currentButton);
            return;
          }
        }
      },

      findSubmitButton() {
        const sendButton = document.querySelector(GEMINI_SEND_BUTTON_SELECTOR);
        if (sendButton && isVisible(sendButton)) {
          return sendButton;
        }

        const stopIcon = document.querySelector(GEMINI_BUSY_BUTTON_SELECTOR);
        if (stopIcon instanceof Element && isVisible(stopIcon)) {
          return stopIcon.closest("button,[role='button'],div") || stopIcon;
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
        const waitRoot = document.querySelector("model-response")?.parentElement || composer?.closest?.("main") || document.body;
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
        return Array.from(document.querySelectorAll(GEMINI_ASSISTANT_MESSAGE_SELECTOR))
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
        const items = Array.from(document.querySelectorAll(GEMINI_USER_MESSAGE_SELECTOR))
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

        const tagName = button.tagName;
        const className = normalizeText(button.className || "");
        const hasStopIcon = button.matches(".blue-circle.stop-icon") || !!button.querySelector("mat-icon[fonticon='stop']") || button.matches("mat-icon[fonticon='stop']");
        const isSendButton = button.matches("button.send-button.submit") || !!button.closest("button.send-button.submit");
        const isDisabled = button.getAttribute("aria-disabled") === "true" ||
          button.hasAttribute("disabled") ||
          /disabled/i.test(className);

        return {
          present: true,
          mode: hasStopIcon ? "busy" : isSendButton && !isDisabled ? "ready" : isSendButton ? "disabled" : "unknown",
          tagName,
          className,
          hasStopIcon,
          isSendButton,
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
    type: "gemini",
    displayName: "Gemini",
    description: "Google Gemini bridge driven by the local web-model extension.",
    homepage: "https://gemini.google.com/",
    hostPatterns: ["https://gemini.google.com/*"],
    matchesURL(url) {
      return /^https:\/\/gemini\.google\.com\/.*/.test(String(url || ""));
    },
    buildTabKey(tabId) {
      return `gemini-tab-${tabId}`;
    },
    buildAutoKey(sequence) {
      return `gemini-${sequence}`;
    },
    createPageAdapter(log) {
      return createGeminiPageAdapter(log);
    }
  });
})(typeof self !== "undefined" ? self : globalThis);
