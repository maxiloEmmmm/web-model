# AGENTS

## Extension Notes

- 在 `extension/content.js` 给页面主世界同步状态时，不要注入内联脚本，不要用 `script.textContent = ...` 这类方式。
- 原因：Qwen / ChatGPT 这类页面可能有严格的 CSP，内联脚本会被直接拦截，导致功能异常并在控制台报 `Executing inline script violates Content Security Policy`。
- 允许的方式：
  - 通过扩展资源文件注入外部脚本。
  - 通过 `window.postMessage` 在 content script 和 page world 之间同步状态。
  - 通过 `data-*` 属性给已注入的外部脚本传递初始配置。
- 如果是 debug 开关、运行时标志、桥接配置这类同步需求，默认优先选 `postMessage`，不要再走内联脚本。
