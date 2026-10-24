/** Items for the picker. To-dos are account-wide (a projectId is ignored); cards need a project. */
export async function listItems({ source, kind, projectId }) {
  if (kind === 'todo') return source.list({ kind });
  if (kind === 'card') {
    if (projectId === undefined || projectId === null || projectId === '') throw new Error('projectId is required for cards');
    return source.list({ kind, projectId });
  }
  throw new Error(`Unknown kind "${kind}"`);
}

export const listProjects = ({ source }) => source.projects();
