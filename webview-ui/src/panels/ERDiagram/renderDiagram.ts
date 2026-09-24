/**
 * Geometry, auto-layout and canvas rendering for the ER diagram.
 *
 * The layout metrics mirror ERDiagram.css so the diagram can be laid out before
 * the boxes have been measured; once they are in the DOM the real offsets are
 * used instead (see `arrangeTables`).
 */

export interface DiagramColumn {
  name: string;
  type: string;
  isPrimaryKey: boolean;
  foreignKey?: boolean;
}

export interface DiagramForeignKey {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
}

export interface DiagramTable {
  name: string;
  schema?: string;
  columns: DiagramColumn[];
  foreignKeys: DiagramForeignKey[];
}

export interface Position { x: number; y: number }
export interface Size { w: number; h: number }

/** Metrics taken from the stylesheet (.table-box and friends). */
const BOX_WIDTH = 240;
const BOX_HEADER_HEIGHT = 33;
const COLUMNS_PADDING = 12;
const COLUMN_ROW_HEIGHT = 20;
const BOX_BORDER = 2;

/** Gap between the boxes, and between the boxes and the canvas edge. */
const GAP_X = 40;
const GAP_Y = 36;
const ORIGIN = 40;

export function estimateBoxSize(table: DiagramTable): Size {
  return {
    w: BOX_WIDTH + BOX_BORDER,
    h: BOX_HEADER_HEIGHT + COLUMNS_PADDING + table.columns.length * COLUMN_ROW_HEIGHT + BOX_BORDER,
  };
}

/**
 * Shelf layout: boxes fill a row left to right, and the next row only starts
 * below the tallest box of the current one. The previous fixed 320×260 grid
 * ignored box height, so tables with many columns ran over the row underneath.
 */
export function arrangeTables(
  tables: DiagramTable[],
  sizes: Record<string, Size> = {},
): Record<string, Position> {
  const positions: Record<string, Position> = {};
  if (tables.length === 0) { return positions; }

  const sizeOf = (table: DiagramTable) => sizes[table.name] || estimateBoxSize(table);
  const columnWidth = Math.max(...tables.map(table => sizeOf(table).w)) + GAP_X;
  const columns = Math.max(1, Math.ceil(Math.sqrt(tables.length)));

  let rowTop = ORIGIN;
  for (let start = 0; start < tables.length; start += columns) {
    const row = tables.slice(start, start + columns);
    let rowHeight = 0;
    row.forEach((table, index) => {
      const size = sizeOf(table);
      positions[table.name] = { x: ORIGIN + index * columnWidth, y: rowTop };
      rowHeight = Math.max(rowHeight, size.h);
    });
    rowTop += rowHeight + GAP_Y;
  }
  return positions;
}

/** A foreign key link, as a cubic bezier shared by the SVG and canvas renderers. */
export interface ConnectionGeometry {
  id: string;
  x1: number; y1: number;
  c1x: number; c1y: number;
  c2x: number; c2y: number;
  x2: number; y2: number;
}

export function connectionPath(g: ConnectionGeometry): string {
  return `M ${g.x1} ${g.y1} C ${g.c1x} ${g.c1y}, ${g.c2x} ${g.c2y}, ${g.x2} ${g.y2}`;
}

