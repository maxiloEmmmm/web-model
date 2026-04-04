package tui

import (
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"web-model/internal/agent"
)

const agentRefreshInterval = time.Second

type agentTickMsg time.Time

type AgentTeaModel struct {
	manager            *agent.Manager
	apiAddr            string
	wsAddr             string
	maxChatsPerSession int
	items              []agent.Snapshot
	width              int
	height             int
	lastUpdated        time.Time
}

func NewAgentTeaModel(manager *agent.Manager, apiAddr, wsAddr string, maxChatsPerSession int) AgentTeaModel {
	model := AgentTeaModel{
		manager:            manager,
		apiAddr:            apiAddr,
		wsAddr:             wsAddr,
		maxChatsPerSession: maxChatsPerSession,
	}
	model.refresh()
	return model
}

func (m AgentTeaModel) Init() tea.Cmd {
	return agentTickCmd()
}

func (m AgentTeaModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil
	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c", "q":
			return m, tea.Quit
		case "r":
			m.refresh()
			return m, nil
		}
	case agentTickMsg:
		m.refresh()
		return m, agentTickCmd()
	}
	return m, nil
}

func (m AgentTeaModel) View() string {
	lines := []string{
		"web-model monitor",
		fmt.Sprintf("api: %s    ws: %s", m.apiAddr, m.wsAddr),
		fmt.Sprintf("registered: %d    updated: %s    max-chats-per-session: %d", len(m.items), m.lastUpdated.Format("15:04:05"), m.maxChatsPerSession),
		"",
		renderAgentTable(m.items),
		"",
		"keys: r refresh, q quit",
	}

	return strings.Join(lines, "\n")
}

func agentTickCmd() tea.Cmd {
	return tea.Tick(agentRefreshInterval, func(t time.Time) tea.Msg {
		return agentTickMsg(t)
	})
}

func (m *AgentTeaModel) refresh() {
	m.items = m.manager.Snapshots()
	m.lastUpdated = time.Now()
}

func renderAgentTable(items []agent.Snapshot) string {
	headers := []string{"Key", "Type", "Busy", "Used", "Remaining", "Penalty"}
	rows := make([][]string, 0, len(items)+1)
	rows = append(rows, headers)

	for _, item := range items {
		rows = append(rows, []string{
			item.Meta.Key,
			item.Meta.Type,
			busyLabel(item.Busy),
			fmt.Sprintf("%d", item.ChatCount),
			fmt.Sprintf("%d", item.RemainingChats),
			penaltyLabel(item.PenaltyUntil),
		})
	}

	widths := make([]int, len(headers))
	for _, row := range rows {
		for i, value := range row {
			if len(value) > widths[i] {
				widths[i] = len(value)
			}
		}
	}

	lines := make([]string, 0, len(rows)+1)
	for rowIndex, row := range rows {
		parts := make([]string, 0, len(row))
		for i, value := range row {
			parts = append(parts, padRight(value, widths[i]))
		}
		lines = append(lines, strings.Join(parts, "  "))
		if rowIndex == 0 {
			underlines := make([]string, 0, len(widths))
			for _, width := range widths {
				underlines = append(underlines, strings.Repeat("-", width))
			}
			lines = append(lines, strings.Join(underlines, "  "))
		}
	}

	if len(items) == 0 {
		lines = append(lines, "(no providers connected)")
	}

	return strings.Join(lines, "\n")
}

func busyLabel(busy bool) string {
	if busy {
		return "yes"
	}
	return "no"
}

func penaltyLabel(until time.Time) string {
	if until.IsZero() {
		return "-"
	}
	remaining := time.Until(until)
	if remaining <= 0 {
		return "-"
	}
	return humanDuration(remaining)
}

func humanDuration(value time.Duration) string {
	if value < time.Minute {
		seconds := int(value.Round(time.Second) / time.Second)
		if seconds < 1 {
			seconds = 1
		}
		return fmt.Sprintf("%ds", seconds)
	}
	if value < time.Hour {
		minutes := int(value.Round(time.Minute) / time.Minute)
		if minutes < 1 {
			minutes = 1
		}
		return fmt.Sprintf("%dm", minutes)
	}
	hours := int(value / time.Hour)
	minutes := int((value % time.Hour).Round(time.Minute) / time.Minute)
	if minutes == 60 {
		hours += 1
		minutes = 0
	}
	if minutes <= 0 {
		return fmt.Sprintf("%dh", hours)
	}
	return fmt.Sprintf("%dh%dm", hours, minutes)
}

func padRight(value string, width int) string {
	if len(value) >= width {
		return value
	}
	return value + strings.Repeat(" ", width-len(value))
}
