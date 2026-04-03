package qwen

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/chromedp/chromedp"

	"web-model/internal/browser"
	"web-model/internal/chat"
	"web-model/internal/provider"
)

const (
	Type                  = "qwen"
	DefaultHomeURL        = "https://chat.qwen.ai/"
	DefaultSetupURL       = "https://chat.qwen.ai/auth"
	defaultChromeExecPath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
)

type Config struct {
	Key              string   `json:"key"`
	Account          string   `json:"account,omitempty"`
	Role             string   `json:"role,omitempty"`
	DisplayName      string   `json:"display_name,omitempty"`
	Description      string   `json:"description,omitempty"`
	Homepage         string   `json:"homepage,omitempty"`
	ProfileDir       string   `json:"profile_dir,omitempty"`
	HomeURL          string   `json:"home_url,omitempty"`
	SetupURL         string   `json:"setup_url,omitempty"`
	ChromeExecutable string   `json:"chrome_executable,omitempty"`
	Tags             []string `json:"tags,omitempty"`
}

type Provider struct {
	meta         provider.Meta
	sessions     *browser.Manager
	spec         browser.SessionSpec
	homeURL      string
	setupURL     string
	chromeBinary string

	manualMu  sync.Mutex
	manualCmd *exec.Cmd
}

func New(cfg Config, sessions *browser.Manager) (*Provider, error) {
	if sessions == nil {
		return nil, fmt.Errorf("browser manager is nil")
	}
	if cfg.Key == "" {
		return nil, fmt.Errorf("qwen provider key is required")
	}

	homeURL := cfg.HomeURL
	if homeURL == "" {
		homeURL = DefaultHomeURL
	}
	setupURL := cfg.SetupURL
	if setupURL == "" {
		setupURL = DefaultSetupURL
	}
	chromeBinary := cfg.ChromeExecutable
	if chromeBinary == "" {
		chromeBinary = defaultChromeExecPath
	}

	displayName := cfg.DisplayName
	if displayName == "" {
		displayName = "Qwen"
	}

	description := cfg.Description
	if description == "" {
		description = "Qwen web chat provider."
	}

	homepage := cfg.Homepage
	if homepage == "" {
		homepage = homeURL
	}

	return &Provider{
		meta: provider.Meta{
			Key:         cfg.Key,
			Type:        Type,
			Account:     cfg.Account,
			Role:        cfg.Role,
			DisplayName: displayName,
			Description: description,
			Homepage:    homepage,
			Tags:        append([]string(nil), cfg.Tags...),
		},
		sessions: sessions,
		spec: browser.SessionSpec{
			Key:        cfg.Key,
			Type:       Type,
			StartURL:   homeURL,
			ProfileDir: cfg.ProfileDir,
			Account:    cfg.Account,
			Role:       cfg.Role,
			Metadata: map[string]string{
				"provider": Type,
			},
		},
		homeURL:      homeURL,
		setupURL:     setupURL,
		chromeBinary: chromeBinary,
	}, nil
}

func (p *Provider) Name() string {
	return Type
}

func (p *Provider) Meta() provider.Meta {
	return p.meta
}

func (p *Provider) Chat(ctx context.Context, _ chat.Request) (chat.Response, error) {
	session, err := p.sessions.Get(ctx, p.spec)
	if err != nil {
		return chat.Response{}, err
	}

	err = session.Do(ctx, func(context.Context, browser.Handle) error {
		return fmt.Errorf("qwen provider chat flow is not implemented yet")
	})
	if err != nil {
		return chat.Response{}, err
	}

	return chat.Response{}, fmt.Errorf("qwen provider chat flow is not implemented yet")
}

func (p *Provider) OpenSetup(context.Context) error {
	p.manualMu.Lock()
	defer p.manualMu.Unlock()

	if p.manualCmd != nil && p.manualCmd.Process != nil && p.manualCmd.ProcessState == nil {
		return fmt.Errorf("setup window is already open")
	}

	args := []string{
		"--user-data-dir=" + p.spec.ProfileDir,
		"--no-first-run",
		"--no-default-browser-check",
		p.setupURL,
	}

	cmd := exec.Command(p.chromeBinary, args...)
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("open qwen setup window: %w", err)
	}

	p.manualCmd = cmd
	go func() {
		_ = cmd.Wait()
		p.manualMu.Lock()
		if p.manualCmd == cmd {
			p.manualCmd = nil
		}
		p.manualMu.Unlock()
	}()

	return nil
}

