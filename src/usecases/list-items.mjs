/** Items for the picker. To-dos are account-wide (a projectId is ignored); cards need a project unless `mine` (account-wide). */
export async function listItems({ source, kind, projectId, mine }) {
  const scope = mine === undefined ? {} : { mine };
  if (kind === 'todo') return source.list({ kind, ...scope });
  if (kind === 'card') {
    if (mine !== true && (projectId === undefined || projectId === null || projectId === '')) throw new Error('projectId is required for cards');
    return source.list(mine === true ? { kind, ...scope } : { kind, ...scope, projectId });
  }
  throw new Error(`Unknown kind "${kind}"`);
}

export const listProjects = ({ source }) => source.projects();