export function buildConnections(
  tables: DiagramTable[],
  positions: Record<string, Position>,
  sizes: Record<string, Size> = {},
): ConnectionGeometry[] {
  const list: ConnectionGeometry[] = [];
  const byName = new Map(tables.map(table => [table.name, table]));
  const sizeOf = (table: DiagramTable) => sizes[table.name] || estimateBoxSize(table);

  tables.forEach(table => {
    const startPos = positions[table.name];
    if (!startPos) { return; }

    table.foreignKeys.forEach((fk, fkIndex) => {
      const target = byName.get(fk.referencedTable);
      const endPos = positions[fk.referencedTable];
      // Links to tables outside the current scope (another database) are skipped.
      if (!target || !endPos) { return; }

      const startSize = sizeOf(table);
      const endSize = sizeOf(target);

      // Attach to the facing edges when the tables sit side by side.
      const fromRight = startPos.x + startSize.w < endPos.x;
      const fromLeft = startPos.x > endPos.x + endSize.w;

      let x1 = startPos.x + startSize.w / 2;
      let y1 = startPos.y + startSize.h / 2;
      let x2 = endPos.x + endSize.w / 2;
      let y2 = endPos.y + endSize.h / 2;

      if (fromRight) {
        x1 = startPos.x + startSize.w;
        x2 = endPos.x;
      } else if (fromLeft) {
        x1 = startPos.x;
        x2 = endPos.x + endSize.w;
      }

      const dx = Math.abs(x2 - x1) * 0.5;
      list.push({
        id: `${table.name}-${fk.referencedTable}-${fkIndex}`,
        x1, y1, x2, y2,
        c1x: x1 + (fromRight ? dx : fromLeft ? -dx : 0),
        c1y: y1,
        c2x: x2 + (fromRight ? -dx : fromLeft ? dx : 0),
        c2y: y2,
      });
    });
  });

  return list;
}

// ── Canvas rendering (PNG export / clipboard) ────────────────────────────────

interface Palette {
  background: string;
  surface: string;
  header: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  keyColor: string;
  fonts: { sans: string; mono: string };
}

function cssVar(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  return styles.getPropertyValue(name).trim() || fallback;
}

function readPalette(): Palette {
  const root = getComputedStyle(document.documentElement);
  const body = getComputedStyle(document.body);
  return {
    background: cssVar(root, '--vscode-editor-background', '#1e1e1e'),
    surface: cssVar(root, '--vscode-sideBar-background', '#252526'),
    header: cssVar(root, '--vscode-editorGroupHeader-tabsBackground', '#2d2d2d'),
    border: cssVar(root, '--vscode-widget-border', 'rgba(128,128,128,0.35)'),
    text: cssVar(root, '--vscode-foreground', '#cccccc'),
    muted: cssVar(root, '--vscode-descriptionForeground', '#858585'),
    accent: cssVar(root, '--vscode-charts-blue', '#007acc'),
    keyColor: cssVar(root, '--vscode-charts-yellow', '#d7ba7d'),
    fonts: {
      sans: cssVar(body, '--vscode-font-family', 'sans-serif'),
      mono: cssVar(body, '--vscode-editor-font-family', 'monospace'),
    },
  };
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** Trim text with an ellipsis so it fits the available width. */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0 || ctx.measureText(text).width <= maxWidth) { return text; }
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) { low = mid; } else { high = mid - 1; }
  }
  return `${text.slice(0, low)}…`;
}

export interface RenderOptions {
  tables: DiagramTable[];
  positions: Record<string, Position>;
  sizes: Record<string, Size>;
  connections: ConnectionGeometry[];
  /** Device pixel multiplier, so the export stays sharp when zoomed. */
  scale?: number;
}

/**
 * Draw the diagram onto a canvas. Rendering it by hand (instead of rasterising
 * the DOM) keeps the export dependency-free and independent of whichever CSS
 * the surrounding view happens to load.
 */
