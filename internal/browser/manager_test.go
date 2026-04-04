package browser

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestManagerReusesSessionByKey(t *testing.T) {
	launcher := &fakeLauncher{}
	manager := NewManager(launcher)

	spec := SessionSpec{
		Key:        "qwen-main",
		Type:       "qwen",
		StartURL:   "https://chat.qwen.ai/",
		ProfileDir: "/tmp/qwen-main",
	}

	first, err := manager.Get(context.Background(), spec)
	if err != nil {
		t.Fatalf("get first session: %v", err)
	}
	second, err := manager.Get(context.Background(), spec)
	if err != nil {
		t.Fatalf("get second session: %v", err)
	}

	if first != second {
		t.Fatal("expected same session pointer for same key")
	}

	if err := first.Do(context.Background(), func(context.Context, Handle) error { return nil }); err != nil {
		t.Fatalf("session do: %v", err)
	}
	if launcher.launches.Load() != 1 {
		t.Fatalf("expected 1 launch, got %d", launcher.launches.Load())
	}
}

func TestManagerRejectsConflictingSessionSpec(t *testing.T) {
	launcher := &fakeLauncher{}
	manager := NewManager(launcher)

	_, err := manager.Get(context.Background(), SessionSpec{
		Key:      "qwen-main",
		Type:     "qwen",
		StartURL: "https://chat.qwen.ai/",
	})
	if err != nil {
		t.Fatalf("get session: %v", err)
	}

	_, err = manager.Get(context.Background(), SessionSpec{
		Key:      "qwen-main",
		Type:     "qwen",
		StartURL: "https://different.example/",
	})
	if err == nil {
		t.Fatal("expected conflicting session spec error")
	}
}

func TestSessionDoIsSerialized(t *testing.T) {
	launcher := &fakeLauncher{}
	manager := NewManager(launcher)

	session, err := manager.Get(context.Background(), SessionSpec{
		Key:  "qwen-main",
		Type: "qwen",
	})
	if err != nil {
		t.Fatalf("get session: %v", err)
	}

	firstEntered := make(chan struct{})
	releaseFirst := make(chan struct{})
	secondFinished := make(chan struct{})

	var orderMu sync.Mutex
	var order []string

	go func() {
		_ = session.Do(context.Background(), func(context.Context, Handle) error {
			orderMu.Lock()
			order = append(order, "first-enter")
			orderMu.Unlock()
			close(firstEntered)
			<-releaseFirst
			orderMu.Lock()
			order = append(order, "first-exit")
			orderMu.Unlock()
			return nil
		})
	}()

	<-firstEntered

	go func() {
		_ = session.Do(context.Background(), func(context.Context, Handle) error {
			orderMu.Lock()
			order = append(order, "second-enter")
			orderMu.Unlock()
			close(secondFinished)
			return nil
		})
	}()

	select {
	case <-secondFinished:
		t.Fatal("second call entered before first call finished")
	case <-time.After(50 * time.Millisecond):
	}

	close(releaseFirst)

	select {
	case <-secondFinished:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for second call")
	}

	orderMu.Lock()
	defer orderMu.Unlock()
	if len(order) != 3 || order[0] != "first-enter" || order[1] != "first-exit" || order[2] != "second-enter" {
		t.Fatalf("unexpected execution order: %#v", order)
	}
}

type fakeLauncher struct {
	launches atomic.Int32
}

func (l *fakeLauncher) Launch(_ context.Context, _ SessionSpec) (Handle, error) {
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
