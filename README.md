# web-model

`web-model` turns real browser chat tabs into a local OpenAI-compatible API.

It runs a local Go server, accepts browser extension registrations over WebSocket, and exposes each registered tab as a model under `/v1/models`. When you call `/v1/chat/completions`, the request is forwarded into the real web page, the extension submits the prompt, then returns the parsed answer.

## What It Is

- A local HTTP server.
- A local WebSocket registration hub for browser tabs.
- A Manifest V3 Chrome/Edge extension.
- A bridge from OpenAI-style chat requests to real web chat pages.

## What It Is Not

- It is not a general browser automation framework.
- It does not handle login, captcha, onboarding, paywall checks, or site policy restrictions.
- It does not bypass product limits on the target site.
- It does not make unsupported pages magically work.

The rule is simple: if the page is not already usable by hand, `web-model` is not responsible for making it usable.

## Supported Sites

- ChatGPT: `https://chatgpt.com/`
- Qwen: `https://chat.qwen.ai/`
- Gemini: `https://gemini.google.com/`
- Kimi: `https://www.kimi.com/`
- Yuanbao: `https://yuanbao.tencent.com/`

## How It Works

1. Start the local server.
2. Load the extension from [`extension/`](./extension).
3. Open one of the supported sites in a normal browser tab.
4. Complete all page-side prerequisites by hand:
   login, auth, onboarding, model selection, access approval, and anything else the site requires.
5. Keep the site's left sidebar visible.
   If the sidebar is collapsed, extension-driven `start new chat` actions may fail.
6. In the extension popup, set the local WebSocket server URL and enable the current tab.
7. The extension registers that tab to `ws://<addr>/ws`.
8. The server exposes the registered tab key in `/v1/models`.
9. You call `/v1/chat/completions` with that key as the `model`.

At a high level:

`HTTP client -> web-model server -> extension background -> content script -> real web page`

## Repository Layout

- [`cmd/web-model/main.go`](/Users/maxilo202/Downloads/code/_TEST/web-model/cmd/web-model/main.go)
  Main server entry.
- [`internal/api/server.go`](/Users/maxilo202/Downloads/code/_TEST/web-model/internal/api/server.go)
  OpenAI-compatible HTTP API.
- [`internal/agent/manager.go`](/Users/maxilo202/Downloads/code/_TEST/web-model/internal/agent/manager.go)
  Live provider registry and request dispatch.
- [`extension/background.js`](/Users/maxilo202/Downloads/code/_TEST/web-model/extension/background.js)
  Extension background service worker.
- [`extension/content.js`](/Users/maxilo202/Downloads/code/_TEST/web-model/extension/content.js)
  Browser page bridge.
- [`extension/page-hook.js`](/Users/maxilo202/Downloads/code/_TEST/web-model/extension/page-hook.js)
  Page-world network hook.
- [`extension/providers/`](/Users/maxilo202/Downloads/code/_TEST/web-model/extension/providers)
  Site-specific page adapters.
- [`scripts/chat_by_type.go`](/Users/maxilo202/Downloads/code/_TEST/web-model/scripts/chat_by_type.go)
  Helper CLI for picking a registered tab by provider type.

## Requirements

- Go installed.
- Chrome or Edge.
- Ability to load an unpacked extension.
- A browser profile where the target site is already logged in and usable.

## Start The Server

Run:

```bash
go run ./cmd/web-model
```

Default HTTP address:

```text
127.0.0.1:8080
```

Default WebSocket address:

```text
ws://127.0.0.1:8080/ws
```

Useful flags:

```bash
go run ./cmd/web-model -h
go run ./cmd/web-model -cn
go run ./cmd/web-model -addr 127.0.0.1:18080
go run ./cmd/web-model -max-chats-per-session 10
```

Useful env vars:

- `ADDR`
- `MAX_CHATS_PER_SESSION`

## Load The Extension

The extension manifest is:

- [`manifest.json`](/Users/maxilo202/Downloads/code/_TEST/web-model/extension/manifest.json)

### Chrome

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select the `extension/` directory

### Edge

1. Open `edge://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select the same `extension/` directory

## Configure The Extension

Open the extension popup.

Current popup fields are:

- `Server URL`
- `Enable Current Tab`
- `Debug Logs`

Recommended value for `Server URL` if you use the server default:

```text
ws://127.0.0.1:8080/ws
```

Then:

1. Open a supported site.
2. Make sure the page is fully usable by hand.
3. Keep the left sidebar expanded.
4. Open the popup.
5. Set `Server URL`.
6. Click `Save`.
7. Turn on `Enable Current Tab`.

The toolbar badge reflects runtime state without opening the popup:

- Green `ON`: registered
- Yellow `...`: connecting or waiting
- Red `!`: error
- Blank: disabled or inactive

## API Endpoints

### `GET /healthz`

Basic health response.

Example:

```bash
curl http://127.0.0.1:8080/healthz
```

### `GET /providers`

Raw provider list.

Example:

```bash
curl http://127.0.0.1:8080/providers
```

### `GET /v1/models`

OpenAI-compatible model list. Registered browser tabs appear here.

Example:

```bash
curl http://127.0.0.1:8080/v1/models
```

Typical response shape:

```json
{
  "object": "list",
  "data": [
    {
      "id": "kimi-tab-2123080689",
      "object": "model",
      "created": 0,
      "owned_by": "web-model",
      "metadata": {
        "key": "kimi-tab-2123080689",
        "type": "kimi"
      }
    }
  ]
}
```

### `POST /v1/chat/completions`

OpenAI-compatible chat completions endpoint.

Non-stream example:

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "kimi-tab-2123080689",
    "messages": [
      { "role": "user", "content": "hi" }
    ]
  }'
```

