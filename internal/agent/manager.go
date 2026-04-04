package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"web-model/internal/chat"
	"web-model/internal/provider"
)

const (
	messageTypeHello       = "hello"
	messageTypeHelloAck    = "hello.ack"
	messageTypePing        = "ping"
	messageTypePong        = "pong"
	messageTypeError       = "error"
	messageTypeChatRequest = "chat.request"
	messageTypeChatDelta   = "chat.delta"
	messageTypeChatDone    = "chat.done"
	messageTypeChatError   = "chat.error"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin: func(*http.Request) bool {
		return true
	},
}

type Manager struct {
	mu                 sync.RWMutex
	agents             map[string]*session
	chatCounts         map[string]int
	penaltyUntil       map[string]time.Time
	counter            atomic.Uint64
	maxChatsPerSession int
}

type Snapshot struct {
	Meta               provider.Meta
	Busy               bool
	ChatCount          int
	RemainingChats     int
	MaxChatsPerSession int
	ConnectedAt        time.Time
	PenaltyUntil       time.Time
}

type Config struct {
	MaxChatsPerSession int
}

func NewManager(cfg Config) *Manager {
	maxChatsPerSession := cfg.MaxChatsPerSession
	if maxChatsPerSession <= 0 {
		maxChatsPerSession = 10
	}
	return &Manager{
		agents:             make(map[string]*session),
		chatCounts:         make(map[string]int),
		penaltyUntil:       make(map[string]time.Time),
		maxChatsPerSession: maxChatsPerSession,
	}
}

func (m *Manager) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	log.Printf("[agent] websocket connected from %s", r.RemoteAddr)

	if err := conn.SetReadDeadline(time.Now().Add(15 * time.Second)); err != nil {
		_ = conn.Close()
		return
	}

	var hello helloEnvelope
	if err := conn.ReadJSON(&hello); err != nil {
		writeControlError(conn, fmt.Sprintf("read hello: %v", err))
		_ = conn.Close()
		return
	}

	meta, err := validateHello(hello)
	if err != nil {
		log.Printf("[agent] invalid hello from %s: %v", r.RemoteAddr, err)
		writeControlError(conn, err.Error())
		_ = conn.Close()
		return
	}

	s := newSession(m, conn, meta)
	if err := m.register(s); err != nil {
		log.Printf("[agent] register failed key=%s remote=%s: %v", meta.Key, r.RemoteAddr, err)
		writeControlError(conn, err.Error())
		_ = conn.Close()
		return
	}
	defer m.unregister(s)
	log.Printf("[agent] registered key=%s type=%s remote=%s", meta.Key, meta.Type, r.RemoteAddr)

	if err := conn.SetReadDeadline(time.Time{}); err != nil {
		s.closeWithError(err)
		return
	}

	if err := s.writeJSON(helloAckEnvelope{
		Type: messageTypeHelloAck,
		Key:  meta.Key,
	}); err != nil {
		log.Printf("[agent] hello ack failed key=%s: %v", meta.Key, err)
		s.closeWithError(err)
		return
	}

	s.readLoop()
}

func (m *Manager) Close() error {
	m.mu.Lock()
	items := make([]*session, 0, len(m.agents))
	for _, item := range m.agents {
		items = append(items, item)
	}
	m.agents = make(map[string]*session)
	m.mu.Unlock()

	for _, item := range items {
		item.closeWithError(errors.New("server shutdown"))
	}
	return nil
}

func (m *Manager) Get(key string) (provider.Provider, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	item, ok := m.agents[key]
	return item, ok
}

