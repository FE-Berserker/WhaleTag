/**
 * Pick a non-colliding file name for a copy/import into a directory. If `name`
 * is free it's returned as-is; otherwise a " (n)" suffix is inserted before the
 * extension (`report.pdf` → `report (1).pdf`), incrementing until free. Pure so
 * it can be unit-tested; the caller supplies the set of names already taken.
 */
export function nextAvailableName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  // Treat a leading-dot file (".env") as having no extension.
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; ; i += 1) {
    const candidate = `${base} (${i})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}