func (p *Provider) Cleanup(ctx context.Context) error {
	_ = p.CloseSetup(ctx)

	err := p.sessions.Remove(ctx, p.spec.Key)
	if p.spec.ProfileDir != "" {
		_ = os.RemoveAll(p.spec.ProfileDir)
	}
	return err
}

func (p *Provider) CloseSetup(context.Context) error {
	p.manualMu.Lock()
	cmd := p.manualCmd
	p.manualCmd = nil
	p.manualMu.Unlock()

	if cmd != nil && cmd.Process != nil && cmd.ProcessState == nil {
		_ = cmd.Process.Kill()
	}
	return nil
}

func (p *Provider) Inspect(ctx context.Context) (provider.Inspection, error) {
	session, err := p.sessions.Get(ctx, p.spec)
	if err != nil {
		return provider.Inspection{}, err
	}

	var inspection provider.Inspection
	err = session.Do(ctx, func(_ context.Context, handle browser.Handle) error {
		runCtx, cancel := context.WithTimeout(handle.Context(), 20*time.Second)
		defer cancel()

		var raw struct {
			URL     string `json:"url"`
			Title   string `json:"title"`
			Text    string `json:"text"`
			Inputs  []struct {
				Tag         string `json:"tag"`
				Type        string `json:"type"`
				Placeholder string `json:"placeholder"`
				AriaLabel   string `json:"ariaLabel"`
				Role        string `json:"role"`
			} `json:"inputs"`
			Actions []struct {
				Tag       string `json:"tag"`
				Text      string `json:"text"`
				AriaLabel string `json:"ariaLabel"`
			} `json:"actions"`
		}

		script := `(function () {
			function textOf(node) {
				return ((node.innerText || node.textContent || "") + "").replace(/\s+/g, " ").trim();
			}

			const inputs = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"], [role="textbox"]'))
				.map((node) => ({
					tag: node.tagName.toLowerCase(),
					type: node.getAttribute('type') || '',
					placeholder: node.getAttribute('placeholder') || '',
					ariaLabel: node.getAttribute('aria-label') || '',
					role: node.getAttribute('role') || ''
				}))
				.slice(0, 30);

			const actions = Array.from(document.querySelectorAll('button, a, [role="button"], div[role="button"]'))
				.map((node) => ({
					tag: node.tagName.toLowerCase(),
					text: textOf(node),
					ariaLabel: node.getAttribute('aria-label') || ''
				}))
				.filter((item) => item.text || item.ariaLabel)
				.slice(0, 60);

			return {
				url: location.href,
				title: document.title,
				text: (document.body && document.body.innerText) || '',
				inputs,
				actions
			};
		})()`

		if err := chromedp.Run(runCtx,
			chromedp.Navigate(p.homeURL),
			chromedp.WaitReady("body", chromedp.ByQuery),
			chromedp.Evaluate(script, &raw),
		); err != nil {
			return err
		}

		inspection = provider.Inspection{
			URL:        raw.URL,
			Title:      raw.Title,
			TextSample: trimText(raw.Text, 2400),
		}
		for _, item := range raw.Inputs {
			inspection.Inputs = append(inspection.Inputs, provider.InspectionInput{
				Tag:         item.Tag,
				Type:        item.Type,
				Placeholder: item.Placeholder,
				AriaLabel:   item.AriaLabel,
				Role:        item.Role,
			})
		}
		for _, item := range raw.Actions {
			inspection.Actions = append(inspection.Actions, provider.InspectionAction{
				Tag:       item.Tag,
				Text:      item.Text,
				AriaLabel: item.AriaLabel,
			})
		}
		return nil
	})
	if err != nil {
		return provider.Inspection{}, err
	}

	return inspection, nil
}

func trimText(text string, limit int) string {
	text = strings.TrimSpace(text)
	if limit <= 0 || len(text) <= limit {
		return text
	}
	return text[:limit]
}
