package browser

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"
)

type SessionSpec struct {
	Key        string            `json:"key"`
	Type       string            `json:"type"`
	StartURL   string            `json:"start_url,omitempty"`
	ProfileDir string            `json:"profile_dir,omitempty"`
	Account    string            `json:"account,omitempty"`
	Role       string            `json:"role,omitempty"`
	Metadata   map[string]string `json:"metadata,omitempty"`
}

type Handle interface {
	EnsureReady(ctx context.Context) error
	Close(ctx context.Context) error
	Context() context.Context
}

type Launcher interface {
	Launch(ctx context.Context, spec SessionSpec) (Handle, error)
}

type Session struct {
	spec     SessionSpec
	launcher Launcher

	mu     sync.Mutex
	handle Handle
}

func (s *Session) Spec() SessionSpec {
	return cloneSpec(s.spec)
}

func (s *Session) Do(ctx context.Context, fn func(context.Context, Handle) error) error {
	if fn == nil {
		return fmt.Errorf("session callback is nil")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	handle, err := s.ensureHandleLocked(ctx)
	if err != nil {
		return err
	}

	return fn(ctx, handle)
}

func (s *Session) Close(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.handle == nil {
		return nil
	}

	err := s.handle.Close(ctx)
	s.handle = nil
	return err
}

func (s *Session) ensureHandleLocked(ctx context.Context) (Handle, error) {
	if s.handle != nil {
		if err := s.handle.EnsureReady(ctx); err != nil {
			return nil, err
		}
		return s.handle, nil
	}

	handle, err := s.launcher.Launch(ctx, s.spec)
	if err != nil {
		return nil, err
	}
	if err := handle.EnsureReady(ctx); err != nil {
		_ = handle.Close(ctx)
		return nil, err
	}

	s.handle = handle
	return s.handle, nil
}

type Manager struct {
	launcher Launcher

	mu       sync.Mutex
	sessions map[string]*Session
}

func NewManager(launcher Launcher) *Manager {
	return &Manager{
		launcher: launcher,
		sessions: make(map[string]*Session),
	}
}

func (m *Manager) Get(ctx context.Context, spec SessionSpec) (*Session, error) {
	if err := validateSpec(spec); err != nil {
		return nil, err
	}
	if m.launcher == nil {
		return nil, fmt.Errorf("browser launcher is nil")
	}

	normalized := cloneSpec(spec)

	m.mu.Lock()
	defer m.mu.Unlock()

	if existing, ok := m.sessions[normalized.Key]; ok {
		if err := ensureCompatible(existing.spec, normalized); err != nil {
			return nil, err
		}
		return existing, nil
	}

	session := &Session{
		spec:     normalized,
		launcher: m.launcher,
	}
	m.sessions[normalized.Key] = session
	return session, nil
}

func (m *Manager) List() []SessionSpec {
	m.mu.Lock()
	defer m.mu.Unlock()

	keys := make([]string, 0, len(m.sessions))
	for key := range m.sessions {
		keys = append(keys, key)
	}
	slices.Sort(keys)

	items := make([]SessionSpec, 0, len(keys))
	for _, key := range keys {
		items = append(items, cloneSpec(m.sessions[key].spec))
	}
	return items
}

func (m *Manager) Close(ctx context.Context) error {
	m.mu.Lock()
	sessions := make([]*Session, 0, len(m.sessions))
	for _, session := range m.sessions {
		sessions = append(sessions, session)
	}
	m.sessions = make(map[string]*Session)
	m.mu.Unlock()

	var errs []error
	for _, session := range sessions {
		if err := session.Close(ctx); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func (m *Manager) Remove(ctx context.Context, key string) error {
	m.mu.Lock()
	session, ok := m.sessions[key]
	if ok {
		delete(m.sessions, key)
	}
	m.mu.Unlock()

	if !ok {
		return nil
	}
	return session.Close(ctx)
}

func validateSpec(spec SessionSpec) error {
	if spec.Key == "" {
		return fmt.Errorf("session key is required")
	}
	if spec.Type == "" {
		return fmt.Errorf("session type is required")
	}
	return nil
}

func ensureCompatible(existing, incoming SessionSpec) error {
	if existing.Type != incoming.Type {
		return fmt.Errorf("session %q already exists with type %q", existing.Key, existing.Type)
	}
	if existing.ProfileDir != incoming.ProfileDir {
		return fmt.Errorf("session %q already exists with profile_dir %q", existing.Key, existing.ProfileDir)
	}
	if existing.StartURL != incoming.StartURL {
		return fmt.Errorf("session %q already exists with start_url %q", existing.Key, existing.StartURL)
	}
	if existing.Account != incoming.Account {
		return fmt.Errorf("session %q already exists with account %q", existing.Key, existing.Account)
	}
	if existing.Role != incoming.Role {
		return fmt.Errorf("session %q already exists with role %q", existing.Key, existing.Role)
	}
	if !mapsEqual(existing.Metadata, incoming.Metadata) {
		return fmt.Errorf("session %q already exists with different metadata", existing.Key)
	}
	return nil
}

func cloneSpec(spec SessionSpec) SessionSpec {
	cloned := spec
	if spec.Metadata != nil {
		cloned.Metadata = make(map[string]string, len(spec.Metadata))
		for key, value := range spec.Metadata {
			cloned.Metadata[key] = value
		}
	}
	return cloned
}

func mapsEqual(left, right map[string]string) bool {
	if len(left) != len(right) {
		return false
	}
	for key, leftValue := range left {
		if rightValue, ok := right[key]; !ok || rightValue != leftValue {
			return false
		}
	}
	return true
}
