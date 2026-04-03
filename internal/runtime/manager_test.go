package runtime

import (
	"context"
	"testing"

	"web-model/internal/browser"
)

func TestManagerAddQwenStartsAsNew(t *testing.T) {
	manager := NewManager(browser.Config{})
	t.Cleanup(func() {
		_ = manager.Close(context.Background())
	})

	if err := manager.AddQwen(AddQwenInput{
		Key:         "qwen-main",
		DisplayName: "Qwen Main",
		Account:     "main@example.com",
		Role:        "default",
	}); err != nil {
		t.Fatalf("add qwen: %v", err)
	}

	items := manager.Snapshots()
	if len(items) != 1 {
		t.Fatalf("expected 1 provider, got %d", len(items))
	}
	if items[0].Status != StatusNew {
		t.Fatalf("unexpected status %q", items[0].Status)
	}
	if items[0].ProfileDir == "" {
		t.Fatal("expected temp profile dir")
	}
}

func TestManagerOnlyExposesReadyProvidersToAPI(t *testing.T) {
	manager := NewManager(browser.Config{})
	t.Cleanup(func() {
		_ = manager.Close(context.Background())
	})

	if err := manager.AddQwen(AddQwenInput{Key: "qwen-main"}); err != nil {
		t.Fatalf("add qwen: %v", err)
	}

	if len(manager.List()) != 0 {
		t.Fatal("expected no ready providers before manual completion")
	}

	manager.setStatus("qwen-main", StatusReady, "")

	if len(manager.List()) != 1 {
		t.Fatal("expected ready provider to appear in API list")
	}
}

func TestCompleteAddMarksProviderReady(t *testing.T) {
	manager := NewManager(browser.Config{})
	t.Cleanup(func() {
		_ = manager.Close(context.Background())
	})

	if err := manager.AddQwen(AddQwenInput{Key: "qwen-main"}); err != nil {
		t.Fatalf("add qwen: %v", err)
	}

	manager.setStatus("qwen-main", StatusSettingUp, "")
	if err := manager.CompleteAdd("qwen-main"); err != nil {
		t.Fatalf("complete add: %v", err)
	}

	items := manager.List()
	if len(items) != 1 || items[0].Key != "qwen-main" {
		t.Fatalf("unexpected ready list: %+v", items)
	}
}
