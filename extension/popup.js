// popup 控制器。
//
// popup 故意保持很薄，只负责：
// - 保存 server URL
// - 切当前 tab 的启用状态
// - 展示 background 返回的状态快照
//
// popup 本身不推断 provider 状态，也不维护复杂运行时逻辑。
const DEFAULT_CONFIG = {
  serverUrl: "ws://127.0.0.1:18080/ws",
  debugLogs: false
};

document.addEventListener("DOMContentLoaded", async () => {
  const values = await chrome.storage.local.get(Object.keys(DEFAULT_CONFIG));
  document.getElementById("serverUrl").value = values.serverUrl ?? DEFAULT_CONFIG.serverUrl;
  document.getElementById("debugLogs").checked = values.debugLogs ?? DEFAULT_CONFIG.debugLogs;

  document.getElementById("save").addEventListener("click", saveConfig);
  document.getElementById("enabled").addEventListener("change", toggleEnabled);

  await refreshStatus();
  window.setInterval(() => {
    refreshStatus().catch((error) => {
      renderStatus({
        level: "error",
        text: String(error)
      });
    });
  }, 1000);
});

async function saveConfig() {
  // Save config first, then ask background to refresh runtime state using the new values.
  renderStatus({
    level: "warn",
    text: "Saving..."
  });

  await chrome.storage.local.set({
    serverUrl: document.getElementById("serverUrl").value.trim(),
    debugLogs: !!document.getElementById("debugLogs").checked
  });

  const tabId = await getCurrentTabID();
  const response = await chrome.runtime.sendMessage({ type: "config.updated", tabId });

  if (!response?.ok) {
    renderStatus({
      level: "error",
      text: response?.error || "save failed"
    });
    return;
  }

  renderStatus({
    level: "ok",
    text: "Saved"
  });
  await refreshStatus();
}

async function toggleEnabled(event) {
  // Registration is per active tab by design.
  const tabId = await getCurrentTabID();
  if (typeof tabId !== "number") {
    renderStatus({
      level: "error",
      text: "active tab not found"
    });
    event.target.checked = false;
    return;
  }
  const response = await chrome.runtime.sendMessage({
    type: "provider.toggle",
    tabId,
    enabled: !!event.target.checked
  });

  if (!response?.ok) {
    renderStatus({
      level: "error",
      text: response?.error || "toggle failed"
    });
    await refreshStatus();
    return;
  }

  await refreshStatus();
}

async function refreshStatus() {
  // Popup never infers state itself. Background returns a normalized status object.
  const tabId = await getCurrentTabID();
  const response = await chrome.runtime.sendMessage({ type: "connection.status", tabId });
  if (!response?.ok) {
    renderStatus({
      level: "error",
      text: response?.error || "status unavailable"
    });
    return;
  }

  document.getElementById("enabled").checked = !!response.enabled;

  let level = "warn";
  if (response.state === "connected" || /registered/i.test(response.detail || "")) {
    level = "ok";
  } else if (response.state === "error" || response.state === "unsupported") {
    level = "error";
  }

  renderStatus({
    level,
    text: [
      `Enabled: ${response.enabled ? "on" : "off"}`,
      `Debug: ${response.debugLogs ? "on" : "off"}`,
      `State: ${response.state}`,
      response.providerType ? `Provider: ${response.providerType}` : "Provider: pending",
      response.providerKey ? `Key: ${response.providerKey}` : "Key: pending",
      response.detail ? `Detail: ${response.detail}` : "",
      response.page?.url ? `Page: ${response.page.url}` : "Page: not ready",
      response.lastError ? `Error: ${response.lastError}` : ""
    ].filter(Boolean).join("\n")
  });
}

function renderStatus({ level, text }) {
  const statusNode = document.getElementById("status");
  statusNode.className = level || "";
  statusNode.textContent = text || "";
}

async function getCurrentTabID() {
  // Always operate on the active tab in the current window.
  const tabs = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });
  return tabs[0]?.id ?? null;
}
