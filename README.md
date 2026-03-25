# pi-auto-mode-router

Auto Mode Router is a Pi extension that adds a virtual `auto/mode` model and routes each turn to the most appropriate model for **frontend**, **logic**, or **terminal** work.

It can also support **mid-turn** domain changes through a built-in `switch_domain` tool when a task spans both UI/design and implementation/backend work.

## What it does

When Auto Mode is selected, each new prompt goes through this flow:

1. The prompt is analyzed with your chosen **analysis model**
2. The router decides whether the task is primarily:
   - **frontend**
   - **logic**
   - **terminal**
3. Pi switches to the best configured model for that domain
4. If the task is multi-domain, the extension can:
   - detect that it spans multiple domains
   - decompose it into ordered phases
   - inject phase guidance into the system prompt
   - let the model call `switch_domain` to move to the next domain

## Highlights

- Adds a virtual **Auto Mode** model to `/model`
- Commands: `/auto-mode` and `/auto`
- Searchable model picker for analysis/frontend/logic model selection
- Multi-domain task detection and decomposition
- Mid-turn model switching with `switch_domain`
- Terminal-only tasks can stay on the analysis model
- Status indicator such as `auto:armed`, `auto:frontend`, `auto:logic`, `auto:terminal`, `auto:frontend [1/3]`
- Config stored in `~/.pi/agent/auto-mode-router.json`
- Safety limit of 6 mid-turn switches per turn

## Important implementation note

The current implementation does **not** do automatic file-extension or path-based routing during tool calls.

So while the model receives guidance about when to switch domains, actual mid-turn switching happens through:

- initial prompt analysis and routing
- multi-domain phase guidance
- explicit `switch_domain` tool calls by the model

There is a reserved `tool_call` section in the code for future work, but no file-based auto-switching logic is currently implemented there.

## Installation

### Option 1: install from npm as a Pi package

```bash
pi install npm:pi-auto-mode-router
```

Then restart Pi or run:

```bash
/reload
```

### Option 2: local development install

If you are developing locally, put the package under an auto-discovered extension location, for example:

- `~/.pi/agent/extensions/auto-mode-router/`
- `.pi/extensions/auto-mode-router/`

Then run:

```bash
/reload
```

## Setup

1. Run `/auto-mode config`
2. Choose:
   - analysis model
   - frontend model
   - logic model
   - whether **Mid-turn switching** is on
3. Save with `Ctrl+S`
4. Open `/model`
5. Select `auto/mode`
6. Keep using Pi normally

## Commands

- `/auto-mode` → open menu
- `/auto-mode on` → enable Auto Mode
- `/auto-mode off` → disable Auto Mode
- `/auto-mode status` → show current state
- `/auto-mode config` → change models and mid-turn setting
- `/auto` → short alias
- `Alt+A` → toggle Auto Mode

## Example

User prompt:

```text
Build a user profile page. Add a backend profile API and a polished frontend card UI.
```

Possible routing flow:

1. Analyzer detects a multi-domain task
2. Phases are created:
   - Phase 1: `[logic]` profile API and data handling
   - Phase 2: `[frontend]` profile card UI and styling
3. Pi starts with the logic model
4. The model calls:

```ts
switch_domain({ domain: "frontend", reason: "API is done, moving to the UI" })
```

5. Pi switches to the frontend model
6. Status updates from `auto:logic [1/2]` to `auto:frontend [2/2]`

## How it is built

This extension uses Pi extension APIs documented in the official docs, including:

- `registerProvider()` for the virtual `auto/mode` model
- `registerTool()` for `switch_domain`
- `input` event handling for prompt analysis
- `before_agent_start` for phase guidance injection
- `model_select` handling for enabling/disabling Auto Mode
- `agent_end` for cleanup and phase reporting
- `ctx.ui.custom()`, `SettingsList`, and notifications for configuration UI
- `complete()` from `@mariozechner/pi-ai` for classifier calls

## Packaging for Pi

This package is structured as a Pi package and can be installed with `pi install npm:pi-auto-mode-router`.

Pi package docs used for this setup:

- package must include `keywords: ["pi-package"]`
- package should declare a `pi` manifest
- core Pi libraries should stay in `peerDependencies`

Current manifest:

```json
{
  "name": "pi-auto-mode-router",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

## Publishing to npm

From this directory:

```bash
npm publish --access public
```

Useful checks before publishing:

```bash
npm pack --dry-run
npm view pi-auto-mode-router version
```

## Notes

- Auto Mode is only useful when the selected analysis/frontend/logic models are available and authenticated in Pi
- If the analysis model is missing or fails, the extension falls back to heuristic routing
- Multi-domain execution guidance is injected into the system prompt for the turn
- Mid-turn switching is capped to avoid loops
