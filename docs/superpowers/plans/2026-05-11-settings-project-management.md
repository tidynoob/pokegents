# Settings Project Management UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add project CRUD (create, edit, delete) to the dashboard Settings → Configs tab so users can manage projects from the UI instead of editing JSON by hand.

**Architecture:** Backend adds `Save` and `Delete` methods to `FileProjectStore` and two new API routes. Frontend adds a "Projects" section to `SettingsPanel.tsx` with a project list and an inline add/edit form. The `ProjectInfo` type in `api.ts` is extended with `cwd` and `context_prompt` fields so the form can display and save them.

**Tech Stack:** Go (net/http server), React + TypeScript (Vite frontend)

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `dashboard/server/store/store.go` | Modify (interface) | Add `Save` and `Delete` to `ProjectStore` interface |
| `dashboard/server/store/filestore.go` | Modify (implementation) | Add `Save` and `Delete` methods to `FileProjectStore` |
| `dashboard/server/server.go` | Modify (routes + handlers) | Register `POST /api/projects` and `DELETE /api/projects/{name}`, add handler functions |
| `dashboard/web/src/api.ts` | Modify | Extend `ProjectInfo` with `cwd`/`context_prompt`, add `saveProject()` and `deleteProject()` functions |
| `dashboard/web/src/components/settings/SettingsPanel.tsx` | Modify | Add Projects section with list, inline form, and CRUD actions |

---

### Task 1: Add Save/Delete to ProjectStore interface and FileProjectStore

**Files:**
- Modify: `dashboard/server/store/store.go:41-46`
- Modify: `dashboard/server/store/filestore.go:711-754`

- [ ] **Step 1: Add Save and Delete to the ProjectStore interface**

In `dashboard/server/store/store.go`, add two methods to the `ProjectStore` interface:

```go
// ProjectStore manages project configuration files (~/.pokegents/projects/*.json).
type ProjectStore interface {
	// Get returns a project by name.
	Get(name string) (*ProjectConfig, error)
	// List returns all projects.
	List() ([]ProjectConfig, error)
	// Save creates or updates a project config file.
	Save(name string, config ProjectConfig) error
	// Delete removes a project config file.
	Delete(name string) error
}
```

- [ ] **Step 2: Implement Save on FileProjectStore**

In `dashboard/server/store/filestore.go`, add after the `List()` method (after line 754):

```go
func (s *FileProjectStore) Save(name string, config ProjectConfig) error {
	if name == "" {
		return fmt.Errorf("project name is required")
	}
	if strings.ContainsAny(name, `/\`) {
		return fmt.Errorf("project name must not contain path separators")
	}
	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return err
	}
	config.Name = ""
	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	return atomicWrite(filepath.Join(s.dir, name+".json"), data, 0o644)
}
```

Note: `config.Name = ""` prevents the `name` field from being written to JSON — `Name` is derived from the filename on read, not stored in the file.

- [ ] **Step 3: Implement Delete on FileProjectStore**

In `dashboard/server/store/filestore.go`, add after `Save`:

```go
func (s *FileProjectStore) Delete(name string) error {
	if name == "" {
		return fmt.Errorf("project name is required")
	}
	path := filepath.Join(s.dir, name+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}
```

- [ ] **Step 4: Verify it compiles**

Run from `dashboard/server/`:
```bash
cd dashboard && go build ./server/...
```
Expected: compiles with no errors.

- [ ] **Step 5: Commit**

```bash
git add dashboard/server/store/store.go dashboard/server/store/filestore.go
git commit -m "feat: add Save/Delete to ProjectStore for project CRUD"
```

---

### Task 2: Add API routes for project save and delete

**Files:**
- Modify: `dashboard/server/server.go` (route registration + handler functions)

- [ ] **Step 1: Register routes**

In `dashboard/server/server.go`, add these two lines after the existing `GET /api/projects` route (find `s.mux.HandleFunc("GET /api/projects"` and add after it):

```go
s.mux.HandleFunc("POST /api/projects", s.handleSaveProject)
s.mux.HandleFunc("DELETE /api/projects/{name}", s.handleDeleteProject)
```

- [ ] **Step 2: Add handleSaveProject handler**

Add a new handler function in `server.go`, near the existing `handleGetProjects`:

