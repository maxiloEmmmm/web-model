package browser

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/chromedp/chromedp"
)

type ChromiumLauncher struct {
	cfg Config
}

func NewChromiumLauncher(cfg Config) *ChromiumLauncher {
	return &ChromiumLauncher{cfg: cfg.withDefaults()}
}

func (l *ChromiumLauncher) Launch(parent context.Context, spec SessionSpec) (Handle, error) {
	profileDir, err := l.resolveProfileDir(spec)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(profileDir, 0o755); err != nil {
		return nil, fmt.Errorf("create profile dir: %w", err)
	}

	options := []chromedp.ExecAllocatorOption{
		chromedp.NoFirstRun,
		chromedp.NoDefaultBrowserCheck,
		chromedp.UserDataDir(profileDir),
		chromedp.Flag("headless", l.cfg.Headless),
		chromedp.Flag("disable-gpu", true),
		chromedp.Flag("hide-scrollbars", true),
		chromedp.Flag("mute-audio", true),
	}
	if l.cfg.ExecutablePath != "" {
		options = append(options, chromedp.ExecPath(l.cfg.ExecutablePath))
	}

	allocCtx, allocCancel := chromedp.NewExecAllocator(parent, options...)
	browserCtx, browserCancel := chromedp.NewContext(allocCtx)

	return &chromiumHandle{
		ctx:           browserCtx,
		allocCancel:   allocCancel,
		browserCancel: browserCancel,
		startURL:      spec.StartURL,
		timeout:       l.cfg.startupTimeout(),
	}, nil
}

func (l *ChromiumLauncher) resolveProfileDir(spec SessionSpec) (string, error) {
	if spec.ProfileDir != "" {
		return filepath.Clean(spec.ProfileDir), nil
	}
	root := l.cfg.resolvedProfilesDir()
	if root == "" {
		return "", fmt.Errorf("profiles dir is empty")
	}
	return filepath.Join(root, spec.Key), nil
}

type chromiumHandle struct {
	ctx           context.Context
	allocCancel   context.CancelFunc
	browserCancel context.CancelFunc
	startURL      string
	timeout       time.Duration

	mu    sync.Mutex
	ready bool
}

func (h *chromiumHandle) EnsureReady(ctx context.Context) error {
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.ready {
		return nil
	}

	runCtx, cancel := context.WithTimeout(h.ctx, h.timeout)
	defer cancel()

	var tasks chromedp.Tasks
	if h.startURL != "" {
		tasks = chromedp.Tasks{
			chromedp.Navigate(h.startURL),
			chromedp.WaitReady("body", chromedp.ByQuery),
		}
	} else {
		tasks = chromedp.Tasks{
			chromedp.Navigate("about:blank"),
		}
	}

	if err := chromedp.Run(runCtx, tasks); err != nil {
		return err
	}

	h.ready = true
	return nil
}

func (h *chromiumHandle) Close(context.Context) error {
	h.mu.Lock()
	defer h.mu.Unlock()

	h.ready = false
	h.browserCancel()
	h.allocCancel()
	return nil
}

func (h *chromiumHandle) Context() context.Context {
	return h.ctx
}
