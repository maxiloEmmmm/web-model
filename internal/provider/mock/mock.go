package mock

import (
	"context"
	"fmt"
	"strings"

	"web-model/internal/chat"
	"web-model/internal/provider"
)

type Provider struct{}

func New() *Provider {
	return &Provider{}
}

func (p *Provider) Name() string {
	return "mock"
}

func (p *Provider) Meta() provider.Meta {
	return provider.Meta{
		Key:         p.Name(),
		Type:        p.Name(),
		DisplayName: "Mock Provider",
		Description: "Local test provider that echoes the latest user message.",
		Tags:        []string{"test", "mock"},
	}
}

func (p *Provider) Chat(_ context.Context, req chat.Request) (chat.Response, error) {
	var lastUser string
	for i := len(req.Messages) - 1; i >= 0; i-- {
		if req.Messages[i].Role == "user" {
			lastUser = req.Messages[i].Content
			break
		}
	}
	if strings.TrimSpace(lastUser) == "" {
		return chat.Response{}, fmt.Errorf("mock provider requires at least one user message")
	}

	promptTokens := 0
	for _, message := range req.Messages {
		promptTokens += estimateTokens(message.Content)
	}

	reply := chat.Message{
		Role:    "assistant",
		Content: "mock reply: " + lastUser,
	}

	return chat.Response{
		Message:          reply,
		PromptTokens:     promptTokens,
		CompletionTokens: estimateTokens(reply.Content),
	}, nil
}

func estimateTokens(text string) int {
	text = strings.TrimSpace(text)
	if text == "" {
		return 0
	}
	return len(strings.Fields(text))
}
