const stripRef = (branch) => (typeof branch === 'string' ? branch.replace(/^refs\/heads\//, '') : '');

/**
 * OrcaPort over the `orca` CLI. `orcaCli(args)` resolves to the CLI `result` (it appends `--json`);
 * `readContext()` resolves to `null | {branch, displayName, terminals: [{id}]}` (workspace.readContext).
 * Every argument is its own argv entry: item text can never be split or interpreted by a shell.
 */
export function createOrcaAdapter({ orcaCli, readContext }) {
  async function listWorktrees() {
    const { worktrees = [] } = (await orcaCli(['worktree', 'list'])) ?? {};
    return worktrees;
  }

  return {
    async listRepos() {
      const { repos = [] } = (await orcaCli(['repo', 'list'])) ?? {};
      return repos.map((r) => ({ id: r.id, name: r.displayName ?? r.id, path: r.path }));
    },

    /**
     * The CLI prints `{worktree}`; with `--agent` it prints `{worktree?, lineage, launch: {worktreeId}}`,
     * where `worktree` is absent if the follow-up show failed (Orca cli/handlers/worktree.js).
     */
    async createWorktree({ repoId, name, comment, agent, prompt }) {
      const args = ['worktree', 'create', '--repo', `id:${repoId}`, '--name', name, '--comment', comment];
      if (agent) args.push('--agent', agent, '--prompt', prompt ?? '');
      const result = (await orcaCli(args)) ?? {};
      return {
        worktreeId: result.worktree?.id ?? result.launch?.worktreeId ?? result.id,
        path: result.worktree?.path ?? result.path
      };
    },

    /** Id of the one worktree matching `path`, else `name`; null when none or ambiguous. */
    async findWorktree({ name, path }) {
      const worktrees = await listWorktrees();
      const byPath = path === undefined ? [] : worktrees.filter((w) => w.path === path);
      const matches = byPath.length > 0 ? byPath : worktrees.filter((w) => w.displayName === name);
      return matches.length === 1 ? matches[0].id : null;
    },

    async openTab({ worktreeId, url }) {
      await orcaCli(['tab', 'create', '--worktree', `id:${worktreeId}`, '--url', url]);
    },

    /** Adapted from orca-repo-layouts `resolveActiveWorktree`. Null when no worktree is focused. */
    async resolveActiveWorktree() {
      const context = await readContext();
      if (!context) return null;
      const terminals = context.terminals ?? [];
      let worktreeId;
      let worktreePath;
      if (terminals.length > 0) {
        const shown = (await orcaCli(['terminal', 'show', '--terminal', terminals[0].id]))?.terminal;
        worktreeId = shown?.worktreeId;
        worktreePath = shown?.worktreePath;
      } else {
        const matches = (await listWorktrees()).filter(
          (w) => w.displayName === context.displayName && stripRef(w.branch) === stripRef(context.branch)
        );
        if (matches.length === 0) throw new Error(`No worktree matches "${context.displayName}" (${context.branch})`);
        if (matches.length > 1) {
          throw new Error(`Multiple worktrees match "${context.displayName}" (${context.branch}); cannot pick one`);
        }
        worktreeId = matches[0].id;
        worktreePath = matches[0].path;
      }
      if (!worktreeId || !worktreePath) throw new Error('Could not resolve the active worktree id and path');
      return { worktreeId, worktreePath };
    }
  };
}
