const KEEPALIVE_INTERVAL_MS = 15000;
const KEEPALIVE_PORT_NAME = "web-model-offscreen-keepalive";
let keepalivePort = null;
let reconnectTimer = null;

function connectKeepalivePort() {
  if (keepalivePort) {
    return;
  }
  try {
    keepalivePort = chrome.runtime.connect({ name: KEEPALIVE_PORT_NAME });
  } catch (_error) {
    scheduleReconnect();
    return;
  }

  keepalivePort.onDisconnect.addListener(() => {
    keepalivePort = null;
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connectKeepalivePort();
  }, 1000);
}

function sendKeepalive() {
  if (!keepalivePort) {
    connectKeepalivePort();
  }
  try {
    keepalivePort?.postMessage({
      type: "ping",
      at: Date.now()
    });
  } catch (_error) {
  }
}

connectKeepalivePort();
sendKeepalive();
window.setInterval(sendKeepalive, KEEPALIVE_INTERVAL_MS);