func (m *Manager) List() []provider.Meta {
	m.mu.RLock()
	defer m.mu.RUnlock()

	keys := make([]string, 0, len(m.agents))
	for key := range m.agents {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	items := make([]provider.Meta, 0, len(keys))
	for _, key := range keys {
		items = append(items, m.agents[key].Meta())
	}
	return items
}

func (m *Manager) Names() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()

	keys := make([]string, 0, len(m.agents))
	for key := range m.agents {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func (m *Manager) Snapshots() []Snapshot {
	m.mu.RLock()
	defer m.mu.RUnlock()

	keys := make([]string, 0, len(m.agents))
	for key := range m.agents {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	items := make([]Snapshot, 0, len(keys))
	for _, key := range keys {
		current := m.chatCounts[key]
		remaining := m.maxChatsPerSession - current
		if remaining < 0 {
			remaining = 0
		}
		items = append(items, Snapshot{
			Meta:               m.agents[key].Meta(),
			Busy:               m.agents[key].busy.Load(),
			ChatCount:          current,
			RemainingChats:     remaining,
			MaxChatsPerSession: m.maxChatsPerSession,
			ConnectedAt:        m.agents[key].connectedAt,
			PenaltyUntil:       m.penaltyUntil[key],
		})
	}
	return items
}

func (m *Manager) nextRequestID() string {
	return fmt.Sprintf("req-%d", m.counter.Add(1))
}

func (m *Manager) register(s *session) error {
	m.mu.Lock()
	replaced := m.agents[s.meta.Key]
	m.agents[s.meta.Key] = s
	m.mu.Unlock()

	if replaced != nil && replaced != s {
		replaced.closeWithError(errors.New("replaced by newer connection"))
	}
	return nil
}

func (m *Manager) unregister(s *session) {
	m.mu.Lock()
	defer m.mu.Unlock()

	current, ok := m.agents[s.meta.Key]
	if ok && current == s {
		delete(m.agents, s.meta.Key)
	}
}

type session struct {
	manager *Manager
	conn    *websocket.Conn
	meta    provider.Meta

	sendMu sync.Mutex
	chatMu sync.Mutex
	busy   atomic.Bool

	mu      sync.Mutex
	pending map[string]*pendingRequest
	closed  bool

	connectedAt time.Time
}

type pendingRequest struct {
	resultCh chan chatResult
	streamCh chan chat.StreamEvent
}

func newSession(manager *Manager, conn *websocket.Conn, meta provider.Meta) *session {
	return &session{
		manager: manager,
		conn:    conn,
		meta:    meta,
		pending: make(map[string]*pendingRequest),
		connectedAt: time.Now(),
	}
}

func (s *session) Name() string {
	return s.meta.Type
}

func (s *session) Meta() provider.Meta {
	meta := s.meta
	meta.Tags = append([]string(nil), s.meta.Tags...)
	return meta
}

func (s *session) Busy() bool {
	return s.busy.Load()
}

func (s *session) PenaltyUntil() time.Time {
	s.manager.mu.RLock()
	defer s.manager.mu.RUnlock()
	return s.manager.penaltyUntil[s.meta.Key]
}

func (s *session) Chat(ctx context.Context, req chat.Request) (chat.Response, error) {
	if !s.chatMu.TryLock() {
		return chat.Response{}, provider.ErrBusy
	}
	s.busy.Store(true)
	defer s.chatMu.Unlock()
	defer s.busy.Store(false)

	requestID := s.manager.nextRequestID()
	resultCh := make(chan chatResult, 1)

	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return chat.Response{}, errors.New("provider is disconnected")
	}
	s.pending[requestID] = &pendingRequest{resultCh: resultCh}
	s.mu.Unlock()
	log.Printf("[agent] chat dispatch key=%s request_id=%s model=%s messages=%d", s.meta.Key, requestID, req.Model, len(req.Messages))
	startNewChatBeforeSend := s.shouldStartNewChatBeforeSend()
	log.Printf("[agent] chat dispatch state key=%s request_id=%s chat_count=%d start_new_chat_before_send=%t", s.meta.Key, requestID, s.chatCountValue(), startNewChatBeforeSend)

	if err := s.writeJSON(chatRequestEnvelope{
		Type:                   messageTypeChatRequest,
		RequestID:              requestID,
		Request:                req,
		StartNewChatBeforeSend: startNewChatBeforeSend,
	}); err != nil {
		s.dropPending(requestID)
		s.closeWithError(err)
		return chat.Response{}, err
	}

	select {
	case <-ctx.Done():
		s.dropPending(requestID)
		log.Printf("[agent] chat canceled key=%s request_id=%s: %v", s.meta.Key, requestID, ctx.Err())
		return chat.Response{}, ctx.Err()
	case result := <-resultCh:
		if result.err != nil {
			log.Printf("[agent] chat failed key=%s request_id=%s: %v", s.meta.Key, requestID, result.err)
		} else {
			log.Printf("[agent] chat done key=%s request_id=%s completion_tokens=%d", s.meta.Key, requestID, result.response.CompletionTokens)
		}
		return result.response, result.err
	}
}

func (s *session) ChatStream(ctx context.Context, req chat.Request) (<-chan chat.StreamEvent, error) {
	if !s.chatMu.TryLock() {
		return nil, provider.ErrBusy
	}
	s.busy.Store(true)

	requestID := s.manager.nextRequestID()
	internalCh := make(chan chat.StreamEvent, 16)

	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		s.chatMu.Unlock()
		return nil, errors.New("provider is disconnected")
	}
	s.pending[requestID] = &pendingRequest{streamCh: internalCh}
	s.mu.Unlock()
	log.Printf("[agent] chat stream dispatch key=%s request_id=%s model=%s messages=%d", s.meta.Key, requestID, req.Model, len(req.Messages))
	startNewChatBeforeSend := s.shouldStartNewChatBeforeSend()
	log.Printf("[agent] chat stream dispatch state key=%s request_id=%s chat_count=%d start_new_chat_before_send=%t", s.meta.Key, requestID, s.chatCountValue(), startNewChatBeforeSend)

	if err := s.writeJSON(chatRequestEnvelope{
		Type:                   messageTypeChatRequest,
		RequestID:              requestID,
		Request:                req,
		StartNewChatBeforeSend: startNewChatBeforeSend,
	}); err != nil {
		s.dropPending(requestID)
		s.chatMu.Unlock()
		s.closeWithError(err)
		return nil, err
	}

	out := make(chan chat.StreamEvent, 16)
	go func() {
		defer close(out)
		defer s.chatMu.Unlock()
		defer s.busy.Store(false)

		for {
			select {
			case <-ctx.Done():
				s.dropPending(requestID)
				log.Printf("[agent] chat stream canceled key=%s request_id=%s: %v", s.meta.Key, requestID, ctx.Err())
				out <- chat.StreamEvent{Err: ctx.Err(), Done: true}
				return
			case event, ok := <-internalCh:
				if !ok {
					return
				}
				out <- event
				if event.Err != nil {
					log.Printf("[agent] chat stream failed key=%s request_id=%s: %v", s.meta.Key, requestID, event.Err)
					return
				}
				if event.Done {
					log.Printf("[agent] chat stream done key=%s request_id=%s", s.meta.Key, requestID)
					return
				}
			}
		}
	}()

	return out, nil
}

func (s *session) readLoop() {
	for {
		var envelope rawEnvelope
		if err := s.conn.ReadJSON(&envelope); err != nil {
			s.closeWithError(err)
			return
		}

		switch envelope.Type {
		case messageTypePing:
			var msg heartbeatEnvelope
			if err := json.Unmarshal(envelope.Payload, &msg); err != nil {
				s.closeWithError(fmt.Errorf("decode ping: %w", err))
				return
			}
			if err := s.writeJSON(heartbeatEnvelope{
				Type: messageTypePong,
				At:   msg.At,
			}); err != nil {
				s.closeWithError(fmt.Errorf("write pong: %w", err))
				return
			}
		case messageTypeChatDelta:
			var msg chatDeltaEnvelope
			if err := json.Unmarshal(envelope.Payload, &msg); err != nil {
				s.closeWithError(fmt.Errorf("decode chat.delta: %w", err))
				return
			}
			log.Printf("[agent] recv chat.delta key=%s request_id=%s len=%d", s.meta.Key, msg.RequestID, len(msg.Delta))
			s.pushDelta(msg.RequestID, msg.Delta)
		case messageTypeChatDone:
			var msg chatDoneEnvelope
			if err := json.Unmarshal(envelope.Payload, &msg); err != nil {
				s.closeWithError(fmt.Errorf("decode chat.done: %w", err))
				return
			}
			log.Printf("[agent] recv chat.done key=%s request_id=%s", s.meta.Key, msg.RequestID)
			s.recordChatDone(msg.StartedNewChat)
			s.resolvePending(msg.RequestID, chatResult{
				response: chat.Response{
					Message: chat.Message{
						Role:    roleOrDefault(msg.Message.Role, "assistant"),
						Content: msg.Message.Content,
						Name:    msg.Message.Name,
					},
					PromptTokens:     msg.PromptTokens,
					CompletionTokens: msg.CompletionTokens,
				},
			})
		case messageTypeChatError:
			var msg chatErrorEnvelope
			if err := json.Unmarshal(envelope.Payload, &msg); err != nil {
				s.closeWithError(fmt.Errorf("decode chat.error: %w", err))
				return
			}
			log.Printf("[agent] recv chat.error key=%s request_id=%s error=%s", s.meta.Key, msg.RequestID, strings.TrimSpace(msg.Error))
			s.recordChatError(msg.StartedNewChat)
			errMessage := strings.TrimSpace(msg.Error)
			if errMessage == "" {
				errMessage = "remote provider returned an empty error"
			}
			s.resolvePending(msg.RequestID, chatResult{
				err: errors.New(errMessage),
			})
		}
	}
}

func (s *session) writeJSON(payload any) error {
	s.sendMu.Lock()
	defer s.sendMu.Unlock()
	return s.conn.WriteJSON(payload)
}

func (s *session) closeWithError(err error) {
	if err == nil {
		err = errors.New("connection closed")
	}

	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true

	pending := s.pending
	s.pending = make(map[string]*pendingRequest)
	s.mu.Unlock()

	for _, item := range pending {
		if item.resultCh != nil {
			item.resultCh <- chatResult{err: err}
		}
		if item.streamCh != nil {
			item.streamCh <- chat.StreamEvent{Err: err, Done: true}
			close(item.streamCh)
		}
	}

	s.manager.unregister(s)
	log.Printf("[agent] connection closed key=%s: %v", s.meta.Key, err)
	_ = s.conn.Close()
}

func (s *session) dropPending(requestID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.pending, requestID)
}

