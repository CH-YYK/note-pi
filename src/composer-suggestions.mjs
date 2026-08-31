/**
 * Find the active completion trigger immediately before a textarea cursor.
 * `@` can appear after whitespace; slash commands intentionally only complete
 * at the start because the harness only routes leading slash input.
 */
export function composerTrigger(value, cursor) {
  const beforeCursor = value.slice(0, cursor);
  const note = /(?:^|\s)@([^\s@]*)$/.exec(beforeCursor);
  if (note) {
    const query = note[1];
    return { kind: "note", query, start: cursor - query.length - 1, end: cursor };
  }
  const command = /^\/([^\s/]*)$/.exec(beforeCursor);
  if (command) {
    const query = command[1];
    return { kind: "command", query, start: 0, end: cursor };
  }
  return undefined;
}

/** Rank direct name matches ahead of path-only matches and keep ordering stable. */
export function filterSuggestions(entries, query, limit = 8) {
  const normalized = query.trim().toLocaleLowerCase();
  return entries
    .filter((entry) => !normalized || entry.name.toLocaleLowerCase().includes(normalized) || entry.detail.toLocaleLowerCase().includes(normalized))
    .sort((left, right) => {
      const leftName = left.name.toLocaleLowerCase().startsWith(normalized) ? 0 : 1;
      const rightName = right.name.toLocaleLowerCase().startsWith(normalized) ? 0 : 1;
      return leftName - rightName || left.name.localeCompare(right.name) || left.detail.localeCompare(right.detail);
    })
    .slice(0, limit);
}

export function replaceComposerRange(value, start, end, replacement) {
  return `${value.slice(0, start)}${replacement}${value.slice(end)}`;
}
