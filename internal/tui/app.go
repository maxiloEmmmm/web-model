package tui

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gdamore/tcell/v2"
	"github.com/rivo/tview"

	"web-model/internal/runtime"
)

type App struct {
	manager *runtime.Manager
	server  *http.Server
	apiAddr string

	ui      *tview.Application
	root    tview.Primitive
	table   *tview.Table
	details *tview.TextView
	logs    *tview.TextView

	mu          sync.Mutex
	selectedKey string
}

func New(manager *runtime.Manager, server *http.Server, apiAddr string) *App {
	app := &App{
		manager: manager,
		server:  server,
		apiAddr: apiAddr,
		ui:      tview.NewApplication(),
		table:   tview.NewTable().SetSelectable(true, false),
		details: tview.NewTextView().SetDynamicColors(true).SetWrap(true),
		logs:    tview.NewTextView().SetDynamicColors(true).SetWrap(true),
	}

	app.table.SetBorder(true).SetTitle(" Providers ")
	app.details.SetBorder(true).SetTitle(" Details ")
	app.logs.SetBorder(true).SetTitle(" Logs ")

	app.table.SetSelectedFunc(func(row, _ int) {
		key := app.keyForRow(row)
		if key == "" {
			return
		}
		app.mu.Lock()
		app.selectedKey = key
		app.mu.Unlock()
		app.refresh()
	})

	buttons := tview.NewFlex().SetDirection(tview.FlexColumn)
	buttons.AddItem(newButton("Add Qwen", app.showAddQwenForm), 0, 1, false)
	buttons.AddItem(newButton("Open Setup", app.openSetupSelected), 0, 1, false)
	buttons.AddItem(newButton("Complete Add", app.completeSelected), 0, 1, false)
	buttons.AddItem(newButton("Inspect", app.inspectSelected), 0, 1, false)
	buttons.AddItem(newButton("Remove", app.removeSelected), 0, 1, false)
	buttons.AddItem(newButton("Quit", app.stop), 0, 1, false)

	right := tview.NewFlex().SetDirection(tview.FlexRow)
	right.AddItem(app.details, 0, 2, false)
	right.AddItem(app.logs, 0, 3, false)

	body := tview.NewFlex().
		AddItem(app.table, 0, 2, true).
		AddItem(right, 0, 3, false)

	header := tview.NewTextView().
		SetDynamicColors(true).
		SetText(fmt.Sprintf("[yellow]web-model[-]  API [green]%s[-]  clean runtime only", apiAddr))
	header.SetBorder(true).SetTitle(" Status ")

	root := tview.NewFlex().SetDirection(tview.FlexRow)
	root.AddItem(header, 3, 0, false)
	root.AddItem(body, 0, 1, true)
	root.AddItem(buttons, 3, 0, false)

	app.root = root
	app.ui.SetRoot(root, true).EnableMouse(true)
	app.ui.SetInputCapture(app.captureKeys)

	go app.autoRefresh()
	app.logf("service ready on %s", apiAddr)
	app.logf("providers start empty; add qwen instances from the TUI")

	return app
}

func (a *App) Run() error {
	a.refresh()
	return a.ui.Run()
}

func (a *App) stop() {
	a.ui.Stop()
}

func (a *App) Shutdown(ctx context.Context) error {
	serverErr := a.server.Shutdown(ctx)
	managerErr := a.manager.Close(ctx)
	if serverErr != nil {
		return serverErr
	}
	return managerErr
}

func (a *App) captureKeys(event *tcell.EventKey) *tcell.EventKey {
	switch event.Rune() {
	case 'a':
		a.showAddQwenForm()
		return nil
	case 'o':
		a.openSetupSelected()
		return nil
	case 'r':
		a.removeSelected()
		return nil
	case 'p':
		a.inspectSelected()
		return nil
	case 'q':
		a.stop()
		return nil
	}
	if event.Key() == tcell.KeyEnter {
		a.completeSelected()
		return nil
	}
	return event
}

func (a *App) refresh() {
	snapshots := a.manager.Snapshots()

	a.table.Clear()
	headers := []string{"Key", "Type", "Status", "Account", "Role"}
	for col, header := range headers {
		cell := tview.NewTableCell(header).
			SetSelectable(false).
			SetAttributes(tcell.AttrBold).
			SetTextColor(tcell.ColorYellow)
		a.table.SetCell(0, col, cell)
	}

	selected := a.currentSelection()
	if selected == "" && len(snapshots) > 0 {
		selected = snapshots[0].Key
		a.mu.Lock()
		a.selectedKey = selected
		a.mu.Unlock()
	}

	selectedRow := 1
	for i, item := range snapshots {
		row := i + 1
		values := []string{item.Key, item.Type, string(item.Status), item.Account, item.Role}
		for col, value := range values {
			a.table.SetCell(row, col, tview.NewTableCell(value))
		}
		if item.Key == selected {
			selectedRow = row
		}
	}
	if len(snapshots) > 0 {
		a.table.Select(selectedRow, 0)
	}

	a.details.SetText(a.renderDetails(snapshots, selected))
}

