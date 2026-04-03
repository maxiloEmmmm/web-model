package runtime

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"

	"web-model/internal/browser"
	"web-model/internal/provider"
	"web-model/internal/provider/qwen"
)

type Status string

const (
	StatusNew       Status = "new"
	StatusSettingUp Status = "setting_up"
	StatusReady     Status = "ready"
	StatusBusy      Status = "busy"
	StatusError     Status = "error"
)

type Snapshot struct {
	Key         string
	Type        string
	DisplayName string
	Account     string
	Role        string
	Status      Status
	Error       string
	ProfileDir  string
}

type AddQwenInput struct {
	Key         string
	DisplayName string
	Account     string
	Role        string
}

type Manager struct {
	sessions *browser.Manager

	mu        sync.RWMutex
	instances map[string]*instance
}

type instance struct {
	provider provider.Provider
	meta     provider.Meta

	status  Status
	lastErr string

	profileDir string
}

func NewManager(browserCfg browser.Config) *Manager {
	launcher := browser.NewChromiumLauncher(browserCfg)
	return &Manager{
		sessions:  browser.NewManager(launcher),
		instances: make(map[string]*instance),
	}
}

func (m *Manager) Close(ctx context.Context) error {
	m.mu.Lock()
	items := make([]*instance, 0, len(m.instances))
	for _, item := range m.instances {
		items = append(items, item)
	}
	m.instances = make(map[string]*instance)
	m.mu.Unlock()

	for _, item := range items {
		if cleaner, ok := item.provider.(provider.Cleaner); ok {
			_ = cleaner.Cleanup(ctx)
		}
		if item.profileDir != "" {
			_ = os.RemoveAll(item.profileDir)
		}
	}

	return m.sessions.Close(ctx)
}

func (m *Manager) AddQwen(input AddQwenInput) error {
	if input.Key == "" {
		return fmt.Errorf("provider key is required")
	}

	m.mu.Lock()
	if _, exists := m.instances[input.Key]; exists {
		m.mu.Unlock()
		return fmt.Errorf("provider %q already exists", input.Key)
	}
	m.mu.Unlock()

	profileDir, err := os.MkdirTemp("", "web-model-"+input.Key+"-")
	if err != nil {
		return fmt.Errorf("create temp profile dir: %w", err)
	}
	profileDir = filepath.Clean(profileDir)

	p, err := qwen.New(qwen.Config{
		Key:         input.Key,
		DisplayName: input.DisplayName,
		Account:     input.Account,
		Role:        input.Role,
		ProfileDir:  profileDir,
	}, m.sessions)
	if err != nil {
		_ = os.RemoveAll(profileDir)
		return err
	}

	meta := p.Meta()
	m.mu.Lock()
	defer m.mu.Unlock()
	m.instances[input.Key] = &instance{
		provider:   p,
		meta:       meta,
		status:     StatusNew,
		profileDir: profileDir,
	}
	return nil
}

func (m *Manager) Remove(ctx context.Context, key string) error {
	m.mu.Lock()
	item, ok := m.instances[key]
	if ok {
		delete(m.instances, key)
	}
	m.mu.Unlock()

	if !ok {
		return nil
	}

	if cleaner, ok := item.provider.(provider.Cleaner); ok {
		if err := cleaner.Cleanup(ctx); err != nil {
			return err
		}
	}
	if item.profileDir != "" {
		_ = os.RemoveAll(item.profileDir)
	}
	return nil
}

func (m *Manager) OpenSetup(ctx context.Context, key string) error {
	item, ok := m.getInstance(key)
	if !ok {
		return fmt.Errorf("provider %q not found", key)
	}

	opener, ok := item.provider.(provider.SetupOpener)
	if !ok {
		return fmt.Errorf("provider %q does not support setup", key)
	}

	m.setStatus(key, StatusSettingUp, "")
	if err := opener.OpenSetup(ctx); err != nil {
		m.setStatus(key, StatusError, err.Error())
		return err
	}
	return nil
}

func (m *Manager) CompleteAdd(key string) error {
	item, ok := m.getInstance(key)
	if !ok {
		return fmt.Errorf("provider %q not found", key)
	}
	if item.status != StatusSettingUp && item.status != StatusNew && item.status != StatusError {
		return fmt.Errorf("provider %q is not in add flow", key)
	}
	if closer, ok := item.provider.(provider.SetupCloser); ok {
		if err := closer.CloseSetup(context.Background()); err != nil {
			m.setStatus(key, StatusError, err.Error())
			return err
		}
	}
	m.setStatus(key, StatusReady, "")
	return nil
}

func (m *Manager) Inspect(ctx context.Context, key string) (provider.Inspection, error) {
	item, ok := m.getInstance(key)
	if !ok {
		return provider.Inspection{}, fmt.Errorf("provider %q not found", key)
	}

	inspector, ok := item.provider.(provider.Inspector)
	if !ok {
		return provider.Inspection{}, fmt.Errorf("provider %q does not support inspect", key)
	}

	return inspector.Inspect(ctx)
}

func (m *Manager) Snapshots() []Snapshot {
	m.mu.RLock()
	defer m.mu.RUnlock()

	keys := make([]string, 0, len(m.instances))
	for key := range m.instances {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	items := make([]Snapshot, 0, len(keys))
	for _, key := range keys {
		item := m.instances[key]
		items = append(items, Snapshot{
			Key:         item.meta.Key,
			Type:        item.meta.Type,
			DisplayName: item.meta.DisplayName,
			Account:     item.meta.Account,
			Role:        item.meta.Role,
			Status:      item.status,
			Error:       item.lastErr,
			ProfileDir:  item.profileDir,
		})
	}
	return items
}

func (m *Manager) Get(key string) (provider.Provider, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	item, ok := m.instances[key]
	if !ok || item.status != StatusReady {
		return nil, false
	}
	return item.provider, true
}

func (m *Manager) List() []provider.Meta {
	m.mu.RLock()
	defer m.mu.RUnlock()

	keys := make([]string, 0, len(m.instances))
	for key := range m.instances {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	items := make([]provider.Meta, 0, len(keys))
	for _, key := range keys {
		item := m.instances[key]
		if item.status == StatusReady {
			items = append(items, item.meta)
		}
	}
	return items
}

func (m *Manager) Names() []string {
	items := m.List()
	names := make([]string, 0, len(items))
	for _, item := range items {
		names = append(names, item.Key)
	}
	sort.Strings(names)
	return names
}

func (m *Manager) MarkBusy(key string) func() {
	m.mu.Lock()
	item, ok := m.instances[key]
	if ok {
		item.status = StatusBusy
		item.lastErr = ""
	}
	m.mu.Unlock()

	return func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		if item, ok := m.instances[key]; ok {
			item.status = StatusReady
		}
	}
}

func (m *Manager) RecordError(key string, err error) {
	if err == nil {
		return
	}
	m.setStatus(key, StatusError, err.Error())
}

func (m *Manager) setStatus(key string, status Status, lastErr string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if item, ok := m.instances[key]; ok {
		item.status = status
		item.lastErr = lastErr
	}
}

func (m *Manager) getInstance(key string) (*instance, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	item, ok := m.instances[key]
	return item, ok
}
