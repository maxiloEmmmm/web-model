package browser

import (
	"path/filepath"
	"time"
)

const (
	defaultProfilesDir    = "var/profiles"
	defaultStartupTimeout = 30 * time.Second
)

type Config struct {
	Headless       bool   `json:"headless"`
	ExecutablePath string `json:"executable_path,omitempty"`
	ProfilesDir    string `json:"profiles_dir,omitempty"`
	StartupTimeout string `json:"startup_timeout,omitempty"`
}

func (c Config) withDefaults() Config {
	out := c
	if out.ProfilesDir == "" {
		out.ProfilesDir = defaultProfilesDir
	}
	if out.StartupTimeout == "" {
		out.StartupTimeout = defaultStartupTimeout.String()
	}
	return out
}

func (c Config) resolvedProfilesDir() string {
	cfg := c.withDefaults()
	return filepath.Clean(cfg.ProfilesDir)
}

func (c Config) startupTimeout() time.Duration {
	cfg := c.withDefaults()
	timeout, err := time.ParseDuration(cfg.StartupTimeout)
	if err != nil || timeout <= 0 {
		return defaultStartupTimeout
	}
	return timeout
}
