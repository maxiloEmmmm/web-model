package agent

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"web-model/internal/chat"
)

func TestManagerRegistersWebsocketAgent(t *testing.T) {
	manager := NewManager(Config{})
	server := httptest.NewServer(manager)
	t.Cleanup(func() {
		server.Close()
		_ = manager.Close()
	})

	conn := dialTestSocket(t, server.URL)
	defer conn.Close()

	if err := conn.WriteJSON(map[string]any{
		"type":          "hello",
		"key":           "qwen-main",
		"provider_type": "qwen",
		"display_name":  "Qwen Main",
	}); err != nil {
		t.Fatal(err)
	}

	var ack map[string]any
	if err := conn.ReadJSON(&ack); err != nil {
		t.Fatal(err)
	}

	if ack["type"] != "hello.ack" {
		t.Fatalf("unexpected ack: %+v", ack)
	}

	items := manager.List()
	if len(items) != 1 || items[0].Key != "qwen-main" {
		t.Fatalf("unexpected providers: %+v", items)
	}
	if items[0].Type != "qwen" {
		t.Fatalf("unexpected provider type: %+v", items[0])
	}
}

func TestManagerRoutesChatOverWebsocket(t *testing.T) {
	manager := NewManager(Config{})
	server := httptest.NewServer(manager)
	t.Cleanup(func() {
		server.Close()
		_ = manager.Close()
	})

	conn := dialTestSocket(t, server.URL)
	defer conn.Close()

	if err := conn.WriteJSON(map[string]any{
		"type":          "hello",
		"key":           "qwen-main",
		"provider_type": "qwen",
	}); err != nil {
		t.Fatal(err)
	}

	var ack map[string]any
	if err := conn.ReadJSON(&ack); err != nil {
		t.Fatal(err)
	}

	prov, ok := manager.Get("qwen-main")
	if !ok {
		t.Fatal("expected provider to be registered")
	}

	done := make(chan struct{})
	go func() {
		defer close(done)

		var request map[string]any
		if err := conn.ReadJSON(&request); err != nil {
			t.Errorf("read chat.request: %v", err)
			return
		}

		if request["type"] != "chat.request" {
			t.Errorf("unexpected request payload: %+v", request)
			return
		}

		if err := conn.WriteJSON(map[string]any{
			"type":       "chat.done",
			"request_id": request["request_id"],
			"message": map[string]any{
				"role":    "assistant",
				"content": "hello from extension",
			},
			"prompt_tokens":     2,
			"completion_tokens": 5,
		}); err != nil {
			t.Errorf("write chat.done: %v", err)
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	resp, err := prov.Chat(ctx, chat.Request{
		Model: "qwen-main",
		Messages: []chat.Message{
			{Role: "user", Content: "hello"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if resp.Message.Content != "hello from extension" {
		t.Fatalf("unexpected content %q", resp.Message.Content)
	}
	if resp.PromptTokens != 2 || resp.CompletionTokens != 5 {
		t.Fatalf("unexpected token usage: %+v", resp)
	}

	<-done
}

func TestManagerRepliesToPingWithPong(t *testing.T) {
	manager := NewManager(Config{})
	server := httptest.NewServer(manager)
	t.Cleanup(func() {
		server.Close()
		_ = manager.Close()
	})

	conn := dialTestSocket(t, server.URL)
	defer conn.Close()

	if err := conn.WriteJSON(map[string]any{
		"type":          "hello",
		"key":           "kimi-main",
		"provider_type": "kimi",
	}); err != nil {
		t.Fatal(err)
	}

	var ack map[string]any
	if err := conn.ReadJSON(&ack); err != nil {
		t.Fatal(err)
	}
	if ack["type"] != "hello.ack" {
		t.Fatalf("unexpected ack: %+v", ack)
	}

	if err := conn.WriteJSON(map[string]any{
		"type": "ping",
		"at":   float64(123456789),
	}); err != nil {
		t.Fatal(err)
	}

	var pong map[string]any
	if err := conn.ReadJSON(&pong); err != nil {
		t.Fatal(err)
	}
	if pong["type"] != "pong" {
		t.Fatalf("unexpected pong: %+v", pong)
	}
	if got := int64(pong["at"].(float64)); got != 123456789 {
		t.Fatalf("unexpected pong at: %d", got)
	}
}

func TestManagerReplacesExistingConnectionForSameKey(t *testing.T) {
	manager := NewManager(Config{})
	server := httptest.NewServer(manager)
	t.Cleanup(func() {
		server.Close()
		_ = manager.Close()
	})

	first := dialTestSocket(t, server.URL)
	defer first.Close()

	if err := first.WriteJSON(map[string]any{
		"type":          "hello",
		"key":           "qwen-main",
		"provider_type": "qwen",
	}); err != nil {
		t.Fatal(err)
	}

	var ack map[string]any
	if err := first.ReadJSON(&ack); err != nil {
		t.Fatal(err)
	}

	second := dialTestSocket(t, server.URL)
	defer second.Close()

	if err := second.WriteJSON(map[string]any{
		"type":          "hello",
		"key":           "qwen-main",
		"provider_type": "qwen",
	}); err != nil {
		t.Fatal(err)
	}

	if err := second.ReadJSON(&ack); err != nil {
		t.Fatal(err)
	}

	prov, ok := manager.Get("qwen-main")
	if !ok {
		t.Fatal("expected provider to be registered")
	}

	done := make(chan struct{})
	go func() {
		defer close(done)

		var request map[string]any
		if err := second.ReadJSON(&request); err != nil {
			t.Errorf("read chat.request from second conn: %v", err)
			return
		}

		if err := second.WriteJSON(map[string]any{
			"type":       "chat.done",
			"request_id": request["request_id"],
			"message": map[string]any{
				"role":    "assistant",
				"content": "new connection reply",
			},
		}); err != nil {
			t.Errorf("write chat.done from second conn: %v", err)
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	resp, err := prov.Chat(ctx, chat.Request{
		Model: "qwen-main",
		Messages: []chat.Message{
			{Role: "user", Content: "hello"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if resp.Message.Content != "new connection reply" {
		t.Fatalf("unexpected content %q", resp.Message.Content)
	}

	<-done
}

func dialTestSocket(t *testing.T, serverURL string) *websocket.Conn {
	t.Helper()

	wsURL := "ws" + strings.TrimPrefix(serverURL, "http")
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	return conn
}
