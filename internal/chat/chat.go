package chat

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
	Name    string `json:"name,omitempty"`
}

type Request struct {
	Model       string    `json:"model"`
	Messages    []Message `json:"messages"`
	Temperature *float64  `json:"temperature,omitempty"`
	TopP        *float64  `json:"top_p,omitempty"`
	MaxTokens   *int      `json:"max_tokens,omitempty"`
	Stop        any       `json:"stop,omitempty"`
	User        string    `json:"user,omitempty"`
}

type Response struct {
	Message          Message
	PromptTokens     int
	CompletionTokens int
}

type StreamEvent struct {
	Delta    string
	Response *Response
	Done     bool
	Err      error
}
