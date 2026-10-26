const MAX_SLUG = 20;

/** NFKD fold, strip combining marks, lowercase, non `[a-z0-9]` runs to `-`, trim, cap at 20, trim trailing `-`. */
export function slugify(title) {
  if (typeof title !== 'string') return '';
  return title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/, '');
}

/** Worktree name `bc-<id>-<slug>`, or `bc-<id>` when the slug is empty. */
export function worktreeName(id, title) {
  const slug = slugify(title);
  return slug ? `bc-${id}-${slug}` : `bc-${id}`;
}
