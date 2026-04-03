package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"web-model/internal/chat"
	"web-model/internal/provider"
)

type Server struct {
	store   provider.Store
	counter atomic.Uint64
}

func NewServer(store provider.Store, wsHandler http.Handler) http.Handler {
	s := &Server{store: store}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealth)
	mux.HandleFunc("/providers", s.handleProviders)
	mux.HandleFunc("/v1/models", s.handleModels)
	mux.HandleFunc("/v1/chat/completions", s.handleChatCompletions)
	if wsHandler != nil {
		mux.Handle("/ws", wsHandler)
	}
	return mux
}

type chatCompletionRequest struct {
	Model       string         `json:"model"`
	Messages    []chat.Message `json:"messages"`
	Temperature *float64       `json:"temperature,omitempty"`
	TopP        *float64       `json:"top_p,omitempty"`
	MaxTokens   *int           `json:"max_tokens,omitempty"`
	Stop        any            `json:"stop,omitempty"`
	User        string         `json:"user,omitempty"`
	Stream      bool           `json:"stream,omitempty"`
}

type chatCompletionResponse struct {
	ID      string                 `json:"id"`
	Object  string                 `json:"object"`
	Created int64                  `json:"created"`
	Model   string                 `json:"model"`
	Choices []chatCompletionChoice `json:"choices"`
	Usage   usage                  `json:"usage"`
}

type chatCompletionChunkResponse struct {
	ID      string                      `json:"id"`
	Object  string                      `json:"object"`
	Created int64                       `json:"created"`
	Model   string                      `json:"model"`
	Choices []chatCompletionChunkChoice `json:"choices"`
}

type chatCompletionChunkChoice struct {
	Index        int          `json:"index"`
	Delta        chat.Message `json:"delta"`
	FinishReason *string      `json:"finish_reason"`
}

type chatCompletionChoice struct {
	Index        int          `json:"index"`
	Message      chat.Message `json:"message"`
	FinishReason string       `json:"finish_reason"`
}

type usage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

type errorEnvelope struct {
	Error apiError `json:"error"`
}

type modelsResponse struct {
	Object string      `json:"object"`
	Data   []modelInfo `json:"data"`
}

type modelInfo struct {
	ID       string        `json:"id"`
	Object   string        `json:"object"`
	Created  int64         `json:"created"`
	OwnedBy  string        `json:"owned_by"`
	Metadata provider.Meta `json:"metadata"`
}

type apiError struct {
	Message string  `json:"message"`
	Type    string  `json:"type"`
	Param   *string `json:"param"`
	Code    *string `json:"code"`
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status":    "ok",
		"providers": s.store.Names(),
	})
}

func (s *Server) handleProviders(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "invalid_request_error", "method not allowed")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"object": "list",
		"data":   s.store.List(),
	})
}

func (s *Server) handleModels(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "invalid_request_error", "method not allowed")
		return
	}

	items := s.store.List()
	models := make([]modelInfo, 0, len(items))
	for _, item := range items {
		models = append(models, modelInfo{
			ID:       item.Key,
			Object:   "model",
			Created:  0,
			OwnedBy:  "web-model",
			Metadata: item,
		})
	}

	writeJSON(w, http.StatusOK, modelsResponse{
		Object: "list",
		Data:   models,
	})
}

