const present = (value) => value !== undefined && value !== null && value !== '';

/** Items for the picker. A projectId narrows to-dos and cards; only cards without `mine` require one. */
export async function listItems({ source, kind, projectId, mine }) {
  const query = { kind, ...(mine === undefined ? {} : { mine }), ...(present(projectId) ? { projectId } : {}) };
  if (kind === 'todo') return source.list(query);
  if (kind === 'card') {
    if (mine !== true && !present(projectId)) throw new Error('projectId is required for cards');
    return source.list(query);
  }
  throw new Error(`Unknown kind "${kind}"`);
}

export const listProjects = ({ source }) => source.projects();
