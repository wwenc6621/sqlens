/** Minimal shape needed to render a column type label. */
export interface TypedColumn {
  type?: string;
  rawType?: string;
  maxLength?: number;
  precision?: number;
  scale?: number;
}

/** Types where a (precision, scale) suffix is meaningful. */
const NUMERIC_TOKENS = ['decimal', 'numeric', 'dec', 'fixed', 'money'];
/** Extra exact tokens where a (length) suffix is meaningful. */
const LENGTH_TOKENS = ['bytea'];
/** Covers char/character, varchar, text/tinytext, blob, binary/varbinary, bit. */
const LENGTH_SUFFIX = /^(char|text|blob|binary|bit)|(char|text|blob|binary)$/;
/** Integer families — the only place MySQL-style modifiers show up in practice. */
const INTEGER_TOKENS = ['tinyint', 'smallint', 'mediumint', 'integer', 'int', 'bigint'];

/**
 * Drop modifiers that only widen the header without telling the reader much.
 * (Removed: `unsigned`/`zerofill` are part of the real type and must be kept —
 * the function is kept as an identity for potential future use.)
 */
function stripNoiseModifiers(raw: string): string {
  return raw;
}

function tokensOf(base: string): string[] {
  return base.split(/[\s()]+/).filter(Boolean);
}

function isExactNumeric(base: string): boolean {
  return tokensOf(base).some(token => NUMERIC_TOKENS.includes(token));
}

function isLengthTyped(base: string): boolean {
  return tokensOf(base).some(token => LENGTH_SUFFIX.test(token) || LENGTH_TOKENS.includes(token));
}

/**
 * Render a column's declared type for display, e.g. `varchar(64)`,
 * `decimal(10,2)` or `bigint unsigned`.
 *
 * Drivers normally report the full declared type already (MySQL `COLUMN_TYPE`,
 * SQLite declared type) which is used verbatim — modifiers like `unsigned` are
 * part of the real type and must not be dropped. Only when the declared type is
 * missing do we rebuild it from the length/precision metadata, and only for the
 * kind of type where that makes sense — otherwise integer columns would render
 * as `bigint(20,0)`, since MySQL 8.0.19+ dropped the display width from the
 * type name while still reporting precision 20 / scale 0.
 */
export function formatColumnType(col?: TypedColumn | null): string {
  if (!col) { return ''; }

  const raw = (col.rawType || col.type || '').trim().toLowerCase();
  if (!raw) { return ''; }
  const base = stripNoiseModifiers(raw);
  // Already carries its own spec, e.g. `varchar(64)` or `decimal(10,2)`.
  if (base.includes('(')) { return base; }

  // Declared type carries modifiers (e.g. `bigint unsigned`): use verbatim and
  // never rebuild a spec suffix from metadata — that metadata belongs to the
  // base type and would produce nonsense like `bigint unsigned(20,0)`.
  if (/\s/.test(base)) { return base; }

  if (isExactNumeric(base)) {
    if (col.precision && col.scale !== undefined && col.scale !== null) {
      return `${base}(${col.precision},${col.scale})`;
    }
    if (col.precision && col.precision > 0) {
      return `${base}(${col.precision})`;
    }
    return base;
  }

  if (isLengthTyped(base) && col.maxLength && col.maxLength > 0 && col.maxLength < 65535) {
    return `${base}(${col.maxLength})`;
  }

  return base;
}
