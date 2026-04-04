package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"web-model/internal/agent"
	"web-model/internal/api"
	"web-model/internal/quickcli"
	"web-model/internal/tui"
)

func main() {
	log.SetOutput(io.Discard)

	if len(os.Args) > 1 && os.Args[1] == "quick" {
		if err := quickcli.Run(os.Args[2:], os.Stdout, os.Stderr); err != nil {
			fmt.Fprintf(os.Stderr, "%v\n", err)
			os.Exit(1)
		}
		return
	}

	addrDefault := envOrDefault("ADDR", "127.0.0.1:18080")
	maxChatsDefault := envOrDefaultInt("MAX_CHATS_PER_SESSION", 10)

	addr := flag.String("addr", addrDefault, "http listen address")
	maxChatsPerSession := flag.Int("max-chats-per-session", maxChatsDefault, "start a new chat before send after every N successful chats per provider key")
	cnHelp := flag.Bool("cn", false, "print Chinese help and exit")
	flag.Usage = func() {
		output := flag.CommandLine.Output()
		fmt.Fprintf(output, "web-model bridges supported web chat tabs to a local OpenAI-compatible server.\n\n")
		fmt.Fprintf(output, "Usage:\n")
		fmt.Fprintf(output, "  %s [flags]\n", os.Args[0])
		fmt.Fprintf(output, "  %s quick [--stream] <model> <question>\n\n", os.Args[0])
		fmt.Fprintf(output, "What It Does:\n")
		fmt.Fprintf(output, "  1. Starts a local HTTP API server.\n")
		fmt.Fprintf(output, "  2. Accepts extension websocket registrations on /ws.\n")
		fmt.Fprintf(output, "  3. Exposes registered browser tabs as models on /v1/models.\n")
		fmt.Fprintf(output, "  4. Forwards /v1/chat/completions requests into those live tabs.\n\n")
		fmt.Fprintf(output, "Quick Command:\n")
		fmt.Fprintf(output, "  quick calls the local OpenAI-compatible API directly.\n")
		fmt.Fprintf(output, "  It accepts exact models, '*' for any available tab, and 'xx*' for any tab of type xx.\n\n")
		fmt.Fprintf(output, "Typical Flow:\n")
		fmt.Fprintf(output, "  1. Run this server.\n")
		fmt.Fprintf(output, "  2. Load the extension from ./extension in Chrome or Edge.\n")
		fmt.Fprintf(output, "  3. Open a supported site tab.\n")
		fmt.Fprintf(output, "  4. Keep the web app's left sidebar expanded. Do not collapse it, or 'start new chat' may fail.\n")
		fmt.Fprintf(output, "  5. Enable the tab in the extension popup so it registers to ws://<addr>/ws.\n")
		fmt.Fprintf(output, "  6. Call the local API with the registered provider key as model.\n\n")
		fmt.Fprintf(output, "Important Notes:\n")
		fmt.Fprintf(output, "  - Keep the left sidebar visible on the provider web page.\n")
		fmt.Fprintf(output, "    If it is collapsed, extension-driven 'start new chat' actions may fail.\n\n")
		fmt.Fprintf(output, "  - Every provider web page must already be usable by hand before web-model can drive it.\n")
		fmt.Fprintf(output, "    Finish login, authentication, onboarding, and any required setup in the browser first.\n\n")
		fmt.Fprintf(output, "  - web-model only does the simple part: send the prompt and parse the answer.\n")
		fmt.Fprintf(output, "    Site-specific business rules such as auth, rate limits, captchas, popups, paywalls,\n")
		fmt.Fprintf(output, "    model availability, or other product restrictions are outside its scope.\n\n")
		fmt.Fprintf(output, "Supported Sites:\n")
		fmt.Fprintf(output, "  - ChatGPT: https://chatgpt.com/\n")
		fmt.Fprintf(output, "  - Qwen:    https://chat.qwen.ai/\n")
		fmt.Fprintf(output, "  - Gemini:  https://gemini.google.com/\n")
		fmt.Fprintf(output, "  - Kimi:    https://www.kimi.com/\n")
		fmt.Fprintf(output, "  - Yuanbao: https://yuanbao.tencent.com/\n\n")
		fmt.Fprintf(output, "HTTP Endpoints:\n")
		fmt.Fprintf(output, "  GET  /healthz              basic health + current provider keys\n")
		fmt.Fprintf(output, "  GET  /providers            raw provider list\n")
		fmt.Fprintf(output, "  GET  /v1/models            OpenAI-compatible model list\n")
		fmt.Fprintf(output, "  POST /v1/chat/completions  OpenAI-compatible chat completions\n")
		fmt.Fprintf(output, "  WS   /ws                   extension registration channel\n\n")
		fmt.Fprintf(output, "Examples:\n")
		fmt.Fprintf(output, "  Start server:\n")
		fmt.Fprintf(output, "    %s -addr 127.0.0.1:18080\n\n", os.Args[0])
		fmt.Fprintf(output, "  List registered models:\n")
		fmt.Fprintf(output, "    curl http://127.0.0.1:18080/v1/models\n\n")
		fmt.Fprintf(output, "  Chat once:\n")
		fmt.Fprintf(output, "    curl http://127.0.0.1:18080/v1/chat/completions \\\n")
		fmt.Fprintf(output, "      -H 'content-type: application/json' \\\n")
		fmt.Fprintf(output, "      -d '{\"model\":\"qwen-tab-123\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}'\n\n")
		fmt.Fprintf(output, "  Stream:\n")
		fmt.Fprintf(output, "    curl http://127.0.0.1:18080/v1/chat/completions \\\n")
		fmt.Fprintf(output, "      -H 'content-type: application/json' \\\n")
		fmt.Fprintf(output, "      -d '{\"model\":\"kimi-tab-123\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}'\n\n")
		fmt.Fprintf(output, "  Quick chat:\n")
		fmt.Fprintf(output, "    %s quick 'kimi*' \"hi\"\n\n", os.Args[0])
		fmt.Fprintf(output, "  Quick stream:\n")
		fmt.Fprintf(output, "    %s quick --stream '*' \"hi\"\n\n", os.Args[0])
		fmt.Fprintf(output, "Environment Variables:\n")
		fmt.Fprintf(output, "  ADDR                   default listen address, default: %s\n", addrDefault)
		fmt.Fprintf(output, "  MAX_CHATS_PER_SESSION  rotate to a new chat after N successful chats, default: %d\n\n", maxChatsDefault)
		fmt.Fprintf(output, "Flags:\n")
		flag.PrintDefaults()
	}
	flag.Parse()
	if *cnHelp {
		printChineseUsage(os.Stdout, os.Args[0], addrDefault, maxChatsDefault)
		return
	}

	manager := agent.NewManager(agent.Config{
		MaxChatsPerSession: *maxChatsPerSession,
	})
	server := &http.Server{
		Addr:    *addr,
		Handler: api.NewServer(manager, manager),
	}

	serverErrCh := make(chan error, 1)
	go func() {
		log.Printf("http listening on http://%s", *addr)
		log.Printf("websocket endpoint on ws://%s/ws", *addr)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			serverErrCh <- err
		}
	}()

	model := tui.NewAgentTeaModel(manager, "http://"+*addr, "ws://"+*addr+"/ws", *maxChatsPerSession)
	program := tea.NewProgram(model, tea.WithAltScreen())

	signalCh := make(chan os.Signal, 1)
	signal.Notify(signalCh, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(signalCh)

	go func() {
		select {
		case sig := <-signalCh:
			log.Printf("received signal: %s", sig)
			program.Quit()
		case err := <-serverErrCh:
			log.Printf("http server error: %v", err)
			program.Quit()
		}
	}()

	if _, err := program.Run(); err != nil {
		log.Printf("tui error: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		log.Printf("http shutdown error: %v", err)
	}
	if err := manager.Close(); err != nil {
		log.Printf("agent manager close error: %v", err)
	}
}

func envOrDefault(key, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}

func envOrDefaultInt(key string, fallback int) int {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

func printChineseUsage(output io.Writer, binaryName, addrDefault string, maxChatsDefault int) {
	fmt.Fprintf(output, "web-model 用来把已打开的网页聊天页面桥接成本地 OpenAI 兼容接口。\n\n")
	fmt.Fprintf(output, "用法:\n")
	fmt.Fprintf(output, "  %s [flags]\n", binaryName)
	fmt.Fprintf(output, "  %s quick [--stream] <model> <question>\n\n", binaryName)
	fmt.Fprintf(output, "它会做什么:\n")
	fmt.Fprintf(output, "  1. 启动本地 HTTP API 服务。\n")
	fmt.Fprintf(output, "  2. 在 /ws 接收浏览器扩展注册。\n")
	fmt.Fprintf(output, "  3. 把已注册的浏览器标签页暴露成 /v1/models 里的 model。\n")
	fmt.Fprintf(output, "  4. 把 /v1/chat/completions 请求转发到真实网页标签页执行。\n\n")
	fmt.Fprintf(output, "quick 子命令:\n")
	fmt.Fprintf(output, "  quick 会直接调用本地 OpenAI 兼容接口。\n")
	fmt.Fprintf(output, "  支持精确 model、'*' 表示任意可用 tab、'xx*' 表示任意类型为 xx 的 tab。\n\n")
	fmt.Fprintf(output, "典型流程:\n")
	fmt.Fprintf(output, "  1. 运行这个 server。\n")
	fmt.Fprintf(output, "  2. 在 Chrome 或 Edge 里加载 ./extension。\n")
	fmt.Fprintf(output, "  3. 打开一个支持的网站标签页。\n")
	fmt.Fprintf(output, "  4. 保持网页左侧 sidebar 展开，不要收起，否则“新建聊天”可能失败。\n")
	fmt.Fprintf(output, "  5. 在扩展 popup 里启用当前 tab，让它注册到 ws://<addr>/ws。\n")
	fmt.Fprintf(output, "  6. 用注册后的 provider key 当作 model 调本地 API。\n\n")
	fmt.Fprintf(output, "重要说明:\n")
	fmt.Fprintf(output, "  - 所有网页端都必须先能手工正常使用。\n")
	fmt.Fprintf(output, "    登录、认证、初始化引导、必要设置都要先在浏览器里完成。\n\n")
	fmt.Fprintf(output, "  - web-model 只做最简单的事：传递问题、解析答案。\n")
	fmt.Fprintf(output, "    站点自己的业务限制，比如认证、限流、验证码、弹窗、付费墙、模型可用性，\n")
	fmt.Fprintf(output, "    都不在它的处理范围里。\n\n")
	fmt.Fprintf(output, "支持站点:\n")
	fmt.Fprintf(output, "  - ChatGPT: https://chatgpt.com/\n")
	fmt.Fprintf(output, "  - Qwen:    https://chat.qwen.ai/\n")
	fmt.Fprintf(output, "  - Gemini:  https://gemini.google.com/\n")
	fmt.Fprintf(output, "  - Kimi:    https://www.kimi.com/\n")
	fmt.Fprintf(output, "  - Yuanbao: https://yuanbao.tencent.com/\n\n")
	fmt.Fprintf(output, "HTTP 接口:\n")
	fmt.Fprintf(output, "  GET  /healthz              基础健康检查 + 当前 provider keys\n")
	fmt.Fprintf(output, "  GET  /providers            原始 provider 列表\n")
	fmt.Fprintf(output, "  GET  /v1/models            OpenAI 兼容 model 列表\n")
	fmt.Fprintf(output, "  POST /v1/chat/completions  OpenAI 兼容聊天接口\n")
	fmt.Fprintf(output, "  WS   /ws                   扩展注册通道\n\n")
	fmt.Fprintf(output, "示例:\n")
	fmt.Fprintf(output, "  启动服务:\n")
	fmt.Fprintf(output, "    %s -addr 127.0.0.1:18080\n\n", binaryName)
	fmt.Fprintf(output, "  查看已注册模型:\n")
	fmt.Fprintf(output, "    curl http://127.0.0.1:18080/v1/models\n\n")
	fmt.Fprintf(output, "  普通聊天:\n")
	fmt.Fprintf(output, "    curl http://127.0.0.1:18080/v1/chat/completions \\\n")
	fmt.Fprintf(output, "      -H 'content-type: application/json' \\\n")
	fmt.Fprintf(output, "      -d '{\"model\":\"qwen-tab-123\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}'\n\n")
	fmt.Fprintf(output, "  流式聊天:\n")
	fmt.Fprintf(output, "    curl http://127.0.0.1:18080/v1/chat/completions \\\n")
	fmt.Fprintf(output, "      -H 'content-type: application/json' \\\n")
	fmt.Fprintf(output, "      -d '{\"model\":\"kimi-tab-123\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}'\n\n")
	fmt.Fprintf(output, "  quick 普通聊天:\n")
	fmt.Fprintf(output, "    %s quick 'kimi*' \"hi\"\n\n", binaryName)
	fmt.Fprintf(output, "  quick 流式聊天:\n")
	fmt.Fprintf(output, "    %s quick --stream '*' \"hi\"\n\n", binaryName)
	fmt.Fprintf(output, "环境变量:\n")
	fmt.Fprintf(output, "  ADDR                   默认监听地址，默认: %s\n", addrDefault)
	fmt.Fprintf(output, "  MAX_CHATS_PER_SESSION  每个 provider key 成功聊天 N 次后触发新建聊天，默认: %d\n\n", maxChatsDefault)
	fmt.Fprintf(output, "Flags:\n")
	fmt.Fprintf(output, "  -addr string\n")
	fmt.Fprintf(output, "        http 监听地址\n")
	fmt.Fprintf(output, "  -max-chats-per-session int\n")
	fmt.Fprintf(output, "        每个 provider key 成功聊天 N 次后，发送前先新建聊天\n")
	fmt.Fprintf(output, "  -cn\n")
	fmt.Fprintf(output, "        输出中文帮助并退出\n")
}
