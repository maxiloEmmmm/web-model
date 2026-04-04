package provider

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"

	"web-model/internal/chat"
)

var ErrBusy = errors.New("provider is busy")

type Provider interface {
	Name() string
	Meta() Meta
	Chat(ctx context.Context, req chat.Request) (chat.Response, error)
}

type Streamer interface {
	ChatStream(ctx context.Context, req chat.Request) (<-chan chat.StreamEvent, error)
}

type BusyChecker interface {
	Busy() bool
}

type PenaltyChecker interface {
	PenaltyUntil() time.Time
}

type SetupOpener interface {
	OpenSetup(ctx context.Context) error
}

type SetupCloser interface {
	CloseSetup(ctx context.Context) error
}

type Inspector interface {
	Inspect(ctx context.Context) (Inspection, error)
}

type Cleaner interface {
	Cleanup(ctx context.Context) error
}

type Store interface {
	Get(key string) (Provider, bool)
	List() []Meta
	Names() []string
}

type Meta struct {
	Key         string   `json:"key"`
	Type        string   `json:"type,omitempty"`
	Account     string   `json:"account,omitempty"`
	Role        string   `json:"role,omitempty"`
	DisplayName string   `json:"display_name,omitempty"`
	Description string   `json:"description,omitempty"`
	Homepage    string   `json:"homepage,omitempty"`
	Tags        []string `json:"tags,omitempty"`
}

type Inspection struct {
	URL        string             `json:"url"`
	Title      string             `json:"title,omitempty"`
	TextSample string             `json:"text_sample,omitempty"`
	Inputs     []InspectionInput  `json:"inputs,omitempty"`
	Actions    []InspectionAction `json:"actions,omitempty"`
}

type InspectionInput struct {
	Tag         string `json:"tag,omitempty"`
	Type        string `json:"type,omitempty"`
	Placeholder string `json:"placeholder,omitempty"`
	AriaLabel   string `json:"aria_label,omitempty"`
	Role        string `json:"role,omitempty"`
}

type InspectionAction struct {
	Tag       string `json:"tag,omitempty"`
	Text      string `json:"text,omitempty"`
	AriaLabel string `json:"aria_label,omitempty"`
}

type Registry struct {
	mu        sync.RWMutex
	providers map[string]Provider
}

func NewRegistry() *Registry {
	return &Registry{
		providers: make(map[string]Provider),
	}
}

func (r *Registry) Register(p Provider) error {
	if p == nil {
		return fmt.Errorf("provider is nil")
	}
	if p.Name() == "" {
		return fmt.Errorf("provider type is empty")
	}
	meta := normalizeMeta(p)
	if meta.Key == "" {
		return fmt.Errorf("provider key is empty")
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	if _, exists := r.providers[meta.Key]; exists {
		return fmt.Errorf("provider key %q already registered", meta.Key)
	}
	r.providers[meta.Key] = p
	return nil
}

func (r *Registry) MustRegister(p Provider) {
	if err := r.Register(p); err != nil {
		panic(err)
	}
}

func (r *Registry) Get(key string) (Provider, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	p, ok := r.providers[key]
	return p, ok
}

func (r *Registry) Names() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()

	keys := make([]string, 0, len(r.providers))
	for key := range r.providers {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func (r *Registry) List() []Meta {
	r.mu.RLock()
	defer r.mu.RUnlock()

	keys := make([]string, 0, len(r.providers))
	for key := range r.providers {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	items := make([]Meta, 0, len(keys))
	for _, key := range keys {
		items = append(items, normalizeMeta(r.providers[key]))
	}
	return items
}

func normalizeMeta(p Provider) Meta {
	meta := p.Meta()
	if meta.Key == "" {
		meta.Key = p.Name()
	}
	if meta.Type == "" {
		meta.Type = p.Name()
	}
	return meta
}
