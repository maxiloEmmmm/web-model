# web-model

Turn real browser AI chat tabs into a local OpenAI-compatible API.

中文说明见 [README.zh.md](./README.zh.md).

`web-model` keeps the real website, the real logged-in browser session, and the real page behavior.  
The local server exposes registered tabs through `/v1/models` and `/v1/chat/completions`.

## Highlights

- OpenAI-compatible `GET /v1/models` and `POST /v1/chat/completions`
- Real browser tabs, not private reverse-engineered APIs
- Chrome / Edge MV3 extension
- Streaming support
- Wildcard routing:
  - `model: "*"` picks any non-busy tab
  - `model: "kimi*"` picks any non-busy Kimi tab
- Error penalty:
  - a tab that returns a chat error gets a 1 minute penalty window
  - wildcard routing avoids penalized tabs when cleaner candidates exist
- Built-in TUI monitor with busy / usage / penalty countdown

## Supported Sites

- ChatGPT
- Qwen
- Gemini
- Kimi
- Yuanbao

## Architecture

```text
your app / script
        |
        v
  web-model server
        |
        v
browser extension
        |
        v
 real browser tab
        |
        v
 provider website
```

## Quick Start

### 1. Start the server

```bash
go run ./cmd/web-model
```

Default addresses:

- HTTP: `http://127.0.0.1:18080`
- WebSocket: `ws://127.0.0.1:18080/ws`

Help:

```bash
go run ./cmd/web-model -h
go run ./cmd/web-model -cn
```

### 2. Load the extension

Load [`extension/`](./extension) as an unpacked extension in Chrome or Edge.

### 3. Prepare the provider page

The target page must already work by hand.

That includes:

- login
- auth
- onboarding
- consent dialogs
- model availability
- any site-specific page state

`web-model` only sends the prompt and parses the answer. It does not solve captcha, paywalls, product-side limits, or business rules.

Keep the page sidebar visible. If the left sidebar is collapsed, `start new chat` may fail.

### 4. Enable the tab

In the extension popup:

- `Server URL` = `ws://127.0.0.1:18080/ws`
- enable the current tab
- turn on debug logs only when needed

Badge meaning:

- Green `ON`: registered
- Yellow `...`: connecting / waiting
- Red `!`: error
- Blank: disabled / inactive

### 5. Call the API

```bash
curl http://127.0.0.1:18080/v1/models
```

```bash
curl http://127.0.0.1:18080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "kimi-tab-2123080689",
    "messages": [
      { "role": "user", "content": "hi" }
    ]
  }'
```

## Model Routing

`model` supports three forms:

- Exact key
  - Example: `kimi-tab-2123080689`
- `*`
  - Randomly picks one non-busy registered tab
- `xx*`
  - Randomly picks one non-busy registered tab whose type is `xx`
  - Example: `kimi*`, `qwen*`, `chatgpt*`

Penalty behavior:

- if a tab returns a chat error, it gets a 1 minute penalty window
- wildcard routing avoids penalized tabs when other healthy candidates exist
- if only penalized candidates remain, they can still be used

The TUI shows this as the `Penalty` column.

## Binaries

Nightly release artifacts include three platform packages:

- `linux-amd64-all.tgz`
- `macos-amd64-all.tgz`
- `windows-amd64-all.tgz`

Each package contains:

- `web-model` or `web-model.exe`
- `chat_by_type` or `chat_by_type.exe`
- `extension/`

`chat_by_type` is a tiny helper that calls the local API.

Examples:

```bash
./chat_by_type kimi "hi"
./chat_by_type --stream kimi "hi"
./chat_by_type --stream '*' "hi"
./chat_by_type --stream 'qwen*' "hi"
```

Important:

- Quote `*` and `xx*` in your shell, or the shell may expand them into filenames.
- For wildcard requests, the server returns the actual concrete model key in the response.

## API

- `GET /healthz`
- `GET /providers`
- `GET /v1/models`
- `POST /v1/chat/completions`

Streaming works with the standard OpenAI-style SSE response from `/v1/chat/completions`.

## Notes

- Registration is per browser tab.
- Refreshing a page requires the extension bridge to reconnect.
- The extension maintains a heartbeat for registered tabs so idle browser pages are less likely to silently disappear.
- Streaming quality depends on the provider site. Final non-streamed responses are usually cleaner.

## License

MIT
