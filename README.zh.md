# web-model

把真实浏览器里的 AI 聊天页面，桥接成本地 OpenAI 兼容 API。

English version: [README.md](./README.md).

`web-model` 保留真实网站、真实登录态和真实页面行为。  
本地服务通过 `/v1/models` 暴露已注册 tab，再通过 `/v1/chat/completions` 转发请求。

## 特性

- OpenAI 兼容接口：`GET /v1/models`、`POST /v1/chat/completions`
- 基于真实浏览器 tab，不是私有逆向接口
- Chrome / Edge MV3 扩展
- 支持流式输出
- 支持通配路由：
  - `model: "*"` 从任意非 busy tab 里随机选一个
  - `model: "kimi*"` 从任意非 busy 的 Kimi tab 里随机选一个
- 支持错误惩罚：
  - 某个 tab 聊天报错后，会进入 1 分钟惩罚期
  - 通配路由在有更干净候选时会优先避开它
- 自带 TUI，可看 busy / 已用次数 / 惩罚倒计时

## 支持的网站

- ChatGPT
- Qwen
- Gemini
- Kimi
- Yuanbao

## 架构

```text
你的脚本 / 应用
        |
        v
  web-model server
        |
        v
    浏览器扩展
        |
        v
   真实浏览器 tab
        |
        v
     真实网页产品
```

## 快速开始

### 1. 下载并解压平台包

```bash
tar -xzf macos-amd64-all.tgz
cd macos-amd64
```

可用平台包：

- `linux-amd64-all.tgz`
- `macos-amd64-all.tgz`
- `windows-amd64-all.tgz`

### 2. 启动服务

```bash
./web-model
```

Windows:

```powershell
.\web-model.exe
```

默认地址：

- HTTP: `http://127.0.0.1:18080`
- WebSocket: `ws://127.0.0.1:18080/ws`

帮助：

```bash
./web-model -h
./web-model -cn
```

### 3. 加载扩展

把包里的 `extension/` 目录作为 unpacked extension 加到 Chrome 或 Edge。

### 4. 先把目标页面准备好

目标页面必须已经可以手工正常使用。

包括：

- 登录
- 鉴权
- onboarding
- 同意弹窗
- 模型可用性
- 站点要求的页面状态

`web-model` 只负责传问题和取答案，不负责验证码、会员限制、配额、业务规则之类的网页限制。

另外，左侧 sidebar 不要收起。  
如果左侧栏折叠，`start new chat` 可能失败。

### 5. 启用当前 tab

在扩展 popup 里：

- `Server URL` = `ws://127.0.0.1:18080/ws`
- 勾选当前 tab
- `Debug Logs` 只在排查时打开

badge 含义：

- 绿色 `ON`：已注册
- 黄色 `...`：连接中 / 等待中
- 红色 `!`：错误
- 空白：未启用 / 未激活

### 6. 调 API

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

## model 路由

`model` 支持三种形式：

- 精确 key
  - 例如：`kimi-tab-2123080689`
- `*`
  - 从所有非 busy 的已注册 tab 里随机选一个
- `xx*`
  - 从类型为 `xx` 的非 busy tab 里随机选一个
  - 例如：`kimi*`、`qwen*`、`chatgpt*`

惩罚规则：

- 某个 tab 聊天报错后，会进入 1 分钟惩罚期
- 通配路由优先避开惩罚中的 tab
- 如果只剩惩罚中的候选，仍然可以继续选它们

TUI 里的 `Penalty` 列会显示这个倒计时。

## 二进制包

release 会产出 3 个平台包：

- `linux-amd64-all.tgz`
- `macos-amd64-all.tgz`
- `windows-amd64-all.tgz`

每个包里都有：

- `web-model` 或 `web-model.exe`
- `extension/`

`web-model` 自带 `quick` 子命令，可以直接调用本地 API。

示例：

```bash
./web-model quick kimi "hi"
./web-model quick --stream kimi "hi"
./web-model quick --stream '*' "hi"
./web-model quick --stream 'qwen*' "hi"
```

Windows:

```powershell
.\web-model.exe quick kimi "hi"
.\web-model.exe quick --stream '*' "hi"
```

注意：

- `*` 和 `xx*` 要加引号，不然 shell 可能会把它展开成文件名。
- 通配请求最终命中的具体 model key，会由 server 在响应里返回。

## API

- `GET /healthz`
- `GET /providers`
- `GET /v1/models`
- `POST /v1/chat/completions`

流式输出通过 `/v1/chat/completions` 的 OpenAI 风格 SSE 返回。

`POST /v1/chat/completions` 当前支持的请求字段：

- `model`
- `messages`
- `stream`
- `temperature`
- `top_p`
- `max_tokens`
- `stop`
- `user`

当前支持的 message 字段：

- `role`
- `content`
- `name`

当前支持的响应字段：

- `id`
- `object`
- `created`
- `model`
- `choices`
- `usage`

这里支持的是一组实用的 OpenAI 兼容子集，不是完整 OpenAI API 全量字段。

## 备注

- 注册粒度是“浏览器 tab”
- 页面刷新后需要扩展桥重新连上
- 扩展会给已注册 tab 维护心跳，尽量避免浏览器闲置后静默掉线
- 流式质量取决于目标网站本身，最终非流式结果通常更干净

## License

MIT
