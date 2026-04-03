package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

const (
	chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
	targetURL  = "https://chat.qwen.ai/auth"
)

func main() {
	profileDir, err := os.MkdirTemp("", "web-model-qwen-e2e-")
	if err != nil {
		panic(err)
	}

	fmt.Printf("profile_dir=%s\n", profileDir)

	args := []string{
		"--user-data-dir=" + filepath.Clean(profileDir),
		"--no-first-run",
		"--no-default-browser-check",
		targetURL,
	}

	cmd := exec.Command(chromePath, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		panic(err)
	}

	fmt.Printf("pid=%d\n", cmd.Process.Pid)
}
