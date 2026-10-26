# orca-basecamp

Orca plugin that links Basecamp to-dos and cards to Orca worktrees. It keeps statuses in sync in both directions and completes the Basecamp item automatically when the worktree is removed.

## Requirements

- [Orca](https://orca.so) >= 1.4.0
- Node >= 22
- [Basecamp CLI](https://github.com/Gentleman-Programming/basecamp-cli) — installed and authenticated

## Installation

1. Open Orca and go to **Settings → Plugins → Install plugin → Git URL**.
2. Enter this repository's URL (e.g. `https://github.com/your-org/orca-basecamp#v0.2.0`).
3. Approve the requested permissions.
4. Open the command palette and run **Basecamp: Diagnose** to confirm the CLI is found and authenticated.

### If the Basecamp CLI is not in your PATH

Create a `config.json` file in the platform config directory:

- **Windows:** `%APPDATA%\orca-basecamp\config.json`
- **macOS / Linux:** `~/.config/orca-basecamp/config.json`

```json
{
  "basecampBin": "/absolute/path/to/basecamp",
  "basecampEnv": {
    "BASECAMP_PROFILE": "work"
  }
}
```

`basecampBin` points to the CLI executable. `basecampEnv` sets extra environment variables passed on every CLI call. Supported variables: `BASECAMP_PROFILE`, `BASECAMP_ACCOUNT_ID`, `BASECAMP_NO_KEYRING`.

---

## Commands

### Basecamp: Start from item
Opens the picker. Choose a **repository**, pick a **to-do or card**, and click **Start**. The plugin creates a new Orca worktree, links it to that item, and opens it.

- **Repository** — the Orca-managed git repo where the worktree will be created.
- **Base branch** *(optional)* — branch the new worktree starts from. Defaults to the repo's default branch.
- **Agent** *(optional)* — an Orca agent to attach to the new worktree (e.g. `claude`).
- **Only mine** — filters to-dos and cards assigned to you. Uncheck to see all items in a project.
- Items already linked to a worktree show a **Linked to worktree** badge and cannot be started again.

### Basecamp: Link item to this worktree
Links the **currently open** worktree to a Basecamp item without creating anything new. Useful when you already started work in a worktree and want to attach it to an existing to-do or card.

### Basecamp: Open linked item
Opens the Basecamp to-do or card linked to the current worktree in an Orca browser tab (or your default browser as fallback).

### Basecamp: Complete linked item
Marks the linked Basecamp item as completed from inside Orca, without leaving your worktree.

### Basecamp: Sync now
Forces an immediate bidirectional status sync between Orca and Basecamp. Sync otherwise runs automatically every minute while a worktree is open.

### Basecamp: Diagnose
Checks that the `basecamp` CLI is installed, reachable, and authenticated. Run this first if something is not working.

---

## Status Sync

The **Sync** tab (in the picker) controls how Orca workspace statuses map to Basecamp card columns.

| Setting | What it does |
|---------|--------------|
| **Sync statuses** | Enables/disables automatic bidirectional sync. |
| **Remove worktree when done** | Automatically removes the Orca worktree when the linked item is completed on either side. |
| **When both sides changed** | Conflict resolution rule: **Orca wins** or **Basecamp wins**. |
| **Column mapping (per project)** | Maps each Orca status (`todo`, `in-progress`, `in-review`, or a custom one) to one or more Basecamp card columns. The first column in the list is the destination when moving a card. |

**Built-in status rules:**

- Moving a worktree to **completed** marks the to-do done or moves the card to *Done* in Basecamp.
- Completing a to-do or moving a card to *Done* in Basecamp sets the Orca status to **completed**.
- **Removing** a linked worktree automatically completes its Basecamp item and cleans up the link.