```go
func (s *Server) handleSaveProject(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name          string `json:"name"`
		Title         string `json:"title"`
		CWD           string `json:"cwd"`
		Color         [3]int `json:"color"`
		ContextPrompt string `json:"context_prompt"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(body.Name) == "" {
		http.Error(w, "name is required", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(body.CWD) == "" {
		http.Error(w, "cwd is required", http.StatusBadRequest)
		return
	}
	config := store.ProjectConfig{
		Title:         strings.TrimSpace(body.Title),
		Color:         body.Color,
		CWD:           body.CWD,
		ContextPrompt: body.ContextPrompt,
	}
	if err := s.fileStore.Projects.Save(strings.TrimSpace(body.Name), config); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}
```

- [ ] **Step 3: Add handleDeleteProject handler**

```go
func (s *Server) handleDeleteProject(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimSpace(r.PathValue("name"))
	if name == "" {
		http.Error(w, "name is required", http.StatusBadRequest)
		return
	}
	if err := s.fileStore.Projects.Delete(name); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}
```

- [ ] **Step 4: Verify it compiles**

```bash
cd dashboard && go build ./server/...
```
Expected: compiles with no errors.

- [ ] **Step 5: Commit**

```bash
git add dashboard/server/server.go
git commit -m "feat: add POST/DELETE /api/projects routes for project CRUD"
```

---

### Task 3: Extend frontend API with project CRUD functions

**Files:**
- Modify: `dashboard/web/src/api.ts`

- [ ] **Step 1: Extend ProjectInfo interface**

In `dashboard/web/src/api.ts`, add `cwd` and `context_prompt` to the `ProjectInfo` interface:

```ts
export interface ProjectInfo {
  name: string
  title: string
  color: [number, number, number]
  cwd?: string
  context_prompt?: string
  model?: string
  effort?: string
}
```

- [ ] **Step 2: Add saveProject function**

Add after the existing `fetchProjectList` function:

```ts
export async function saveProject(project: { name: string; title: string; cwd: string; color: [number, number, number]; context_prompt?: string }): Promise<void> {
  const res = await fetch(`${BASE}/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(project),
  })
  if (!res.ok) throw new Error(await res.text())
}
```

- [ ] **Step 3: Add deleteProject function**

Add after `saveProject`:

```ts
export async function deleteProject(name: string): Promise<void> {
  const res = await fetch(`${BASE}/projects/${encodeURIComponent(name)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await res.text())
}
```

- [ ] **Step 4: Commit**

```bash
git add dashboard/web/src/api.ts
git commit -m "feat: add saveProject/deleteProject API functions and extend ProjectInfo"
```

---

### Task 4: Add Projects section to SettingsPanel

**Files:**
- Modify: `dashboard/web/src/components/settings/SettingsPanel.tsx`

- [ ] **Step 1: Add imports and props**

At the top of `SettingsPanel.tsx`, add the API imports:

```ts
import { fetchProjectList, saveProject, deleteProject, ProjectInfo } from '../../api'
```

- [ ] **Step 2: Add the color palette constant**

Add above the `SettingsPanel` component function:

```ts
const PROJECT_COLORS: [number, number, number][] = [
  [74, 144, 217],
  [80, 185, 120],
  [217, 130, 74],
  [185, 80, 180],
  [217, 74, 74],
  [74, 195, 195],
  [195, 175, 74],
  [130, 100, 200],
]

function pickColor(existing: ProjectInfo[]): [number, number, number] {
  const used = new Set(existing.map(p => p.color.join(',')))
  for (const c of PROJECT_COLORS) {
    if (!used.has(c.join(','))) return c
  }
  return PROJECT_COLORS[existing.length % PROJECT_COLORS.length]
}

function deriveNameFromPath(cwd: string): string {
  const seg = cwd.replace(/\/+$/, '').split('/').pop() || ''
  return seg.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function deriveTitleFromPath(cwd: string): string {
  const seg = cwd.replace(/\/+$/, '').split('/').pop() || ''
  return seg.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}
```

- [ ] **Step 3: Add state for project management**

Inside the `SettingsPanel` component function, add state variables:

```ts
const [projects, setProjects] = useState<ProjectInfo[]>([])
const [editingProject, setEditingProject] = useState<string | null>(null)
const [formCwd, setFormCwd] = useState('')
const [formTitle, setFormTitle] = useState('')
const [formContextPrompt, setFormContextPrompt] = useState('')
const [formDerivedName, setFormDerivedName] = useState('')

useEffect(() => {
  fetchProjectList().then(setProjects).catch(() => {})
}, [])

function startCreate() {
  setEditingProject('__new__')
  setFormCwd('')
  setFormTitle('')
  setFormContextPrompt('')
  setFormDerivedName('')
}

function startEdit(p: ProjectInfo) {
  setEditingProject(p.name)
  setFormCwd(p.cwd || '')
  setFormTitle(p.title)
  setFormContextPrompt(p.context_prompt || '')
  setFormDerivedName(p.name)
}

function cancelEdit() {
  setEditingProject(null)
}

function handleCwdBlur() {
  if (formCwd && !formDerivedName) {
    setFormDerivedName(deriveNameFromPath(formCwd))
  }
  if (formCwd && !formTitle) {
    setFormTitle(deriveTitleFromPath(formCwd))
  }
}

async function handleSave() {
  const name = editingProject === '__new__' ? (formDerivedName || deriveNameFromPath(formCwd)) : editingProject!
  const color = editingProject === '__new__'
    ? pickColor(projects)
    : (projects.find(p => p.name === editingProject)?.color ?? pickColor(projects))
  try {
    await saveProject({
      name,
      title: formTitle || deriveTitleFromPath(formCwd),
      cwd: formCwd,
      color,
      context_prompt: formContextPrompt || undefined,
    })
    const updated = await fetchProjectList()
    setProjects(updated)
    setEditingProject(null)
  } catch (e) {
    alert(String(e))
  }
}

async function handleDelete(name: string) {
  if (!confirm(`Delete project "${name}"? This removes the config file.`)) return
  try {
    await deleteProject(name)
    const updated = await fetchProjectList()
    setProjects(updated)
  } catch (e) {
    alert(String(e))
  }
}
```

- [ ] **Step 4: Add the Projects section to the Configs tab**

In the `{tab === 'agents' && (...)}` block, add the Projects section **before** the existing "Open defaults" section. The full replacement of the `agents` tab block:

```tsx
{tab === 'agents' && (
  <>
    <Section title="Projects">
      <div className="space-y-2">
        {projects.map(p => (
          <div key={p.name} className="flex items-center gap-3 rounded theme-bg-panel-subtle border theme-border-subtle p-2">
            <span
              className="w-3 h-3 rounded-full shrink-0"
              style={{ backgroundColor: `rgb(${p.color[0]},${p.color[1]},${p.color[2]})` }}
            />
            <div className="min-w-0 flex-1">
              <span className="text-l theme-font-mono theme-text-primary">{p.title}</span>
              {p.cwd && <span className="ml-2 text-s theme-font-mono theme-text-faint truncate">{p.cwd}</span>}
            </div>
            <button onClick={() => startEdit(p)} className="text-s theme-font-display uppercase pixel-shadow px-2 py-1 rounded theme-bg-panel-muted theme-text-muted theme-bg-panel-hover">EDIT</button>
            <button onClick={() => handleDelete(p.name)} className="text-s theme-font-display uppercase pixel-shadow px-2 py-1 rounded theme-bg-panel-muted text-accent-red/70 hover:bg-accent-red/10">DELETE</button>
          </div>
        ))}
      </div>
      {editingProject ? (
        <div className="rounded border theme-border-subtle theme-bg-panel-muted p-3 space-y-3">
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4 items-start">
            <div className="min-w-0">
              <label className="block text-l theme-font-mono theme-text-secondary leading-snug">Directory</label>
              <p className="mt-1 text-m leading-relaxed theme-font-mono theme-text-faint">Absolute path to your project</p>
            </div>
            <div className="min-w-0 flex items-center justify-start">
              <input
                type="text"
                value={formCwd}
                placeholder="/path/to/project"
                onBlur={handleCwdBlur}
                onChange={e => setFormCwd(e.target.value)}
                className="w-full max-w-[390px] rounded border theme-border-subtle theme-bg-panel-muted theme-text-primary theme-font-mono text-l px-3 py-2 outline-none focus:border-accent-blue"
              />
            </div>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4 items-start">
            <div className="min-w-0">
              <label className="block text-l theme-font-mono theme-text-secondary leading-snug">Title</label>
              <p className="mt-1 text-m leading-relaxed theme-font-mono theme-text-faint">Display name in dashboard</p>
            </div>
            <div className="min-w-0 flex items-center justify-start">
              <input
                type="text"
                value={formTitle}
                placeholder="My Project"
                onChange={e => setFormTitle(e.target.value)}
                className="w-full max-w-[390px] rounded border theme-border-subtle theme-bg-panel-muted theme-text-primary theme-font-mono text-l px-3 py-2 outline-none focus:border-accent-blue"
              />
            </div>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4 items-start">
            <div className="min-w-0">
              <label className="block text-l theme-font-mono theme-text-secondary leading-snug">Context prompt</label>
              <p className="mt-1 text-m leading-relaxed theme-font-mono theme-text-faint">Instructions injected into agent system prompt</p>
            </div>
            <div className="min-w-0 flex items-center justify-start">
              <textarea
                value={formContextPrompt}
                placeholder="e.g. This project uses React + TypeScript..."
                onChange={e => setFormContextPrompt(e.target.value)}
                rows={3}
                className="w-full max-w-[390px] rounded border theme-border-subtle theme-bg-panel-muted theme-text-primary theme-font-mono text-l px-3 py-2 outline-none focus:border-accent-blue resize-y"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={handleSave} disabled={!formCwd.trim()} className="inline-flex gba-button text-s theme-font-display uppercase pixel-shadow px-3 py-2 transition-colors disabled:opacity-40">SAVE</button>
            <button onClick={cancelEdit} className="text-s theme-font-display uppercase pixel-shadow px-3 py-2 rounded theme-bg-panel-subtle theme-text-muted theme-bg-panel-hover">CANCEL</button>
          </div>
        </div>
      ) : (
        <button onClick={startCreate} className="inline-flex gba-button text-s theme-font-display uppercase pixel-shadow px-3 py-2 transition-colors">ADD PROJECT</button>
      )}
    </Section>
    {/* ...existing sections follow (Open defaults, Config files, Setup)... */}
```

Keep all existing sections (`Open defaults`, `Config files`, `Setup`) below the new Projects section — do not remove them.

- [ ] **Step 5: Verify frontend builds**

```bash
cd dashboard/web && npx tsc --noEmit
```
Expected: no type errors.

- [ ] **Step 6: Commit**

```bash
git add dashboard/web/src/components/settings/SettingsPanel.tsx
git commit -m "feat: add Projects section to Settings Configs tab with CRUD"
```

---

### Task 5: Wire up project list refresh and verify end-to-end

**Files:**
- Modify: `dashboard/server/server.go` (check `handleGetProjects` returns `cwd` and `context_prompt`)

- [ ] **Step 1: Verify handleGetProjects returns full project data**

Read `handleGetProjects` — it calls `s.fileStore.Projects.List()` which returns `[]ProjectConfig`. `ProjectConfig` already has `CWD` and `ContextPrompt` fields with JSON tags `"cwd"` and `"context_prompt"`. No changes needed if those fields serialize correctly.

Verify by checking `core/types.go` — `ProjectConfig.CWD` has `json:"cwd"` and `ProjectConfig.ContextPrompt` has `json:"context_prompt,omitempty"`. The existing endpoint already returns these fields — the frontend `ProjectInfo` interface just wasn't declaring them before Task 3.

- [ ] **Step 2: Build and run the full stack**

```bash
cd dashboard && go build ./server/...
cd dashboard/web && npm run build
```
Expected: both compile successfully.

- [ ] **Step 3: Manual test**

1. Open the dashboard in a browser
2. Click SETTINGS → Configs tab
3. Verify the "Projects" section appears at the top
4. Click ADD PROJECT
5. Enter a directory path (e.g. `/tmp/test-project`), verify title auto-fills on blur
6. Click SAVE — project appears in the list with a color swatch
7. Click EDIT on the project — form pre-fills with existing values
8. Change the title, click SAVE — list updates
9. Click DELETE — confirm dialog, project disappears
10. Verify `~/.pokegents/projects/` has the JSON file after save, and it's gone after delete

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: settings project management — end-to-end CRUD"
```
