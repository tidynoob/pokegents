# Settings Project Management UI

Add project CRUD to the dashboard Settings panel so users can create, edit, and delete projects without touching JSON files or the CLI.

## Location

New "Projects" `Section` at the top of the Settings → Configs tab, above the existing "Config files" section.

## Project List

Each project from `GET /api/projects` renders as a row:
- **Color swatch** — small circle in the project's `[R, G, B]` color
- **Title** — project display name
- **Path** — `cwd` value, muted text
- **EDIT** button — expands the inline form pre-filled with existing values
- **DELETE** button — `confirm()` dialog, then `DELETE /api/projects/{name}`

## Add/Edit Form

An inline form that expands in-place below the project list (not a separate modal). Shared for both create and edit flows.

### Fields

| Field | Type | Required | Behavior |
|-------|------|----------|----------|
| Directory (`cwd`) | text input | yes | On blur, auto-derives `name` (kebab-case last path segment) and `title` (title-cased last segment) if they are empty |
| Title | text input | no | Pre-filled from directory, editable |
| Context prompt | textarea | no | Project-specific instructions injected into agent system prompt at launch |

### Color

Auto-assigned from a preset palette. On create, pick the first palette color not already used by an existing project. On edit, keep the current color. Not exposed as a form field.

### Buttons

- **SAVE** — calls `POST /api/projects` with `{name, title, cwd, color, context_prompt}`, collapses the form, refreshes the list
- **CANCEL** — collapses the form, discards changes

## Backend

### FileProjectStore additions (`dashboard/server/store/filestore.go`)

```go
func (s *FileProjectStore) Save(name string, config ProjectConfig) error
```
Marshals config to JSON and writes to `{dir}/{name}.json` using existing `atomicWrite`.

```go
func (s *FileProjectStore) Delete(name string) error
```
Removes `{dir}/{name}.json`.

### API routes (`dashboard/server/server.go`)

| Method | Path | Handler | Body |
|--------|------|---------|------|
| `POST` | `/api/projects` | `handleSaveProject` | `{name, title, cwd, color, context_prompt}` |
| `DELETE` | `/api/projects/{name}` | `handleDeleteProject` | — |

### Frontend API (`dashboard/web/src/api.ts`)

```ts
export function saveProject(project: { name: string; title: string; cwd: string; color: number[]; context_prompt?: string }): Promise<void>
export function deleteProject(name: string): Promise<void>
```

## UI Components

All in `SettingsPanel.tsx`, using existing component patterns (`Section`, `SettingRow`, `TextSetting`, `gba-button`).

### State

- `projects: ProjectInfo[]` — fetched on mount, refreshed after save/delete
- `editingProject: string | null` — name of project being edited, or `'__new__'` for create mode
- `formState: { cwd, title, contextPrompt }` — controlled form fields

### Preset Color Palette

```ts
const PROJECT_COLORS: [number, number, number][] = [
  [74, 144, 217],   // blue
  [80, 185, 120],   // green
  [217, 130, 74],   // orange
  [185, 80, 180],   // purple
  [217, 74, 74],    // red
  [74, 195, 195],   // teal
  [195, 175, 74],   // gold
  [130, 100, 200],  // violet
]
```

Pick the first color not matching any existing project's color (by index cycling).

## Scope

- No role management in this change (future work)
- No `add_dirs`, `iterm2_profile`, or `model` fields in the form — power users edit JSON directly for those
- The existing "OPEN BACKENDS.JSON" and other config-file buttons remain unchanged