func (s *Server) handleChatCompletions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "invalid_request_error", "method not allowed")
		return
	}

	var req chatCompletionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid_request_error", "invalid JSON body")
		return
	}

	if strings.TrimSpace(req.Model) == "" {
		writeOpenAIError(w, http.StatusBadRequest, "invalid_request_error", "model is required")
		return
	}
	if len(req.Messages) == 0 {
		writeOpenAIError(w, http.StatusBadRequest, "invalid_request_error", "messages is required")
		return
	}
	p, ok := s.store.Get(req.Model)
	if !ok {
		writeOpenAIError(w, http.StatusBadRequest, "invalid_request_error", fmt.Sprintf("unknown provider %q", req.Model))
		return
	}

	if req.Stream {
		s.handleChatCompletionsStream(w, r, req, p)
		return
	}

	result, err := p.Chat(r.Context(), chat.Request{
		Model:       req.Model,
		Messages:    req.Messages,
		Temperature: req.Temperature,
		TopP:        req.TopP,
		MaxTokens:   req.MaxTokens,
		Stop:        req.Stop,
		User:        req.User,
	})
	if err != nil {
		if errors.Is(err, provider.ErrBusy) {
			writeOpenAIError(w, http.StatusTooManyRequests, "rate_limit_error", "provider is busy")
			return
		}
		writeOpenAIError(w, http.StatusBadGateway, "provider_error", err.Error())
		return
	}

	resp := chatCompletionResponse{
		ID:      s.nextID(),
		Object:  "chat.completion",
		Created: time.Now().Unix(),
		Model:   req.Model,
		Choices: []chatCompletionChoice{
			{
				Index:        0,
				Message:      result.Message,
				FinishReason: "stop",
			},
		},
		Usage: usage{
			PromptTokens:     result.PromptTokens,
			CompletionTokens: result.CompletionTokens,
			TotalTokens:      result.PromptTokens + result.CompletionTokens,
		},
	}

	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) handleChatCompletionsStream(w http.ResponseWriter, r *http.Request, req chatCompletionRequest, p provider.Provider) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeOpenAIError(w, http.StatusInternalServerError, "server_error", "streaming is not supported by this server")
		return
	}

	streamer, ok := p.(provider.Streamer)
	if !ok {
		result, err := p.Chat(r.Context(), chat.Request{
			Model:       req.Model,
			Messages:    req.Messages,
			Temperature: req.Temperature,
			TopP:        req.TopP,
			MaxTokens:   req.MaxTokens,
			Stop:        req.Stop,
			User:        req.User,
		})
		if err != nil {
			if errors.Is(err, provider.ErrBusy) {
				writeOpenAIError(w, http.StatusTooManyRequests, "rate_limit_error", "provider is busy")
				return
			}
			writeOpenAIError(w, http.StatusBadGateway, "provider_error", err.Error())
			return
		}
		writeSSEHeaders(w)
		chunkID := s.nextID()
		createdAt := time.Now().Unix()
		writeSSEChunk(w, flusher, buildRoleChunk(chunkID, createdAt, req.Model))
		if content := result.Message.Content; content != "" {
			writeSSEChunk(w, flusher, buildContentChunk(chunkID, createdAt, req.Model, content))
		}
		writeSSEChunk(w, flusher, buildStopChunk(chunkID, createdAt, req.Model))
		writeSSEDone(w, flusher)
		return
	}

	events, err := streamer.ChatStream(r.Context(), chat.Request{
		Model:       req.Model,
		Messages:    req.Messages,
		Temperature: req.Temperature,
		TopP:        req.TopP,
		MaxTokens:   req.MaxTokens,
		Stop:        req.Stop,
		User:        req.User,
	})
	if err != nil {
		if errors.Is(err, provider.ErrBusy) {
			writeOpenAIError(w, http.StatusTooManyRequests, "rate_limit_error", "provider is busy")
			return
		}
		writeOpenAIError(w, http.StatusBadGateway, "provider_error", err.Error())
		return
	}

	writeSSEHeaders(w)
	chunkID := s.nextID()
	createdAt := time.Now().Unix()
	writeSSEChunk(w, flusher, buildRoleChunk(chunkID, createdAt, req.Model))

	var streamedContent strings.Builder
	for event := range events {
		if event.Delta != "" {
			streamedContent.WriteString(event.Delta)
			writeSSEChunk(w, flusher, buildContentChunk(chunkID, createdAt, req.Model, event.Delta))
		}

		if event.Err != nil {
			writeSSEError(w, flusher, "provider_error", event.Err.Error())
			writeSSEDone(w, flusher)
			return
		}

		if event.Done {
			if event.Response != nil {
				fullContent := event.Response.Message.Content
				sentContent := streamedContent.String()
				if fullContent != "" && fullContent != sentContent {
					remainder := strings.TrimPrefix(fullContent, sentContent)
					if remainder == "" && sentContent == "" {
						remainder = fullContent
					}
					if remainder != "" {
						writeSSEChunk(w, flusher, buildContentChunk(chunkID, createdAt, req.Model, remainder))
					}
				}
			}
			writeSSEChunk(w, flusher, buildStopChunk(chunkID, createdAt, req.Model))
			writeSSEDone(w, flusher)
			return
		}
	}

	writeSSEChunk(w, flusher, buildStopChunk(chunkID, createdAt, req.Model))
	writeSSEDone(w, flusher)
}

func (s *Server) nextID() string {
	return fmt.Sprintf("chatcmpl-%d", s.counter.Add(1))
}

func writeOpenAIError(w http.ResponseWriter, status int, errType, message string) {
	writeJSON(w, status, errorEnvelope{
		Error: apiError{
			Message: message,
			Type:    errType,
		},
	})
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeSSEHeaders(w http.ResponseWriter) {
	headers := w.Header()
	headers.Set("Content-Type", "text/event-stream")
	headers.Set("Cache-Control", "no-cache")
	headers.Set("Connection", "keep-alive")
	headers.Set("X-Accel-Buffering", "no")
}

func writeSSEChunk(w http.ResponseWriter, flusher http.Flusher, payload any) {
	raw, _ := json.Marshal(payload)
	_, _ = fmt.Fprintf(w, "data: %s\n\n", raw)
	flusher.Flush()
}

func writeSSEError(w http.ResponseWriter, flusher http.Flusher, errType, message string) {
	raw, _ := json.Marshal(errorEnvelope{
		Error: apiError{
			Message: message,
			Type:    errType,
		},
	})
	_, _ = fmt.Fprintf(w, "data: %s\n\n", raw)
	flusher.Flush()
}

func writeSSEDone(w http.ResponseWriter, flusher http.Flusher) {
	_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
	flusher.Flush()
}

func buildRoleChunk(id string, created int64, model string) chatCompletionChunkResponse {
	return chatCompletionChunkResponse{
		ID:      id,
		Object:  "chat.completion.chunk",
		Created: created,
		Model:   model,
		Choices: []chatCompletionChunkChoice{
			{
				Index: 0,
				Delta: chat.Message{
					Role: "assistant",
				},
			},
		},
	}
}

func buildContentChunk(id string, created int64, model, delta string) chatCompletionChunkResponse {
	return chatCompletionChunkResponse{
		ID:      id,
		Object:  "chat.completion.chunk",
		Created: created,
		Model:   model,
		Choices: []chatCompletionChunkChoice{
			{
				Index: 0,
				Delta: chat.Message{
					Content: delta,
				},
			},
		},
	}
}

func buildStopChunk(id string, created int64, model string) chatCompletionChunkResponse {
	finishReason := "stop"
	return chatCompletionChunkResponse{
		ID:      id,
		Object:  "chat.completion.chunk",
		Created: created,
		Model:   model,
		Choices: []chatCompletionChunkChoice{
			{
				Index:        0,
				Delta:        chat.Message{},
				FinishReason: &finishReason,
			},
		},
	}
}
