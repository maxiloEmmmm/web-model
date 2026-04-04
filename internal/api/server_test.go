package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"web-model/internal/chat"
	"web-model/internal/provider"
)

func TestChatCompletionsSuccess(t *testing.T) {
	registry := provider.NewRegistry()
	registry.MustRegister(staticProvider{name: "demo"})

	server := NewServer(registry, nil)

	body := map[string]any{
		"model": "demo",
		"messages": []map[string]string{
			{"role": "user", "content": "hello"},
		},
	}

	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewReader(raw))
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp chatCompletionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}

	if resp.Object != "chat.completion" {
		t.Fatalf("unexpected object %q", resp.Object)
	}
	if len(resp.Choices) != 1 {
		t.Fatalf("expected 1 choice, got %d", len(resp.Choices))
	}
	if resp.Choices[0].Message.Content != "provider reply" {
		t.Fatalf("unexpected content %q", resp.Choices[0].Message.Content)
	}
}

func TestModelsList(t *testing.T) {
	registry := provider.NewRegistry()
	registry.MustRegister(staticProvider{name: "demo", key: "demo-primary"})
	registry.MustRegister(staticProvider{name: "demo", key: "demo-secondary"})

	server := NewServer(registry, nil)

	req := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp modelsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}

	if resp.Object != "list" {
		t.Fatalf("unexpected object %q", resp.Object)
	}
	if len(resp.Data) != 2 {
		t.Fatalf("expected 2 models, got %d", len(resp.Data))
	}
	if resp.Data[0].ID != "demo-primary" {
		t.Fatalf("unexpected model id %q", resp.Data[0].ID)
	}
	if resp.Data[0].Metadata.Type != "demo" {
		t.Fatalf("unexpected provider type %q", resp.Data[0].Metadata.Type)
	}
	if resp.Data[0].Metadata.Description == "" {
		t.Fatal("expected provider metadata description")
	}
}