export function renderDiagramToCanvas(options: RenderOptions): HTMLCanvasElement | null {
  const { tables, positions, connections } = options;
  const sizes = options.sizes || {};
  if (tables.length === 0) { return null; }

  const palette = readPalette();
  const sizeOf = (table: DiagramTable) => sizes[table.name] || estimateBoxSize(table);

  const PAD = ORIGIN;
  let width = 0;
  let height = 0;
  tables.forEach(table => {
    const pos = positions[table.name];
    if (!pos) { return; }
    const size = sizeOf(table);
    width = Math.max(width, pos.x + size.w);
    height = Math.max(height, pos.y + size.h);
  });
  width += PAD;
  height += PAD;

  // Aim for a crisp export, but never blow past a sane pixel budget — a schema
  // with hundreds of tables would otherwise allocate a gigapixel canvas.
  const MAX_PIXELS = 40_000_000;
  const preferredScale = Math.min(3, Math.max(1, window.devicePixelRatio || 1) * 1.5);
  const scale = options.scale
    ?? Math.max(1, Math.min(preferredScale, Math.sqrt(MAX_PIXELS / Math.max(1, width * height))));
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);

  const ctx = canvas.getContext('2d');
  if (!ctx) { return null; }
  ctx.scale(scale, scale);
  ctx.textBaseline = 'middle';

  ctx.fillStyle = palette.background;
  ctx.fillRect(0, 0, width, height);

  // ── Foreign key links ──
  ctx.strokeStyle = palette.accent;
  ctx.fillStyle = palette.accent;
  ctx.globalAlpha = 0.75;
  ctx.lineWidth = 2;
  connections.forEach(link => {
    ctx.beginPath();
    ctx.moveTo(link.x1, link.y1);
    ctx.bezierCurveTo(link.c1x, link.c1y, link.c2x, link.c2y, link.x2, link.y2);
    ctx.stroke();

    // Arrow head, oriented along the curve's end tangent.
    const dx = link.x2 - link.c2x;
    const dy = link.y2 - link.c2y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const size = 9;
    ctx.beginPath();
    ctx.moveTo(link.x2, link.y2);
    ctx.lineTo(link.x2 - ux * size - uy * size * 0.45, link.y2 - uy * size + ux * size * 0.45);
    ctx.lineTo(link.x2 - ux * size + uy * size * 0.45, link.y2 - uy * size - ux * size * 0.45);
    ctx.closePath();
    ctx.fill();
  });
  ctx.globalAlpha = 1;

  // ── Tables ──
  tables.forEach(table => {
    const pos = positions[table.name];
    if (!pos) { return; }
    const size = sizeOf(table);
    const { x, y, w, h } = { x: pos.x, y: pos.y, w: size.w, h: size.h };

    ctx.save();
    roundRectPath(ctx, x, y, w, h, 6);
    ctx.clip();

    ctx.fillStyle = palette.surface;
    ctx.fillRect(x, y, w, h);

    // Header band + title
    ctx.fillStyle = palette.header;
    ctx.fillRect(x, y, w, BOX_HEADER_HEIGHT);
    ctx.fillStyle = palette.text;
    ctx.font = `600 12px ${palette.fonts.sans}`;
    ctx.fillText(fitText(ctx, table.name, w - 24), x + 12, y + BOX_HEADER_HEIGHT / 2);

    ctx.restore();

    ctx.strokeStyle = palette.border;
    ctx.lineWidth = 1;
    roundRectPath(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 6);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x, y + BOX_HEADER_HEIGHT);
    ctx.lineTo(x + w, y + BOX_HEADER_HEIGHT);
    ctx.stroke();

    // Column rows
    const rowsTop = y + BOX_HEADER_HEIGHT + COLUMNS_PADDING / 2;
    table.columns.forEach((column, index) => {
      const midY = rowsTop + index * COLUMN_ROW_HEIGHT + COLUMN_ROW_HEIGHT / 2;

      if (column.isPrimaryKey || column.foreignKey) {
        ctx.fillStyle = column.isPrimaryKey ? palette.keyColor : palette.accent;
        ctx.font = `700 8px ${palette.fonts.sans}`;
        ctx.fillText(column.isPrimaryKey ? 'PK' : 'FK', x + 12, midY);
      }

      ctx.font = `10px ${palette.fonts.mono}`;
      ctx.fillStyle = palette.muted;
      const typeWidth = ctx.measureText(column.type).width;
      ctx.textAlign = 'right';
      ctx.fillText(column.type, x + w - 12, midY);
      ctx.textAlign = 'left';

      ctx.font = `11px ${palette.fonts.mono}`;
      ctx.fillStyle = column.isPrimaryKey ? palette.keyColor : column.foreignKey ? palette.accent : palette.text;
      const nameLeft = x + 12 + 20;
      ctx.fillText(
        fitText(ctx, column.name, x + w - 12 - typeWidth - 12 - nameLeft),
        nameLeft,
        midY,
      );
    });
  });

  return canvas;
}
