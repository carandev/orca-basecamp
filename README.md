# orca-basecamp

Orca plugin that turns a Basecamp to-do or card into a linked worktree, and completes the item when you remove the worktree.

It talks to Basecamp only through the `basecamp` CLI. You need the CLI installed and logged in.

## Quick path

1. Orca: **Settings -> Plugins -> Install plugin -> Git URL**, paste this repository's URL (add `#v0.2.0` to pin a release) and accept the permissions.
2. Command palette: **Basecamp: Diagnose**. Fix whatever it reports (see below).
3. Command palette: **Basecamp: Start from item**, pick a repository and an item, press **Start**.

Requires Orca >= 1.4.0 and Node 22 or newer for development.

## Commands

| Command | What it does |
|---------|--------------|
| Basecamp: Diagnose | Checks that the CLI runs and is logged in. Shows a summary, never secrets |
| Basecamp: Start from item | Opens a local picker for to-dos and cards. Start creates the worktree `bc-<id>-<slug>` with the item as the agent prompt, and links them |
| Basecamp: Open linked item | Opens the item linked to the active worktree in an Orca tab (OS browser as fallback) |
| Basecamp: Complete linked item | Completes the item linked to the active worktree and keeps the link, so later changes still sync. If it fails, the link is kept too |
| Basecamp: Sync now | Runs one sync pass right away and waits for it (up to 20 s) |

The picker shows only items assigned to you by default. Uncheck **Only mine** to show everything visible to you. With it checked, cards are listed account-wide, so the project select is hidden; unchecked, cards are listed for the chosen project. Unfiltered to-dos are capped at 100 by the CLI default, and the picker shows the CLI's notice when that happens.

Open and Complete are always available. With no linked item they only notify "No linked item".

When a linked worktree is removed, its item is completed once (10 s limit, no retries) and the link is deleted. If that fails, the notification carries the title and URL so you can finish by hand. This happens whether sync is on or off.

## Status sync

Linked items keep their status in step with the Orca workspace status, in both directions. **Sync is on by default** and runs about once a minute for linked worktrees; **Basecamp: Sync now** runs one pass on demand.

| Orca status | To-do | Card |
|-------------|-------|------|
| `completed` | completed | moved to Done |
| any other status | reopened | moved to the column mapped to that status (unmapped statuses are ignored) |

Start also sets the initial Orca status: `in-progress` for an open to-do, `completed` for a completed one, and the mapped status for a card.

### Sync tab

Open the picker (**Basecamp: Start from item**) and choose the **Sync** tab:

- **Enabled**: turns sync on or off. Off means no status writes in either direction.
- **When both sides changed**: the conflict rule.
  - `Orca wins` (default): Basecamp is overwritten with the Orca status.
  - `Basecamp wins`: Orca is overwritten with the Basecamp state.
- **Project grid**: for each project, pick the Basecamp card column for `todo`, `in-progress`, `in-review` and any custom status you add. Columns are listed by their title; `none` leaves a status unmapped. `completed` is fixed to Done. If several statuses share a column, Basecamp changes keep the current Orca status when it already maps there, otherwise the first status in the grid.

The first pass for a link only records both sides and writes nothing, so enabling sync never rewrites existing items.

### Notifications

Notifications are sent only for conflicts and failures, never for successful syncs. A failure repeats only after the item has synced successfully again.

### Limits

- The poller stops when Orca restarts the plugin worker. It restarts on the first event or command afterwards, so run **Basecamp: Sync now** (or any command) after a restart.
- Only one card table per project is supported. If the project has several, the CLI error is shown and cards are not moved.
- The first 1000 worktrees from `orca worktree list` are read each pass; a truncated list is reported once.

### Rollback

Turn sync off in the Sync tab, or delete the `sync:config` entry. Links written by v0.2.0 (version 2) are not readable by v0.1.x: after downgrading, linked worktrees show "No linked item" until you start them again.

## Config file

Optional. Windows: `%APPDATA%\orca-basecamp\config.json`. Other systems: `$XDG_CONFIG_HOME/orca-basecamp/config.json` or `~/.config/orca-basecamp/config.json`.

```json
{
  "basecampBin": "C:\\Users\\you\\bin\\basecamp.exe",
  "basecampEnv": { "BASECAMP_PROFILE": "work" }
}
```

| Key | Meaning |
|-----|---------|
| `basecampBin` | Path or name of the CLI. Default: `basecamp` from the PATH |
| `basecampEnv` | Extra environment for the CLI. Only `BASECAMP_NO_KEYRING`, `BASECAMP_PROFILE` and `BASECAMP_ACCOUNT_ID` are accepted. Anything else makes the plugin refuse the file |

The file is read on every command, so no restart is needed.

## Troubleshooting with Diagnose

`basecamp.exe` often lives in `~/bin`, and the PATH that Orca gives plugin workers may not include it. If Diagnose reports `cli_not_found`, set `basecampBin` to the full path.

If the CLI runs but is not authenticated (for example the OS keyring is unreachable from the worker), run `basecamp auth login` in a terminal. Setting `BASECAMP_NO_KEYRING` through `basecampEnv` switches the CLI to its credentials file: do it only if you accept that.

## Privacy

- Basecamp is reached only through the `basecamp` CLI with `--json`. The plugin has no Basecamp HTTP client.
- The plugin stores and reads no tokens. `BASECAMP_TOKEN` is removed from the CLI's environment and cannot be set in the config file.
- The only network listener is the picker on `127.0.0.1` (random port, random token, closes after 15 idle minutes).
- Per linked worktree, Orca plugin storage keeps the item type, ids, title and URL.

## Development

```
npm test
```
