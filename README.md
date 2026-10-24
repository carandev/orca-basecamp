# orca-basecamp

Orca plugin that turns a Basecamp to-do or card into a linked worktree, and completes the item when you remove the worktree.

It talks to Basecamp only through the `basecamp` CLI. You need the CLI installed and logged in.

## Quick path

1. Orca: **Settings -> Plugins -> Install plugin -> Git URL**, paste this repository's URL (add `#v0.1.0` to pin a release) and accept the permissions.
2. Command palette: **Basecamp: Diagnose**. Fix whatever it reports (see below).
3. Command palette: **Basecamp: Start from item**, pick a repository and an item, press **Start**.

Requires Orca >= 1.4.0 and Node 22 or newer for development.

## Commands

| Command | What it does |
|---------|--------------|
| Basecamp: Diagnose | Checks that the CLI runs and is logged in. Shows a summary, never secrets |
| Basecamp: Start from item | Opens a local picker for to-dos and cards. Start creates the worktree `bc-<id>-<slug>` with the item as the agent prompt, and links them |
| Basecamp: Open linked item | Opens the item linked to the active worktree in an Orca tab (OS browser as fallback) |
| Basecamp: Complete linked item | Completes the item linked to the active worktree. The link is kept if it fails |

Open and Complete are always available. With no linked item they only notify "No linked item".

When a linked worktree is removed, its item is completed once (10 s limit, no retries) and the link is deleted. If that fails, the notification carries the title and URL so you can finish by hand.

## Config file

Optional. Windows: `%APPDATA%\orca-basecamp\config.json`. Other systems: `$XDG_CONFIG_HOME/orca-basecamp/config.json` or `~/.config/orca-basecamp/config.json`.

```json
{
  "basecampBin": "C:\Users\you\bin\basecamp.exe",
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