func (s *session) resolvePending(requestID string, result chatResult) {
	s.mu.Lock()
	item, ok := s.pending[requestID]
	if ok {
		delete(s.pending, requestID)
	}
	s.mu.Unlock()

	if !ok {
		return
	}
	if item.resultCh != nil {
		item.resultCh <- result
	}
	if item.streamCh != nil {
		if result.err != nil {
			item.streamCh <- chat.StreamEvent{Err: result.err, Done: true}
		} else {
			response := result.response
			item.streamCh <- chat.StreamEvent{Response: &response, Done: true}
		}
		close(item.streamCh)
	}
}

func (s *session) pushDelta(requestID, delta string) {
	s.mu.Lock()
	item, ok := s.pending[requestID]
	s.mu.Unlock()

	if !ok || item.streamCh == nil || delta == "" {
		return
	}
	item.streamCh <- chat.StreamEvent{Delta: delta}
}

func (s *session) shouldStartNewChatBeforeSend() bool {
	s.manager.mu.RLock()
	defer s.manager.mu.RUnlock()
	return s.manager.chatCounts[s.meta.Key] >= s.manager.maxChatsPerSession
}

func (s *session) chatCountValue() int {
	s.manager.mu.RLock()
	defer s.manager.mu.RUnlock()
	return s.manager.chatCounts[s.meta.Key]
}

