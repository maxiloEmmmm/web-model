package qwen

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"

	"web-model/internal/browser"
	"web-model/internal/chat"
)

func TestNewBuildsProviderMeta(t *testing.T) {
	manager := browser.NewManager(&fakeLauncher{})

	p, err := New(Config{
		Key:        "qwen-main",
		Account:    "main@example.com",
		Role:       "writer",
		ProfileDir: "/tmp/qwen-main",
	}, manager)
	if err != nil {
		t.Fatalf("new provider: %v", err)
	}

	meta := p.Meta()
	if meta.Key != "qwen-main" {
		t.Fatalf("unexpected key %q", meta.Key)
	}
	if meta.Type != Type {
		t.Fatalf("unexpected type %q", meta.Type)
	}
	if meta.Account != "main@example.com" || meta.Role != "writer" {
		t.Fatalf("unexpected meta: %+v", meta)
	}
}

func TestChatAcquiresSession(t *testing.T) {
	launcher := &fakeLauncher{}
	manager := browser.NewManager(launcher)

	p, err := New(Config{Key: "qwen-main"}, manager)
	if err != nil {
		t.Fatalf("new provider: %v", err)
	}

	_, err = p.Chat(context.Background(), chat.Request{})
	if err == nil {
		t.Fatal("expected not implemented error")
	}
	if !strings.Contains(err.Error(), "not implemented") {
		t.Fatalf("unexpected error: %v", err)
	}
	if launcher.launches.Load() != 1 {
		t.Fatalf("expected 1 launcher call, got %d", launcher.launches.Load())
	}
}

type fakeLauncher struct {
	launches atomic.Int32
}

func (l *fakeLauncher) Launch(context.Context, browser.SessionSpec) (browser.Handle, error) {
	l.launches.Add(1)
	return &fakeHandle{}, nil
}

type fakeHandle struct{}

func (h *fakeHandle) EnsureReady(context.Context) error {
	return nil
}

func (h *fakeHandle) Close(context.Context) error {
	return nil
}

func (h *fakeHandle) Context() context.Context {
	return context.Background()
}
