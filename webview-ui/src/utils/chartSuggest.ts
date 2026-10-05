/**
 * Chart suggestion + data shaping for query results.
 *
 * Pure module (no React / no VS Code imports) so it can be unit-tested
 * offline, and so the ECharts option builder stays a thin mapping layer in the
 * view component.
 */

export type ChartKind = 'bar' | 'line' | 'pie';

/** Minimal column shape needed to pick dimensions/measures. */
export interface ChartColumn {
  name: string;
  /** Normalized type from the extension (integer/float/decimal/date/...). */
  normalizedType?: string;
  type?: string;
  rawType?: string;
}

export interface ChartConfig {
  kind: ChartKind;
  /** Dimension column name. Undefined = use the row index. */
  x?: string;
  /** One or more numeric (measure) column names. */
  y: string[];
}

/** Cap how many rows a chart renders, so big result sets stay responsive. */
export const CHART_MAX_ROWS = 500;

const NUMERIC_TYPES = new Set(['integer', 'float', 'decimal']);
const TEMPORAL_TYPES = new Set(['date', 'datetime', 'timestamp', 'time']);
const NUMERIC_NAME = /\b(int|integer|bigint|smallint|tinyint|mediumint|decimal|numeric|float|double|real|number|money|serial)\b/;
const TEMPORAL_NAME = /\b(date|datetime|timestamp|time)\b/;

/** True when a column holds a number worth plotting on a value axis. */
export function isNumericColumn(col: ChartColumn): boolean {
  const normalized = (col.normalizedType || '').toLowerCase();
  if (NUMERIC_TYPES.has(normalized)) { return true; }
  const raw = `${col.type || ''} ${col.rawType || ''}`.toLowerCase();
  return NUMERIC_NAME.test(raw);
}

/** True when a column holds a date/time value. */
export function isTemporalColumn(col: ChartColumn): boolean {
  const normalized = (col.normalizedType || '').toLowerCase();
  if (TEMPORAL_TYPES.has(normalized)) { return true; }
  const raw = `${col.type || ''} ${col.rawType || ''}`.toLowerCase();
  return TEMPORAL_NAME.test(raw);
}

/** Numeric column names, in result order. */
export function numericColumnNames(columns: ChartColumn[]): string[] {
  return columns.filter(isNumericColumn).map(c => c.name);
}

/**
 * Infer a sensible default chart from the result shape:
 * - dimension = a temporal column (line chart) or the first non-numeric column
 * - measures  = every numeric column (capped to keep the legend readable)
 *
 * Returns `null` when there is no numeric column to plot.
 */
export function suggestChart(columns: ChartColumn[], rows: unknown[][]): ChartConfig | null {
  if (!columns || columns.length === 0 || !rows || rows.length === 0) { return null; }

  const measures = numericColumnNames(columns);
  if (measures.length === 0) { return null; }

  const dimensionColumns = columns.filter(c => !isNumericColumn(c));
  const temporal = dimensionColumns.find(isTemporalColumn);
  const dimension = temporal ?? dimensionColumns[0];

  return {
    kind: temporal ? 'line' : 'bar',
    x: dimension?.name,
    y: measures.slice(0, 8),
  };
}

export interface ChartSeries {
  name: string;
  /** One entry per category; `null` marks a missing/unparsable value. */
  data: Array<number | null>;
}

export interface ChartData {
  /** X-axis labels (one per rendered row). */
  categories: string[];
  series: ChartSeries[];
  /** Rows actually rendered (after the CHART_MAX_ROWS cap). */
  renderedRows: number;
  /** Total rows available before the cap. */
  totalRows: number;
}

/** Coerce a cell to a number, or `null` when it is empty / not numeric. */
function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') { return null; }
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Format a category label without dragging in heavy date formatting. */
function toLabel(value: unknown): string {
  if (value === null || value === undefined) { return ''; }
  if (value instanceof Date) { return value.toISOString(); }
  return String(value);
}

/**
 * Shape the raw `{ columns, rows }` into category + series arrays for ECharts.
 * Rows are capped at `CHART_MAX_ROWS`.
 */
export function buildChartData(
  columns: ChartColumn[],
  rows: unknown[][],
  config: ChartConfig,
): ChartData {
  const totalRows = rows?.length ?? 0;
  const capped = (rows ?? []).slice(0, CHART_MAX_ROWS);

  const xIndex = config.x ? columns.findIndex(c => c.name === config.x) : -1;
  const categories = capped.map((row, i) =>
    xIndex >= 0 ? toLabel(row[xIndex]) : String(i + 1),
  );

  const series: ChartSeries[] = [];
  for (const name of config.y) {
    const colIndex = columns.findIndex(c => c.name === name);
    if (colIndex < 0) { continue; }
    series.push({
      name,
      data: capped.map(row => toNumber(row[colIndex])),
    });
  }

  return { categories, series, renderedRows: capped.length, totalRows };
}