func (s *session) recordChatDone(startedNewChat bool) {
	s.manager.mu.Lock()
	defer s.manager.mu.Unlock()
	current := s.manager.chatCounts[s.meta.Key]
	if startedNewChat {
		current = 0
	}
	current += 1
	s.manager.chatCounts[s.meta.Key] = current
	log.Printf("[agent] chat count updated key=%s started_new_chat=%t chat_count=%d", s.meta.Key, startedNewChat, current)
}

func (s *session) recordChatError(startedNewChat bool) {
	s.manager.mu.Lock()
	defer s.manager.mu.Unlock()
	if startedNewChat {
		s.manager.chatCounts[s.meta.Key] = 0
		log.Printf("[agent] chat count reset after new chat error key=%s chat_count=0", s.meta.Key)
	}
	until := time.Now().Add(time.Minute)
	s.manager.penaltyUntil[s.meta.Key] = until
	log.Printf("[agent] chat penalty updated key=%s penalty_until=%s", s.meta.Key, until.Format(time.RFC3339))
}

type chatResult struct {
	response chat.Response
	err      error
}

type rawEnvelope struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"-"`
}

func (r *rawEnvelope) UnmarshalJSON(data []byte) error {
	type alias rawEnvelope
	aux := struct {
		alias
	}{}
	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}
	r.Type = aux.Type
	r.Payload = append([]byte(nil), data...)
	return nil
}

type helloEnvelope struct {
	Type         string   `json:"type"`
	Key          string   `json:"key"`
	ProviderType string   `json:"provider_type"`
	DisplayName  string   `json:"display_name,omitempty"`
	Description  string   `json:"description,omitempty"`
	Homepage     string   `json:"homepage,omitempty"`
	Account      string   `json:"account,omitempty"`
	Role         string   `json:"role,omitempty"`
	Tags         []string `json:"tags,omitempty"`
}

type helloAckEnvelope struct {
	Type string `json:"type"`
	Key  string `json:"key"`
}

type heartbeatEnvelope struct {
	Type string `json:"type"`
	At   int64  `json:"at,omitempty"`
}

type chatRequestEnvelope struct {
	Type                   string       `json:"type"`
	RequestID              string       `json:"request_id"`
	Request                chat.Request `json:"request"`
	StartNewChatBeforeSend bool         `json:"start_new_chat_before_send,omitempty"`
}

type chatDeltaEnvelope struct {
	Type      string `json:"type"`
	RequestID string `json:"request_id"`
	Delta     string `json:"delta"`
}

type chatDoneEnvelope struct {
	Type             string       `json:"type"`
	RequestID        string       `json:"request_id"`
	Message          chat.Message `json:"message"`
	PromptTokens     int          `json:"prompt_tokens,omitempty"`
	CompletionTokens int          `json:"completion_tokens,omitempty"`
	StartedNewChat   bool         `json:"started_new_chat,omitempty"`
}

type chatErrorEnvelope struct {
	Type           string `json:"type"`
	RequestID      string `json:"request_id"`
	Error          string `json:"error"`
	StartedNewChat bool   `json:"started_new_chat,omitempty"`
}

func validateHello(hello helloEnvelope) (provider.Meta, error) {
	if hello.Type != messageTypeHello {
		return provider.Meta{}, fmt.Errorf("first message must be hello")
	}

	key := strings.TrimSpace(hello.Key)
	if key == "" {
		return provider.Meta{}, fmt.Errorf("provider key is required")
	}

	providerType := strings.TrimSpace(hello.ProviderType)
	if providerType == "" {
		return provider.Meta{}, fmt.Errorf("provider type is required")
	}

	displayName := strings.TrimSpace(hello.DisplayName)
	if displayName == "" {
		displayName = providerType
	}

	return provider.Meta{
		Key:         key,
		Type:        providerType,
		DisplayName: displayName,
		Description: strings.TrimSpace(hello.Description),
		Homepage:    strings.TrimSpace(hello.Homepage),
		Account:     strings.TrimSpace(hello.Account),
		Role:        strings.TrimSpace(hello.Role),
		Tags:        append([]string(nil), hello.Tags...),
	}, nil
}

func writeControlError(conn *websocket.Conn, message string) {
	_ = conn.WriteJSON(map[string]string{
		"type":    messageTypeError,
		"message": message,
	})
}

func roleOrDefault(value, fallback string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback
	}
	return value
}