Stream example:

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "kimi-tab-2123080689",
    "stream": true,
    "messages": [
      { "role": "user", "content": "hi" }
    ]
  }'
```

### `WS /ws`

Internal extension registration channel.

You normally do not call this yourself.

## Important Operational Notes

- Every provider page must already be fully usable by hand before `web-model` drives it.
- `web-model` only does the simple part: send the prompt and parse the answer.
- Site-side restrictions are outside its scope:
  auth, rate limits, captcha, consent dialogs, model permissions, business logic, paywalls, and other product restrictions.
- Keep the provider page's left sidebar visible.
  If it is collapsed, extension-driven `start new chat` may fail.
- Refreshing a tab clears its active registration state.
  Re-enable the tab from the popup if needed.

## Streaming Notes

`web-model` supports streaming from the local API side, but each provider is captured differently:

- Qwen: network stream capture
- ChatGPT: network stream capture
- Gemini: fetch-based framed streaming
- Kimi: fetch-based binary framed streaming
- Yuanbao: network stream capture

Formatting quality in streaming mode depends on what the target site emits incrementally. Some sites may deliver markdown or spacing in chunks that look rough while streaming but are correct in the final answer.

## Detailed End-To-End Example

This example uses Kimi and the local server default `127.0.0.1:8080`.

### 1. Start the server

```bash
go run ./cmd/web-model
```

Expected:

- local HTTP server on `http://127.0.0.1:8080`
- local WebSocket endpoint on `ws://127.0.0.1:8080/ws`
- monitor TUI in the terminal

### 2. Load the extension

In Chrome or Edge:

1. Open the extensions page.
2. Turn on developer mode.
3. Load unpacked extension from [`extension/`](./extension).

### 3. Prepare the web page

Open:

```text
https://www.kimi.com/
```

Before doing anything with `web-model`, make sure all of this is already done by hand:

- you are logged in
- the chat page is usable
- no onboarding popup blocks the editor
- the target model/page is available
- the left sidebar is visible and not collapsed

If any of these fail, `web-model` is not the layer to fix it.

### 4. Configure the popup

Open the extension popup and set:

- `Server URL` = `ws://127.0.0.1:8080/ws`
- `Enable Current Tab` = checked
- `Debug Logs` = optional

Click `Save` if you changed the URL.

### 5. Confirm registration

Check the toolbar badge:

- `ON` in green means the tab is registered

Or call:

```bash
curl http://127.0.0.1:8080/v1/models
```

Look for a model like:

```json
{
  "id": "kimi-tab-2123080689",
  "metadata": {
    "key": "kimi-tab-2123080689",
    "type": "kimi"
  }
}
```

The exact key will be different on your machine.

### 6. Send one normal request

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "kimi-tab-2123080689",
    "messages": [
      {
        "role": "user",
        "content": "hi, ospf and bgp"
      }
    ]
  }'
```

What happens internally:

1. The server receives the OpenAI-style request.
2. It looks up `kimi-tab-2123080689`.
3. It forwards the request to the extension background worker.
4. The content script fills the Kimi page input box.
5. The page hook captures Kimi's network response stream.
6. The final parsed assistant text is returned as a normal OpenAI-compatible response.

### 7. Send one stream request

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "kimi-tab-2123080689",
    "stream": true,
    "messages": [
      {
        "role": "user",
        "content": "hi, ospf and bgp"
      }
    ]
  }'
```

This returns SSE-style chunks from the local server.

### 8. Use the helper CLI by provider type

There is also a helper script:

- [`chat_by_type.go`](/Users/maxilo202/Downloads/code/_TEST/web-model/scripts/chat_by_type.go)

It picks a registered model key by provider type automatically.

Important:

- the script defaults to `http://127.0.0.1:18080`
- if your server is on `127.0.0.1:8080`, set `WEB_MODEL_BASE_URL`

Non-stream example:

```bash
WEB_MODEL_BASE_URL=http://127.0.0.1:8080 \
go run ./scripts/chat_by_type.go kimi "hi, ospf and bgp"
```

Stream example:

```bash
WEB_MODEL_BASE_URL=http://127.0.0.1:8080 \
go run ./scripts/chat_by_type.go --stream kimi "hi, ospf and bgp"
```

What this script does:

1. Calls `/v1/models`
2. Filters by provider type, for example `kimi`
3. Picks one matching model key at random
4. Sends `/v1/chat/completions`
5. Prints the answer

### 9. If it fails, check in this order

1. Can you use the site by hand in that tab?
2. Is the left sidebar visible?
3. Is the extension popup `Enable Current Tab` checked?
4. Does the toolbar badge show green `ON`?
5. Does `/v1/models` contain the expected provider key?
6. Is the popup `Server URL` pointing to the actual server you started?
7. If using `chat_by_type.go`, did you set `WEB_MODEL_BASE_URL` to the same HTTP port as the server?
8. If needed, turn on `Debug Logs` and inspect the page console.

## Current Scope

Implemented:

- local OpenAI-compatible HTTP API
- extension registration over WebSocket
- per-tab provider registration
- multiple supported sites
- streaming support through the local API
- browser-side page adapters and network capture

Non-goals:

- handling site login flows
- bypassing site-side restrictions
- generic web automation outside supported providers