func (a *App) renderDetails(items []runtime.Snapshot, selected string) string {
	if len(items) == 0 {
		return strings.Join([]string{
			"[yellow]No providers yet[-]",
			"",
			"Use [green]Add Qwen[-] to create a clean in-memory provider instance.",
			"Add opens the provider setup page in a dedicated browser window.",
			"After you finish in the browser, return here and press [green]Enter[-].",
			"",
			"Only [green]ready[-] providers appear in /v1/models.",
		}, "\n")
	}

	for _, item := range items {
		if item.Key != selected {
			continue
		}
		lines := []string{
			fmt.Sprintf("[yellow]Key:[-] %s", item.Key),
			fmt.Sprintf("[yellow]Type:[-] %s", item.Type),
			fmt.Sprintf("[yellow]Status:[-] %s", item.Status),
			fmt.Sprintf("[yellow]Display:[-] %s", item.DisplayName),
			fmt.Sprintf("[yellow]Account:[-] %s", item.Account),
			fmt.Sprintf("[yellow]Role:[-] %s", item.Role),
			fmt.Sprintf("[yellow]Profile Dir:[-] %s", item.ProfileDir),
		}
		if item.Error != "" {
			lines = append(lines, fmt.Sprintf("[red]Last Error:[-] %s", item.Error))
		}
		lines = append(lines, "", "Open Setup launches the provider page in a clean browser window.", "Press Enter here when you want to finish adding it.", "Exit clears everything.")
		return strings.Join(lines, "\n")
	}

	return ""
}

func (a *App) currentSelection() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.selectedKey
}

func (a *App) keyForRow(row int) string {
	if row <= 0 {
		return ""
	}
	cell := a.table.GetCell(row, 0)
	if cell == nil {
		return ""
	}
	return cell.Text
}

func (a *App) showAddQwenForm() {
	form := tview.NewForm()
	var key, displayName, account, role string

	form.AddInputField("Key", "", 32, nil, func(text string) { key = strings.TrimSpace(text) })
	form.AddInputField("Display", "", 32, nil, func(text string) { displayName = strings.TrimSpace(text) })
	form.AddInputField("Account", "", 64, nil, func(text string) { account = strings.TrimSpace(text) })
	form.AddInputField("Role", "", 32, nil, func(text string) { role = strings.TrimSpace(text) })

	form.AddButton("Add", func() {
		err := a.manager.AddQwen(runtime.AddQwenInput{
			Key:         key,
			DisplayName: displayName,
			Account:     account,
			Role:        role,
		})
		if err != nil {
			a.logf("add provider failed: %v", err)
		} else {
			a.mu.Lock()
			a.selectedKey = key
			a.mu.Unlock()
			a.logf("added qwen provider %s", key)
			a.openSetupFor(key)
		}
		a.ui.SetRoot(a.root, true)
		a.refresh()
	})
	form.AddButton("Cancel", func() {
		a.ui.SetRoot(a.root, true)
	})
	form.SetBorder(true).SetTitle(" Add Qwen ").SetTitleAlign(tview.AlignLeft)

	modal := centered(form, 70, 14)
	a.ui.SetRoot(tview.NewPages().
		AddPage("main", a.root, true, true).
		AddPage("modal", modal, true, true), true)
}

func (a *App) openSetupSelected() {
	key := a.currentSelection()
	if key == "" {
		a.logf("no provider selected")
		return
	}
	a.openSetupFor(key)
}

func (a *App) openSetupFor(key string) {
	a.logf("opening setup page for %s", key)
	go func() {
		err := a.manager.OpenSetup(context.Background(), key)
		a.ui.QueueUpdateDraw(func() {
			if err != nil {
				a.logf("open setup %s failed: %v", key, err)
			} else {
				a.logf("complete your browser actions for %s, then return here and press Enter", key)
			}
			a.refresh()
		})
	}()
}

func (a *App) completeSelected() {
	key := a.currentSelection()
	if key == "" {
		a.logf("no provider selected")
		return
	}

	if err := a.manager.CompleteAdd(key); err != nil {
		a.logf("complete add %s failed: %v", key, err)
		return
	}
	a.logf("provider %s marked ready", key)
	a.refresh()
}

func (a *App) inspectSelected() {
	key := a.currentSelection()
	if key == "" {
		a.logf("no provider selected")
		return
	}

	a.logf("inspecting provider %s", key)
	go func() {
		inspection, err := a.manager.Inspect(context.Background(), key)
		a.ui.QueueUpdateDraw(func() {
			if err != nil {
				a.logf("inspect %s failed: %v", key, err)
				return
			}
			raw, marshalErr := json.MarshalIndent(inspection, "", "  ")
			if marshalErr != nil {
				a.logf("inspect %s marshal failed: %v", key, marshalErr)
				return
			}
			a.logf("inspect %s:\n%s", key, string(raw))
		})
	}()
}

func (a *App) removeSelected() {
	key := a.currentSelection()
	if key == "" {
		a.logf("no provider selected")
		return
	}

	if err := a.manager.Remove(context.Background(), key); err != nil {
		a.logf("remove %s failed: %v", key, err)
		return
	}

	a.mu.Lock()
	a.selectedKey = ""
	a.mu.Unlock()

	a.logf("removed provider %s", key)
	a.refresh()
}

func (a *App) logf(format string, args ...any) {
	timestamp := time.Now().Format("15:04:05")
	fmt.Fprintf(a.logs, "[gray]%s[-] %s\n", timestamp, fmt.Sprintf(format, args...))
}

func (a *App) autoRefresh() {
	ticker := time.NewTicker(800 * time.Millisecond)
	defer ticker.Stop()

	for range ticker.C {
		a.ui.QueueUpdateDraw(a.refresh)
	}
}

func centered(p tview.Primitive, width, height int) tview.Primitive {
	return tview.NewFlex().
		AddItem(nil, 0, 1, false).
		AddItem(tview.NewFlex().SetDirection(tview.FlexRow).
			AddItem(nil, 0, 1, false).
			AddItem(p, height, 1, true).
			AddItem(nil, 0, 1, false), width, 1, true).
		AddItem(nil, 0, 1, false)
}

func newButton(label string, fn func()) *tview.Button {
	button := tview.NewButton(label)
	button.SetSelectedFunc(fn)
	return button
}
