/**
 * Filter matching for the Schema tree.
 *
 * Filtering runs in the webview (the tree data is already loaded there), so the
 * matcher lives next to the panel. Kept dependency-free so it stays unit
 * testable — `tests/unit.test.ts` imports this file directly.
 */

/**
 * Match a table or view against the schema filter.
 *
 * - An empty pattern matches everything.
 * - Plain text is a case-insensitive substring match.
 * - `*` and `?` switch it to wildcard matching (`*` = any run, `?` = one char).
 * - The qualified `schema.table` form is matched as well, so `public.users`
 *   and `public.*` both work.
 *
 * A malformed wildcard pattern matches everything rather than silently hiding
 * every object.
 */
export function matchTableFilter(name: string, schema: string | undefined, filter: string): boolean {
  const pattern = (filter || '').trim().toLowerCase();
  if (!pattern) { return true; }

  const target = name.toLowerCase();
  const qualified = schema ? `${schema}.${name}`.toLowerCase() : target;

  if (pattern.includes('*') || pattern.includes('?')) {
    const source = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    try {
      const re = new RegExp(`^${source}$`);
      return re.test(target) || re.test(qualified);
    } catch {
      return true;
    }
  }

  return target.includes(pattern) || qualified.includes(pattern);
}
