package provider

import (
	"context"
	"testing"

	"web-model/internal/chat"
)

func TestRegistryAllowsMultipleInstancesPerType(t *testing.T) {
	registry := NewRegistry()

	if err := registry.Register(testProvider{providerType: "qwen", key: "qwen-main"}); err != nil {
		t.Fatalf("register first provider: %v", err)
	}
	if err := registry.Register(testProvider{providerType: "qwen", key: "qwen-editor"}); err != nil {
		t.Fatalf("register second provider: %v", err)
	}

	items := registry.List()
	if len(items) != 2 {
		t.Fatalf("expected 2 providers, got %d", len(items))
	}
	if items[0].Key != "qwen-editor" || items[1].Key != "qwen-main" {
		t.Fatalf("unexpected provider keys: %+v", items)
	}
	if items[0].Type != "qwen" || items[1].Type != "qwen" {
		t.Fatalf("unexpected provider types: %+v", items)
	}
}

func TestRegistryRejectsDuplicateKey(t *testing.T) {
	registry := NewRegistry()

	if err := registry.Register(testProvider{providerType: "qwen", key: "shared"}); err != nil {
		t.Fatalf("register first provider: %v", err)
	}
	if err := registry.Register(testProvider{providerType: "chatgpt", key: "shared"}); err == nil {
		t.Fatal("expected duplicate key error")
	}
}

type testProvider struct {
	providerType string
	key          string
}

func (p testProvider) Name() string {
	return p.providerType
}

func (p testProvider) Meta() Meta {
	return Meta{
		Key:  p.key,
		Type: p.providerType,
	}
}

func (p testProvider) Chat(context.Context, chat.Request) (chat.Response, error) {
	return chat.Response{}, nil
}
