package quickcli

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

const DefaultBaseURL = "http://127.0.0.1:18080"

type modelsResponse struct {
	Data []modelInfo `json:"data"`
}

type modelInfo struct {
	ID       string       `json:"id"`
	Metadata providerMeta `json:"metadata"`
}

type providerMeta struct {
	Key  string `json:"key"`
	Type string `json:"type"`
}

type chatRequest struct {
	Model    string        `json:"model"`
	Messages []chatMessage `json:"messages"`
	Stream   bool          `json:"stream,omitempty"`
}

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatResponse struct {
	Model   string       `json:"model"`
	Choices []chatChoice `json:"choices"`
}

type chatChoice struct {
	Message chatMessage `json:"message"`
}

type chatChunkResponse struct {
	Model   string            `json:"model"`
	Choices []chatChunkChoice `json:"choices"`
}

type chatChunkChoice struct {
	Delta        chatMessage `json:"delta"`
	FinishReason *string     `json:"finish_reason"`
}

func Run(args []string, stdout, stderr io.Writer) error {
	stream := false
	if len(args) > 0 && args[0] == "--stream" {
		stream = true
		args = args[1:]
	}

	if len(args) < 2 {
		return fmt.Errorf("usage: quick [--stream] <model> <question>")
	}

	model := strings.TrimSpace(args[0])
	question := strings.TrimSpace(strings.Join(args[1:], " "))
	if model == "" {
		return fmt.Errorf("model is required")
	}
	if question == "" {
		return fmt.Errorf("question is required")
	}

	baseURL := strings.TrimRight(strings.TrimSpace(os.Getenv("WEB_MODEL_BASE_URL")), "/")
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}

	clientTimeout := 60 * time.Second
	if stream {
		clientTimeout = 0
	}
	client := &http.Client{Timeout: clientTimeout}

	modelKey, err := resolveModelTarget(client, baseURL, model)
	if err != nil {
		return err
	}

	answer, actualModel, err := sendChat(client, baseURL, modelKey, question, stream, stdout)
	if err != nil {
		return err
	}

	if strings.TrimSpace(actualModel) == "" {
		actualModel = modelKey
	}
	fmt.Fprintf(stderr, "provider_type=%s model=%s\n", model, actualModel)
	if !stream {
		fmt.Fprintln(stdout, answer)
	}
	return nil
}

func resolveModelTarget(client *http.Client, baseURL, model string) (string, error) {
	req, err := http.NewRequest(http.MethodGet, baseURL+"/v1/models", nil)
	if err != nil {
		return "", fmt.Errorf("build models request: %w", err)
	}

	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("request models list: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read models response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("models request failed: status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var payload modelsResponse
	if err := json.Unmarshal(body, &payload); err != nil {
		return "", fmt.Errorf("decode models response: %w", err)
	}

	target := strings.TrimSpace(model)
	available := make([]string, 0, len(payload.Data))
	matchCount := 0
	for _, item := range payload.Data {
		metaType := strings.TrimSpace(item.Metadata.Type)
		metaKey := strings.TrimSpace(item.Metadata.Key)
		modelID := strings.TrimSpace(item.ID)
		label := fmt.Sprintf("id=%s key=%s type=%s", modelID, metaKey, metaType)
		available = append(available, label)

		if modelMatchesTarget(item, target) {
			matchCount++
		}
	}

	if matchCount > 0 {
		return target, nil
	}

	if len(available) == 0 {
		return "", fmt.Errorf("no models returned by %s/v1/models", baseURL)
	}
	return "", fmt.Errorf("no model matched %q; available models: %s", target, strings.Join(available, " | "))
}

func modelMatchesTarget(item modelInfo, model string) bool {
	want := strings.ToLower(strings.TrimSpace(model))
	if want == "" {
		return false
	}

	metaType := strings.ToLower(strings.TrimSpace(item.Metadata.Type))
	metaKey := strings.ToLower(strings.TrimSpace(item.Metadata.Key))
	modelID := strings.ToLower(strings.TrimSpace(item.ID))

	if want == "*" {
		return true
	}
	if strings.HasSuffix(want, "*") {
		prefix := strings.TrimSpace(strings.TrimSuffix(want, "*"))
		if prefix == "" {
			return false
		}
		return metaType == prefix
	}

	return metaType == want || metaKey == want || modelID == want
}

func sendChat(client *http.Client, baseURL, modelKey, question string, stream bool, stdout io.Writer) (string, string, error) {
	raw, err := json.Marshal(chatRequest{
		Model: modelKey,
		Messages: []chatMessage{
			{
				Role:    "user",
				Content: question,
			},
		},
		Stream: stream,
	})
	if err != nil {
		return "", "", fmt.Errorf("encode chat request: %w", err)
	}

	req, err := http.NewRequest(http.MethodPost, baseURL+"/v1/chat/completions", bytes.NewReader(raw))
	if err != nil {
		return "", "", fmt.Errorf("build chat request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return "", "", fmt.Errorf("request chat completion: %w", err)
	}
	defer resp.Body.Close()

	if stream {
		return readChatStream(resp, stdout)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", "", fmt.Errorf("read chat response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return "", "", fmt.Errorf("chat request failed: status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var payload chatResponse
	if err := json.Unmarshal(body, &payload); err != nil {
		return "", "", fmt.Errorf("decode chat response: %w", err)
	}
	if len(payload.Choices) == 0 {
		return "", "", fmt.Errorf("chat response has no choices")
	}

	return payload.Choices[0].Message.Content, strings.TrimSpace(payload.Model), nil
}

func readChatStream(resp *http.Response, stdout io.Writer) (string, string, error) {
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", "", fmt.Errorf("chat request failed: status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	var answer strings.Builder
	actualModel := ""
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}

		payload := strings.TrimPrefix(line, "data: ")
		if payload == "[DONE]" {
			break
		}

		var chunk chatChunkResponse
		if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
			continue
		}
		if actualModel == "" && strings.TrimSpace(chunk.Model) != "" {
			actualModel = strings.TrimSpace(chunk.Model)
		}
		for _, choice := range chunk.Choices {
			delta := choice.Delta.Content
			if delta == "" {
				if choice.FinishReason != nil && strings.TrimSpace(*choice.FinishReason) != "" {
					return answer.String(), actualModel, nil
				}
				continue
			}
			answer.WriteString(delta)
			fmt.Fprint(stdout, delta)
			if choice.FinishReason != nil && strings.TrimSpace(*choice.FinishReason) != "" {
				return answer.String(), actualModel, nil
			}
		}
	}

	if err := scanner.Err(); err != nil {
		return answer.String(), actualModel, fmt.Errorf("read chat stream: %w", err)
	}

	return answer.String(), actualModel, nil
}
