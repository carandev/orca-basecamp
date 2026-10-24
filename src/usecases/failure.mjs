/** One-line description of a failure: its message plus the CLI hint when there is one. */
export function describeFailure(error) {
  const message = error?.message ?? String(error);
  return error?.hint ? `${message} Hint: ${error.hint}` : message;
}

/** Runs `notify` and swallows its failure: a handler that must never throw cannot depend on the UI. */
export async function safeNotify(notify, title, body) {
  try {
    await notify(title, body);
  } catch {
    // nothing else can be done with a failed notification
  }
}
