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
| Basecamp: Link item to this worktree | Opens the picker in link mode for the active worktree. Choosing an item links it to that worktree; nothing is created. See [Link an existing worktree](#link-an-existing-worktree) |
| Basecamp: Open linked item | Opens the item linked to the active worktree in an Orca tab (OS browser as fallback) |
| Basecamp: Complete linked item | Completes the item linked to the active worktree and keeps the link, so later changes still sync. If it fails, the link is kept too |
| Basecamp: Sync now | Runs one sync pass right away and waits for it (up to 20 s) |

The picker shows only items assigned to you by default. Uncheck **Only mine** to show everything visible to you. The **Project** select is always visible on both tabs and defaults to **All projects**; choosing a project reloads the list and combines with **Only mine**. On Cards, **Only mine** with **All projects** lists your cards account-wide, and with a project it keeps only that project's cards (the CLI cannot combine `--assignee` with `--in`, so the filter runs in the plugin). Cards with **Only mine** unchecked need a project ("Choose a project."). The CLI lists at most 100 to-dos by default; when a list is capped, the picker shows the CLI notice. Filtering by **Only mine** or by a project keeps lists well under that cap in practice.

Open and Complete are always available. With no linked item they only notify "No linked item".

When a linked worktree is removed, its item is completed once (10 s limit, no retries) and the link is deleted. If that fails, the notification carries the title and URL so you can finish by hand. This happens whether sync is on or off.

### Link an existing worktree

Use **Basecamp: Link item to this worktree** when the worktree already exists. It needs an active worktree (otherwise it only notifies "Open a worktree first"). The picker opens with "Link to: <worktree>", without the repository and agent selectors, and each item has a **Link** button. The To-dos/Cards tabs and **Only mine** work as usual.

- No new worktree is created and no agent is launched.
- The Orca status and comment of the worktree are not changed.
- If the worktree already had a link, it is replaced, and a notification names the item that was replaced.
- The link is written without a sync baseline, so with sync on, the first sync pass only records both sides and changes nothing. Open, Complete, sync and worktree removal then work as for a worktree created by Start.
- The target worktree is fixed by the plugin when the command runs (a single-use session that expires after 15 minutes); the page cannot choose another one. Run the command again for a new session.

## Status sync

Linked items keep their status in step with the Orca workspace status, in both directions. **Sync is on by default** and runs about once a minute for linked worktrees; **Basecamp: Sync now** runs one pass on demand.

| Orca status | To-do | Card |
|-------------|-------|------|
| `completed` | completed | moved to Done |
| any other status | reopened | moved to the first column mapped to that status (unmapped statuses are ignored) |

Start also sets the initial Orca status: `in-progress` for an open to-do, `completed` for a completed one, and, for a card, the first status whose columns include the card's column.

### Sync tab

Open the picker (**Basecamp: Start from item**) and choose the **Sync** tab:

- **Enabled**: turns sync on or off. Off means no status writes in either direction.
- **When both sides changed**: the conflict rule.
  - `Orca wins` (default): Basecamp is overwritten with the Orca status.
  - `Basecamp wins`: Orca is overwritten with the Basecamp state.
- **Project grid**: for each project, pick the Basecamp card columns for `todo`, `in-progress`, `in-review` and any custom status you add. Each status can have **several columns**: they are shown in order with a remove button, the first one is labelled "(destination)", and **add column** appends another. Columns are listed by their title; a status with no columns is unmapped. `completed` is fixed to Done. The same column may belong to several statuses.
  - Orca to Basecamp: when a status changes, the card is moved to the status's first column (the destination), unless it is already in one of that status's columns, in which case it is not moved.
  - Basecamp to Orca: when the card moves to a column, the Orca status is kept if its columns include that column; otherwise it becomes the first status in the grid whose columns include it. A column mapped to no status changes nothing in Orca.
  - Example: map "Por desarrollar" and "Por corregir" to `todo`. Setting a worktree to `todo` moves its card to "Por desarrollar" (or leaves it in "Por corregir"), and a card dragged into either column sets the worktree to `todo` unless it already is.

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
