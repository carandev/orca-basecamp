# orca-basecamp

Orca plugin that connects Basecamp to-dos and cards to Orca worktrees. It automatically syncs status in both directions and completes the item when the worktree is removed.

Basecamp communication runs exclusively through the local `basecamp` CLI (`--json`).

## Quick Start

1. **Install plugin**: In Orca, go to **Settings -> Plugins -> Install plugin -> Git URL**, enter this repo's URL (e.g. `#v0.2.0`) and approve permissions.
2. **Verify CLI**: Run **Basecamp: Diagnose** from the command palette.
3. **Start working**: Run **Basecamp: Start from item**, choose a repository and an item, and click **Start**.

*Requires Orca >= 1.4.0 and Node >= 22.*

## Commands

| Command | Action |
|---------|--------|
| **Basecamp: Diagnose** | Checks that `basecamp` CLI is installed and authenticated. |
| **Basecamp: Start from item** | Opens the picker (To-dos / Cards / Sync). Lets you customize worktree name and base branch, then creates and links the worktree. |
| **Basecamp: Link item to this worktree** | Links the currently open worktree to an existing Basecamp item without creating anything new. |
| **Basecamp: Open linked item** | Opens the linked to-do or card in an Orca tab (or default browser). |
| **Basecamp: Complete linked item** | Marks the linked item as completed in Basecamp. |
| **Basecamp: Sync now** | Forces an immediate bidirectional status sync pass. |

## Status Sync

Sync runs automatically once a minute (and on demand with **Basecamp: Sync now**):

- **Completed**: Marking a worktree completed marks the to-do complete or moves the card to *Done*.
- **In Progress / Custom**: Worktree statuses map to corresponding card columns configured in the **Sync** tab.
- **Removal**: Deleting a linked worktree automatically completes its Basecamp item and cleans up the link.

## Configuration (Optional)

Create `config.json` if the CLI is not in your global `PATH`:
- Windows: `%APPDATA%\orca-basecamp\config.json`
- macOS/Linux: `~/.config/orca-basecamp/config.json`

```json
{
  "basecampBin": "C:\\path\\to\\basecamp.exe",
  "basecampEnv": {
    "BASECAMP_PROFILE": "work"
  }
}
```

Accepted environment variables: `BASECAMP_PROFILE`, `BASECAMP_ACCOUNT_ID`, `BASECAMP_NO_KEYRING`.

## Development

```bash
npm test
```