func TestProvidersList(t *testing.T) {
	registry := provider.NewRegistry()
	registry.MustRegister(staticProvider{name: "demo", key: "demo-primary"})

	server := NewServer(registry, nil)

	req := httptest.NewRequest(http.MethodGet, "/providers", nil)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp struct {
		Object string          `json:"object"`
		Data   []provider.Meta `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}

	if len(resp.Data) != 1 || resp.Data[0].Key != "demo-primary" {
		t.Fatalf("unexpected providers payload: %+v", resp.Data)
	}
	if resp.Data[0].Type != "demo" {
		t.Fatalf("unexpected provider type %q", resp.Data[0].Type)
	}
}

func TestChatCompletionsUnknownProvider(t *testing.T) {
	server := NewServer(provider.NewRegistry(), nil)

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewBufferString(`{"model":"missing","messages":[{"role":"user","content":"x"}]}`))
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

func TestChatCompletionsStreamsWithFallbackProvider(t *testing.T) {
	registry := provider.NewRegistry()
	registry.MustRegister(staticProvider{name: "demo"})

	server := NewServer(registry, nil)

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewBufferString(`{"model":"demo","stream":true,"messages":[{"role":"user","content":"x"}]}`))
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, `"object":"chat.completion.chunk"`) {
		t.Fatalf("expected chunk payload, got %s", body)
	}
	if !strings.Contains(body, `"content":"provider reply"`) {
		t.Fatalf("expected streamed content, got %s", body)
	}
	if !strings.Contains(body, "data: [DONE]") {
		t.Fatalf("expected done marker, got %s", body)
	}
}

func TestChatCompletionsStreamsWithStreamerProvider(t *testing.T) {
	registry := provider.NewRegistry()
	registry.MustRegister(streamingProvider{name: "demo"})

	server := NewServer(registry, nil)

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewBufferString(`{"model":"demo","stream":true,"messages":[{"role":"user","content":"x"}]}`))
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, `"content":"hello "`) {
		t.Fatalf("expected first delta chunk, got %s", body)
	}
	if !strings.Contains(body, `"content":"world"`) {
		t.Fatalf("expected second delta chunk, got %s", body)
	}
	if !strings.Contains(body, `"finish_reason":"stop"`) {
		t.Fatalf("expected stop chunk, got %s", body)
	}
}

func TestChatCompletionsReturns429WhenProviderBusy(t *testing.T) {
	registry := provider.NewRegistry()
	registry.MustRegister(busyProvider{name: "demo"})

	server := NewServer(registry, nil)

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewBufferString(`{"model":"demo","messages":[{"role":"user","content":"x"}]}`))
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "provider is busy") {
		t.Fatalf("unexpected body: %s", rec.Body.String())
	}
}

func TestChatCompletionsWildcardSelectsNonBusyProvider(t *testing.T) {
	registry := provider.NewRegistry()
	registry.MustRegister(busyProvider{name: "demo", key: "demo-busy"})
	registry.MustRegister(staticProvider{name: "demo", key: "demo-ready"})

	server := NewServer(registry, nil)

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewBufferString(`{"model":"*","messages":[{"role":"user","content":"x"}]}`))
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp chatCompletionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Model != "demo-ready" {
		t.Fatalf("expected model demo-ready, got %q", resp.Model)
	}
}

func TestChatCompletionsWildcardByTypeSelectsMatchingProvider(t *testing.T) {
	registry := provider.NewRegistry()
	registry.MustRegister(staticProvider{name: "qwen", key: "qwen-ready"})
	registry.MustRegister(staticProvider{name: "kimi", key: "kimi-ready"})

	server := NewServer(registry, nil)

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewBufferString(`{"model":"kimi*","messages":[{"role":"user","content":"x"}]}`))
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp chatCompletionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Model != "kimi-ready" {
		t.Fatalf("expected model kimi-ready, got %q", resp.Model)
	}
}

func TestChatCompletionsWildcardReturns429WhenAllCandidatesBusy(t *testing.T) {
	registry := provider.NewRegistry()
	registry.MustRegister(busyProvider{name: "qwen", key: "qwen-busy"})
	registry.MustRegister(busyProvider{name: "kimi", key: "kimi-busy"})

	server := NewServer(registry, nil)

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewBufferString(`{"model":"*","messages":[{"role":"user","content":"x"}]}`))
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestChatCompletionsWildcardPrefersNonPenalizedProvider(t *testing.T) {
	registry := provider.NewRegistry()
	registry.MustRegister(staticProvider{name: "kimi", key: "kimi-penalized", penaltyUntil: time.Now().Add(time.Minute)})
	registry.MustRegister(staticProvider{name: "kimi", key: "kimi-ready"})

	server := NewServer(registry, nil)

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewBufferString(`{"model":"kimi*","messages":[{"role":"user","content":"x"}]}`))
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp chatCompletionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Model != "kimi-ready" {
		t.Fatalf("expected model kimi-ready, got %q", resp.Model)
	}
}

func TestChatCompletionsWildcardFallsBackToPenalizedWhenNeeded(t *testing.T) {
	registry := provider.NewRegistry()
	registry.MustRegister(staticProvider{name: "kimi", key: "kimi-penalized", penaltyUntil: time.Now().Add(time.Minute)})

	server := NewServer(registry, nil)

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewBufferString(`{"model":"*","messages":[{"role":"user","content":"x"}]}`))
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp chatCompletionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Model != "kimi-penalized" {
		t.Fatalf("expected model kimi-penalized, got %q", resp.Model)
	}
}

type staticProvider struct {
	name         string
	key          string
	penaltyUntil time.Time
}

type busyProvider struct {
	name string
	key  string
}

type streamingProvider struct {
	name string
}

func (p staticProvider) Name() string {
	return p.name
}

func (p staticProvider) Meta() provider.Meta {
	key := p.key
	if key == "" {
		key = p.name
	}
	return provider.Meta{
		Key:         key,
		Type:        p.name,
		DisplayName: "Demo Provider",
		Description: "Static provider used in API tests.",
	}
}

func (p staticProvider) PenaltyUntil() time.Time {
	return p.penaltyUntil
}

func (p staticProvider) Chat(_ context.Context, _ chat.Request) (chat.Response, error) {
	return chat.Response{
		Message: chat.Message{
			Role:    "assistant",
			Content: "provider reply",
		},
		PromptTokens:     3,
		CompletionTokens: 2,
	}, nil
}

func (p busyProvider) Name() string {
	return p.name
}

func (p busyProvider) Meta() provider.Meta {
	key := p.key
	if key == "" {
		key = p.name
	}
	return provider.Meta{
		Key:         key,
		Type:        p.name,
		DisplayName: "Busy Provider",
		Description: "Always reports busy for API tests.",
	}
}

func (p busyProvider) Chat(_ context.Context, _ chat.Request) (chat.Response, error) {
	return chat.Response{}, provider.ErrBusy
}

func (p busyProvider) Busy() bool {
	return true
}

func (p streamingProvider) Name() string {
	return p.name
}

func (p streamingProvider) Meta() provider.Meta {
	return provider.Meta{
		Key:         p.name,
		Type:        p.name,
		DisplayName: "Streaming Provider",
		Description: "Streams two chunks for API tests.",
	}
}

func (p streamingProvider) Chat(_ context.Context, _ chat.Request) (chat.Response, error) {
	return chat.Response{
		Message: chat.Message{
			Role:    "assistant",
			Content: "hello world",
		},
		PromptTokens:     2,
		CompletionTokens: 3,
	}, nil
}

func (p streamingProvider) ChatStream(_ context.Context, _ chat.Request) (<-chan chat.StreamEvent, error) {
	events := make(chan chat.StreamEvent, 4)
	go func() {
		defer close(events)
		events <- chat.StreamEvent{Delta: "hello "}
		events <- chat.StreamEvent{Delta: "world"}
		time.Sleep(10 * time.Millisecond)
		response := chat.Response{
			Message: chat.Message{
				Role:    "assistant",
				Content: "hello world",
			},
			PromptTokens:     2,
			CompletionTokens: 3,
		}
		events <- chat.StreamEvent{Response: &response, Done: true}
	}()
	return events, nil
}
