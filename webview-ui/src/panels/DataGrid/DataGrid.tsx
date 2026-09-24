import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { postMessage as postRaw, onMessage, getState, setState } from '../../hooks/useVsCode';
import Icon from '../../components/Icon';
import { formatColumnType } from '../../utils/columnType';
import { t } from '../../i18n';
import './DataGrid.css';

interface ColumnHeader {
  name: string;
  type: string;
  normalizedType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  isAutoIncrement: boolean;
  rawType?: string;
  maxLength?: number;
  precision?: number;
  scale?: number;
  /** Column comment / description from the database catalog. */
  comment?: string;
}

interface QueryResult {
  columns: ColumnHeader[];
  rows: unknown[][];
  affectedRows: number;
  executionTime: number;
  truncated: boolean;
  messages: string[];
}

type CopyFormat = 'csv' | 'csv-noheader' | 'tsv' | 'tsv-noheader' | 'json' | 'xml' | 'insert' | 'update';
type GridViewMode = 'table' | 'ddl';

interface CellEdit {
  rowIndex: number;
  colIndex: number;
  oldValue: unknown;
  newValue: unknown;
}

interface RowState {
  status: 'unchanged' | 'modified' | 'added' | 'deleted';
  data: unknown[];
  original: unknown[];
  changedCols: Set<number>;
}

interface SortState { column: number; direction: 'asc' | 'desc'; }

type ColumnFilterOperator = 'like' | 'startsWith' | 'endsWith' | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'empty' | 'notEmpty' | 'null' | 'notNull';

interface ColumnFilterState {
  operator: ColumnFilterOperator;
  value: string;
}

interface GridPersistedState {
  showColumnFilters?: boolean;
  columnLayout?: {
    order?: string[];
    hidden?: string[];
    autoApply?: boolean;
  };
  /** User-dragged width of the Quick View sidebar, in px. */
  quickViewWidth?: number;
}

type UndoAction =
  | { type: 'edit'; rowIndex: number; colIndex: number; oldValue: unknown; newValue: unknown }
  | { type: 'addRow'; rowIndex: number }
  | { type: 'deleteRow'; rowIndex: number; row: RowState }
  | { type: 'duplicateRow'; rowIndex: number };

interface ContextMenu {
  x: number;
  y: number;
  visIdx: number;
  colIdx?: number;
  copyText?: string;
  copyLabel?: string;
  /** Set when the menu targets several selected rows instead of one cell. */
  rowVisIdxs?: number[];
}

/** Render a JS value as a SQL literal. */
function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

interface GridLogEntry {
  id: number;
  time: string;
  level: 'info' | 'success' | 'error';
  message: string;
  query?: string;
}

interface QuickViewState {
  columns: ColumnHeader[];
  rowData: unknown[];
}

interface SqlPreviewState {
  open: boolean;
  loading: boolean;
  sql: string;
  count: number;
  error?: string;
}

const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_COLUMN_FILTER_OPERATOR: ColumnFilterOperator = 'like';
const COLUMN_FILTER_OPERATORS: { value: ColumnFilterOperator; icon: string; label: string; needsValue: boolean }[] = [
  { value: 'like', icon: '~', label: t('contains / LIKE'), needsValue: true },
  { value: 'startsWith', icon: '^', label: t('starts with'), needsValue: true },
  { value: 'endsWith', icon: '$', label: t('ends with'), needsValue: true },
  { value: 'eq', icon: '=', label: 'equals', needsValue: true },
  { value: 'neq', icon: '!=', label: t('not equals'), needsValue: true },
  { value: 'gt', icon: '>', label: t('greater than'), needsValue: true },
  { value: 'gte', icon: '>=', label: t('greater than or equal'), needsValue: true },
  { value: 'lt', icon: '<', label: t('less than'), needsValue: true },
  { value: 'lte', icon: '<=', label: t('less than or equal'), needsValue: true },
  { value: 'empty', icon: '∅', label: t('empty string or null'), needsValue: false },
  { value: 'notEmpty', icon: '!∅', label: t('not empty'), needsValue: false },
  { value: 'null', icon: 'NULL', label: t('is null'), needsValue: false },
  { value: 'notNull', icon: '!NULL', label: t('is not null'), needsValue: false },
];

function cloneRowState(row: RowState): RowState {
  return {
    status: row.status,
    data: [...row.data],
    original: [...row.original],
    changedCols: new Set(row.changedCols),
  };
}

function getDefaultColumnFilterOperator(col?: ColumnHeader): ColumnFilterOperator {
  if (!col) return DEFAULT_COLUMN_FILTER_OPERATOR;
  const normalizedType = (col.normalizedType || '').toLowerCase();
  const rawType = `${col.rawType || ''} ${col.type || ''}`.toLowerCase();

  if (
    normalizedType === 'datetime' ||
    normalizedType === 'timestamp' ||
    rawType.includes('datetime') ||
    rawType.includes('timestamp')
  ) {
    return 'gte';
  }
  if (normalizedType === 'date' || /\bdate\b/.test(rawType)) {
    return 'eq';
  }
  if (normalizedType === 'uuid' || rawType.includes('uuid')) {
    return 'eq';
  }
  if (
    normalizedType === 'integer' ||
    normalizedType === 'float' ||
    normalizedType === 'decimal' ||
    /\b(int|integer|tinyint|smallint|mediumint|bigint|number|numeric|decimal|float|double|real|money|year)\b/.test(rawType)
  ) {
    return 'gt';
  }
  return 'like';
}

function parseColumnFilterInputShortcut(
  rawValue: string,
  previousShortcut?: string,
): { operator: ColumnFilterOperator; value: string; shortcut: string } | null {
  if (rawValue === '=' && previousShortcut === '>') {
    return { operator: 'gte', value: '', shortcut: '>=' };
  }
  if (rawValue === '=' && previousShortcut === '<') {
    return { operator: 'lte', value: '', shortcut: '<=' };
  }
  if (rawValue === '=' && (previousShortcut === '>=' || previousShortcut === '<=')) {
    return { operator: 'eq', value: '', shortcut: '=' };
  }

  const shortcuts: Array<[string, ColumnFilterOperator]> = [
    ['>=', 'gte'],
    ['<=', 'lte'],
    ['!=', 'neq'],
    ['<>', 'neq'],
    ['==', 'eq'],
    ['>', 'gt'],
    ['<', 'lt'],
    ['=', 'eq'],
    ['~', 'like'],
    ['^', 'startsWith'],
    ['$', 'endsWith'],
  ];
  const match = shortcuts.find(([shortcut]) => rawValue.startsWith(shortcut));
  if (!match) return null;
  const [shortcut, operator] = match;
  return { operator, value: rawValue.slice(shortcut.length).replace(/^\s+/, ''), shortcut };
}

function valueToText(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') {
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
  }
  const text = String(value);
  const trimmed = text.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try { return JSON.stringify(JSON.parse(trimmed), null, 2); } catch {}
  }
  return text;
}

function isColumnFilterActive(filter?: ColumnFilterState): boolean {
  if (!filter) return false;
  const operator = filter.operator || DEFAULT_COLUMN_FILTER_OPERATOR;
  if (operator === 'empty' || operator === 'notEmpty' || operator === 'null' || operator === 'notNull') return true;
  return filter.value.trim() !== '';
}

function matchesColumnFilter(value: unknown, filter: ColumnFilterState, matchCase: boolean): boolean {
  const operator = filter.operator || DEFAULT_COLUMN_FILTER_OPERATOR;
  const isEmpty = value === null || value === undefined || String(value) === '';
  if (operator === 'null') return value === null || value === undefined;
  if (operator === 'notNull') return value !== null && value !== undefined;
  if (operator === 'empty') return isEmpty;
  if (operator === 'notEmpty') return !isEmpty;
  if (isEmpty) return false;

  const needleRaw = filter.value.trim();
  if (!needleRaw) return true;
  const valueText = String(value);
  const haystack = matchCase ? valueText : valueText.toLowerCase();
  const needle = matchCase ? needleRaw : needleRaw.toLowerCase();

  switch (operator) {
    case 'like': return haystack.includes(needle);
    case 'startsWith': return haystack.startsWith(needle);
    case 'endsWith': return haystack.endsWith(needle);
    case 'eq': return haystack === needle;
    case 'neq': return haystack !== needle;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const valueNumber = typeof value === 'number' ? value : Number(valueText);
      const needleNumber = Number(needleRaw);
      if (!Number.isNaN(valueNumber) && !Number.isNaN(needleNumber)) {
        if (operator === 'gt') return valueNumber > needleNumber;
        if (operator === 'gte') return valueNumber >= needleNumber;
        if (operator === 'lt') return valueNumber < needleNumber;
        return valueNumber <= needleNumber;
      }
      const cmp = valueText.localeCompare(needleRaw, undefined, { numeric: true });
      if (operator === 'gt') return cmp > 0;
      if (operator === 'gte') return cmp >= 0;
      if (operator === 'lt') return cmp < 0;
      return cmp <= 0;
    }
    default:
      return true;
  }
}

function readPersistedGridState(): GridPersistedState {
  try {
    return getState<GridPersistedState>() || {};
  } catch {
    return {};
  }
}

function getColumnLayoutKey(col: ColumnHeader): string {
  return col.name;
}

function buildColumnLayoutFromPersisted(columns: ColumnHeader[], persisted?: GridPersistedState['columnLayout']) {
  const keys = columns.map(getColumnLayoutKey);
  if (!persisted?.autoApply) {
    return { order: keys, hidden: new Set<string>(), autoApply: !!persisted?.autoApply };
  }
  const available = new Set(keys);
  const order = [
    ...(persisted.order || []).filter(key => available.has(key)),
    ...keys.filter(key => !(persisted.order || []).includes(key)),
  ];
  const hidden = new Set((persisted.hidden || []).filter(key => available.has(key)));
  return { order, hidden, autoApply: true };
}

function columnFilterKey(filters: Record<number, ColumnFilterState>): string {
  return Object.entries(filters)
    .filter(([, filter]) => isColumnFilterActive(filter))
    .map(([column, filter]) => `${column}:${filter.operator}:${filter.value.trim()}`)
    .sort()
    .join('|');
}

/**
 * Header hints use a custom tooltip because the native `title` attribute has no
 * configurable delay — the browser/OS decides when it shows up (typically ~1s+).
 */
const HEADER_TOOLTIP_DELAY_MS = 500;
/** The tooltip is clamped to this width so it stays inside the viewport. */
const HEADER_TOOLTIP_MAX_WIDTH = 380;

interface HeaderTooltipState {
  text: string;
  left: number;
  top: number;
}

/**
 * Header tooltip: the column comment first (when the catalog provides one),
 * then the interaction hint on the next line.
 */
function buildColumnTooltip(col: ColumnHeader): string {
  const hint = `${col.name} (${col.type}) — Click to select column, Ctrl+click sort to multi-sort`;
  const comment = typeof col.comment === 'string' ? col.comment.trim() : '';
  return comment ? `${comment}\n${hint}` : hint;
}

export default function DataGrid({ instanceId = 'default' }: { instanceId?: string }) {
  // Every message is tagged with the tab instance so the extension can route
  // responses back to the grid that asked for them.
  const post = useCallback((message: any) => postRaw({ ...message, instanceId }), [instanceId]);

  const [result, setResult] = useState<QueryResult | null>(null);
  const [awaitingInitialResult, setAwaitingInitialResult] = useState(true);
  const [rows, setRows] = useState<RowState[]>([]);
  const [sortStates, setSortStates] = useState<SortState[]>([]);
  const [filterText, setFilterText] = useState('');
  const [rowFilterApplying, setRowFilterApplying] = useState(false);
  const [showColumnFilters, setShowColumnFilters] = useState(() => !!readPersistedGridState().showColumnFilters);
  const [columnOrder, setColumnOrder] = useState<string[]>(() => readPersistedGridState().columnLayout?.order || []);
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(() => new Set(readPersistedGridState().columnLayout?.hidden || []));
  const [autoApplyColumnLayout, setAutoApplyColumnLayout] = useState(() => !!readPersistedGridState().columnLayout?.autoApply);
  const [showColumnMenu, setShowColumnMenu] = useState(false);
  const [draftColumnFilters, setDraftColumnFilters] = useState<Record<number, ColumnFilterState>>({});
  const [columnFilters, setColumnFilters] = useState<Record<number, ColumnFilterState>>({});
  const [whereFilter, setWhereFilter] = useState('');
  const [showWhereInput, setShowWhereInput] = useState(false);
  const [filterMatchCase, setFilterMatchCase] = useState(false);
  const [filterUseRegex, setFilterUseRegex] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [hasMore, setHasMore] = useState(false); // limit+1 trick: server says there are more rows
  const [loadingRows, setLoadingRows] = useState(false);
  const [selectedRow, setSelectedRow] = useState(-1);
  const [selectedCol, setSelectedCol] = useState(-1);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [selectionStart, setSelectionStart] = useState<{ row: number; col: number } | null>(null);
  const [selectionEnd, setSelectionEnd] = useState<{ row: number; col: number } | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [totalRows, setTotalRows] = useState<number | null>(null);
  const [editingCell, setEditingCell] = useState<{ row: number; col: number } | null>(null);
  const [editValue, setEditValue] = useState('');
  const [undoStack, setUndoStack] = useState<UndoAction[]>([]);
  const [redoStack, setRedoStack] = useState<UndoAction[]>([]);
  const [tableName, setTableName] = useState<string>('');
  const [filterInput, setFilterInput] = useState('');
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [copyStatus, setCopyStatus] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [csvMenuOpen, setCsvMenuOpen] = useState(false);
  const [verticalView, setVerticalView] = useState(false);
  const [logEntries, setLogEntries] = useState<GridLogEntry[]>([]);
  const [showLogDrawer, setShowLogDrawer] = useState(false);
  const [selectedLogId, setSelectedLogId] = useState<number | null>(null);
  const [showQuickViewSidebar, setShowQuickViewSidebar] = useState(false);
  const [quickViewData, setQuickViewData] = useState<QuickViewState | null>(null);
  const [quickViewRowIdx, setQuickViewRowIdx] = useState<number | null>(null);
  const [quickViewWidth, setQuickViewWidth] = useState<number | null>(() => readPersistedGridState().quickViewWidth ?? null);
  const [resizingQuickView, setResizingQuickView] = useState(false);
  const quickViewSidebarRef = useRef<HTMLElement>(null);
  const [quickViewFilter, setQuickViewFilter] = useState('');
  const [columnLocator, setColumnLocator] = useState<{ rowVisIdx: number } | null>(null);
  const [columnLocatorQuery, setColumnLocatorQuery] = useState('');
  const [columnLocatorActive, setColumnLocatorActive] = useState(0);
  const [ctxSubmenu, setCtxSubmenu] = useState<string | null>(null);
  const [showRowActions, setShowRowActions] = useState(false);
  const [expandedQuickValue, setExpandedQuickValue] = useState<{ name: string; type: string; value: string; comment?: string } | null>(null);
  const [expandedLogQuery, setExpandedLogQuery] = useState<string | null>(null);
  const [sqlPreview, setSqlPreview] = useState<SqlPreviewState>({ open: false, loading: false, sql: '', count: 0 });
  const [viewMode, setViewMode] = useState<GridViewMode>('table');
  const [ddlText, setDdlText] = useState('');
  const [ddlLoading, setDdlLoading] = useState(false);
  const editInputRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const csvMenuRef = useRef<HTMLDivElement>(null);
  const columnMenuRef = useRef<HTMLDivElement>(null);
  const hasDeletedRef = useRef(false);
  const filterTextRef = useRef('');
  const columnFilterShortcutRef = useRef<Record<number, string>>({});
  const escStateRef = useRef<{ target: 'filter' | 'quickview' | null; count: number; time: number }>({ target: null, count: 0, time: 0 });
  const [headerTooltip, setHeaderTooltip] = useState<HeaderTooltipState | null>(null);
  const headerTooltipTimerRef = useRef<number | undefined>(undefined);

  function addLog(level: GridLogEntry['level'], message: string, query?: string) {
    const entry: GridLogEntry = {
      id: Date.now() + Math.random(),
      time: new Date().toLocaleTimeString(),
      level,
      message,
      query,
    };
    setLogEntries(prev => [entry, ...prev].slice(0, 100));
    setSelectedLogId(prev => prev ?? entry.id);
  }

  function showStatus(kind: 'success' | 'error' | 'info', text: string, query?: string) {
    setCopyStatus({ kind, text });
    addLog(kind === 'info' ? 'info' : kind, text, query);
    setTimeout(() => setCopyStatus(null), 1800);
  }

  useEffect(() => {
    try {
      setState<GridPersistedState>({
        showColumnFilters,
        columnLayout: autoApplyColumnLayout
          ? { order: columnOrder, hidden: Array.from(hiddenColumns), autoApply: true }
          : { autoApply: false },
        quickViewWidth: quickViewWidth ?? undefined,
      });
    } catch {}
  }, [showColumnFilters, columnOrder, hiddenColumns, autoApplyColumnLayout, quickViewWidth]);

  useEffect(() => {
    filterTextRef.current = filterText;
  }, [filterText]);

  useEffect(() => {
    const timer = window.setTimeout(() => setAwaitingInitialResult(false), 1200);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    post({ type: 'ready' });
    const unsub = onMessage((msg: any) => {
      // Only handle messages addressed to this grid instance.
      if (msg?.instanceId !== instanceId) { return; }
      if (msg.type === 'queryResult') {
        setAwaitingInitialResult(false);
        const r = msg.data as QueryResult;
        setResult(r);
        if (r.columns.length > 0) {
          const persistedLayout = readPersistedGridState().columnLayout;
          const nextLayout = buildColumnLayoutFromPersisted(r.columns, persistedLayout);
          setColumnOrder(nextLayout.order);
          setHiddenColumns(nextLayout.hidden);
          setAutoApplyColumnLayout(nextLayout.autoApply);
        }
        setTableName(msg.tableName || '');
        const nextPageSize = msg.pageSize || DEFAULT_PAGE_SIZE;
        const nextHasMore = !!msg.hasMore;
        const nextLoadingRows = !!msg.loadingRows;
        setPageSize(nextPageSize);
        setRows(r.rows.map(row => ({
          status: 'unchanged', data: [...row], original: [...row], changedCols: new Set(),
        })));
        setPage(0);
        setSortStates([]);
        setSelectedRow(-1);
        setSelectedCol(-1);
        setSelectedRows(new Set());
        setSelectionStart(null);
        setSelectionEnd(null);
        setTotalRows(msg.tableName && !nextHasMore ? r.rows.length : null);
        setHasMore(nextHasMore);
        setLoadingRows(nextLoadingRows);
        setFilterText('');
        filterTextRef.current = '';
        setFilterInput('');
        setRowFilterApplying(false);
        setDraftColumnFilters({});
        setColumnFilters({});
        setFilterMatchCase(false);
        setFilterUseRegex(false);
        setViewMode('table');
        setDdlText('');
        setDdlLoading(false);
        hasDeletedRef.current = false;
        columnFilterShortcutRef.current = {};
        setUndoStack([]);
        setRedoStack([]);
        if (nextLoadingRows) {
          addLog('info', 'Loading table rows...', msg.querySql);
        } else {
          addLog('success', `Loaded ${r.rows.length.toLocaleString()} row${r.rows.length === 1 ? '' : 's'} in ${r.executionTime}ms`, msg.querySql);
        }
      } else if (msg.type === 'pageData') {
        setAwaitingInitialResult(false);
        const r = msg.data as QueryResult;
        const nextPageSize = msg.pageSize || pageSize || DEFAULT_PAGE_SIZE;
        const nextHasMore = !!msg.hasMore;
        setResult(r);
        setPageSize(nextPageSize);
        setLoadingRows(false);
        setRows(r.rows.map(row => ({
          status: 'unchanged', data: [...row], original: [...row], changedCols: new Set(),
        })));
        setPage(msg.page);
        setHasMore(nextHasMore);
        if (msg.totalRows !== undefined) {
          setTotalRows(msg.totalRows);
        } else if (!nextHasMore) {
          setTotalRows((msg.page * nextPageSize) + r.rows.length);
        }
        if (msg.sortStates !== undefined) {
          setSortStates(msg.sortStates || []);
        }
        if (filterTextRef.current) {
          setRowFilterApplying(true);
        }
        setSelectedRow(-1);
        setSelectedCol(-1);
        setSelectedRows(new Set());
        setSelectionStart(null);
        setSelectionEnd(null);
        addLog('success', `Loaded page ${msg.page + 1}: ${r.rows.length.toLocaleString()} row${r.rows.length === 1 ? '' : 's'} in ${r.executionTime}ms`, msg.querySql);
      } else if (msg.type === 'totalRowsCount') {
        setTotalRows(msg.data.totalRows);
        addLog('info', `Counted ${Number(msg.data.totalRows).toLocaleString()} total row${msg.data.totalRows === 1 ? '' : 's'}`, msg.querySql);
      } else if (msg.type === 'rowSelected') {
        // Quick View auto-updated by extension, no local state change needed
      } else if (msg.type === 'copyResult') {
        showStatus(msg.success ? 'success' : 'error', msg.message || (msg.success ? t('Copied') : t('Copy failed')));
      } else if (msg.type === 'ddlData') {
        setDdlText(msg.data.ddl || '');
        setDdlLoading(false);
        addLog('info', 'Loaded table DDL');
      } else if (msg.type === 'previewSQLResult') {
        const sql = msg.data?.sql || '';
        const count = Number(msg.data?.count || 0);
        setSqlPreview({ open: true, loading: false, sql, count });
        addLog('info', count > 0 ? `Previewed ${count} SQL change${count === 1 ? '' : 's'}` : 'No SQL changes to preview', sql || undefined);
      } else if (msg.type === 'previewSQLError') {
        const error = msg.data?.message || 'Failed to preview SQL';
        setSqlPreview({ open: true, loading: false, sql: '', count: 0, error });
        addLog('error', error, msg.querySql || msg.data?.querySql);
      } else if (msg.type === 'error') {
        setAwaitingInitialResult(false);
        setDdlLoading(false);
        setLoadingRows(false);
        showStatus('error', msg.data?.message || t('Data grid error'), msg.querySql || msg.data?.querySql);
      }
    });
    return unsub;
  }, [pageSize, instanceId, post]);

  useEffect(() => {
    if (editingCell && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingCell]);

  // Close menus on outside pointer interactions, even when table cells stop click bubbling.
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest('.context-menu')) {
        setContextMenu(null);
      }
      if (csvMenuRef.current && !csvMenuRef.current.contains(event.target as Node)) {
        setCsvMenuOpen(false);
      }
      if (columnMenuRef.current && !columnMenuRef.current.contains(event.target as Node)) {
        setShowColumnMenu(false);
      }
    };
    window.addEventListener('pointerdown', handlePointerDown, true);
    return () => window.removeEventListener('pointerdown', handlePointerDown, true);
  }, []);

  const hasChanges = rows.some(r => r.status !== 'unchanged');
  const changeStats = useMemo(() => ({
    modified: rows.filter(r => r.status === 'modified').length,
    added: rows.filter(r => r.status === 'added').length,
    deleted: rows.filter(r => r.status === 'deleted').length,
  }), [rows]);

  // Sort state for primary sort column (for backward compat)
  const sortState = sortStates.length > 0 ? sortStates[0] : null;
  const activeColumnFilters = useMemo(
    () => Object.entries(columnFilters)
      .map(([column, filter]) => ({ column: Number(column), filter }))
      .filter(({ filter }) => isColumnFilterActive(filter)),
    [columnFilters],
  );
  const sqlColumnFilters = useMemo(() => activeColumnFilters.map(({ column, filter }) => ({
    column,
    operator: filter.operator,
    value: filter.value,
  })), [activeColumnFilters]);
  const clientColumnFilters = tableName ? [] : activeColumnFilters;
  const columnKeys = useMemo(() => result?.columns.map(getColumnLayoutKey) || [], [result]);
  const orderedColumnKeys = useMemo(() => {
    const available = new Set(columnKeys);
    const seen = new Set<string>();
    const ordered = columnOrder.filter(key => {
      if (!available.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    for (const key of columnKeys) {
      if (!seen.has(key)) ordered.push(key);
    }
    return ordered;
  }, [columnKeys, columnOrder]);
  const visibleColumnIndices = useMemo(() => {
    const keyToIndex = new Map(columnKeys.map((key, idx) => [key, idx]));
    return orderedColumnKeys
      .filter(key => !hiddenColumns.has(key))
      .map(key => keyToIndex.get(key))
      .filter((idx): idx is number => idx !== undefined);
  }, [columnKeys, hiddenColumns, orderedColumnKeys]);
  const columnLayoutItems = useMemo(() => {
    const keyToIndex = new Map(columnKeys.map((key, idx) => [key, idx]));
    return orderedColumnKeys
      .map(key => {
        const idx = keyToIndex.get(key);
        if (idx === undefined || !result) return null;
        return { key, idx, col: result.columns[idx], visible: !hiddenColumns.has(key) };
      })
      .filter((item): item is { key: string; idx: number; col: ColumnHeader; visible: boolean } => item !== null);
  }, [columnKeys, hiddenColumns, orderedColumnKeys, result]);
  const visibleColumnCount = visibleColumnIndices.length;

  const filteredSortedIndices = useMemo(() => {
    const hasDeleted = hasDeletedRef.current;
    if (!filterText && clientColumnFilters.length === 0 && (!sortStates.length || tableName) && !hasDeleted) {
      return null;
    }

    let indices: number[] = [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].status !== 'deleted') {
        indices.push(i);
      }
    }

    if (filterText) {
      let matcher: (value: unknown) => boolean;
      if (filterUseRegex) {
        try {
          const regex = new RegExp(filterText, filterMatchCase ? '' : 'i');
          matcher = value => value !== null && value !== undefined && regex.test(String(value));
        } catch {
          matcher = () => false;
        }
      } else if (filterMatchCase) {
        matcher = value => value !== null && value !== undefined && String(value).includes(filterText);
      } else {
        const lower = filterText.toLowerCase();
        matcher = value => value !== null && value !== undefined && String(value).toLowerCase().includes(lower);
      }
      indices = indices.filter(idx => rows[idx].data.some(matcher));
    }

    if (clientColumnFilters.length > 0) {
      indices = indices.filter(idx => clientColumnFilters.every(({ column, filter }) =>
        matchesColumnFilter(rows[idx].data[column], filter, filterMatchCase),
      ));
    }

    if (sortStates.length > 0 && !tableName) {
      indices.sort((a, b) => {
        for (const { column, direction } of sortStates) {
          const va = rows[a].data[column], vb = rows[b].data[column];
          if (va === null && vb === null) continue;
          if (va === null) return 1;
          if (vb === null) return -1;
          const cmp = typeof va === 'number' && typeof vb === 'number'
            ? va - vb
            : String(va).localeCompare(String(vb), undefined, { numeric: true });
          if (cmp !== 0) return direction === 'asc' ? cmp : -cmp;
        }
        return 0;
      });
    }

    return indices;
  }, [rows, filterText, filterMatchCase, filterUseRegex, clientColumnFilters, sortStates, tableName]);

  const visibleRowsCount = useMemo(() => {
    if (filteredSortedIndices !== null) {
      return filteredSortedIndices.length;
    }
    return rows.filter(r => r.status !== 'deleted').length;
  }, [rows, filteredSortedIndices]);
  const activeColumnFilterCount = activeColumnFilters.length;

  useEffect(() => {
    if (!rowFilterApplying) return;
    const timer = window.setTimeout(() => setRowFilterApplying(false), 120);
    return () => window.clearTimeout(timer);
  }, [rowFilterApplying, visibleRowsCount]);

  const totalPages = tableName
    ? (totalRows !== null ? Math.max(1, Math.ceil(totalRows / pageSize)) : null)
    : Math.max(1, Math.ceil(visibleRowsCount / pageSize));

  const pageRows = useMemo(() => {
    if (tableName) {
      if (filteredSortedIndices !== null) {
        return filteredSortedIndices.map(origIdx => ({ row: rows[origIdx], origIdx }));
      }
      return rows.map((row, idx) => ({ row, origIdx: idx }));
    }
    const start = page * pageSize;
    const end = Math.min(start + pageSize, visibleRowsCount);
    const resultList: { row: RowState; origIdx: number }[] = [];

    if (filteredSortedIndices !== null) {
      for (let i = start; i < end; i++) {
        const origIdx = filteredSortedIndices[i];
        resultList.push({ row: rows[origIdx], origIdx });
      }
    } else {
      // Skip deleted rows inline
      let count = 0;
      let absIdx = 0;
      const target_start = start;
      const target_end = end;
      for (let i = 0; i < rows.length && count < target_end; i++) {
        if (rows[i].status === 'deleted') continue;
        if (count >= target_start) {
          resultList.push({ row: rows[i], origIdx: i });
        }
        count++;
      }
    }
    return resultList;
  }, [rows, page, filteredSortedIndices, visibleRowsCount, tableName, pageSize]);

  const pushUndo = useCallback((action: UndoAction) => {
    setUndoStack(prev => [...prev, action]);
    setRedoStack([]);
  }, []);

  // ── Cell Editing ──
  const startEdit = useCallback((visIdx: number, colIdx: number) => {
    const item = pageRows[visIdx];
    if (!item || !result) return;
    const val = item.row.data[colIdx];
    setEditingCell({ row: visIdx, col: colIdx });
    setEditValue(val === null ? '' : String(val));
  }, [pageRows, result]);

  const commitEdit = useCallback(() => {
    if (!editingCell || !result) return;
    const item = pageRows[editingCell.row];
    if (!item) { setEditingCell(null); return; }
    const colIdx = editingCell.col;
    const oldValue = item.row.data[colIdx];
    let newValue: unknown = editValue;

    const ntype = result.columns[colIdx]?.normalizedType;
    if (newValue !== '' && (ntype === 'integer' || ntype === 'float' || ntype === 'decimal')) {
      const num = Number(newValue);
      if (!isNaN(num)) newValue = num;
    }
    if (newValue !== '' && ntype === 'boolean') {
      newValue = newValue === 'true' || newValue === '1' || newValue === true;
    }

    if (oldValue !== newValue) {
      const origIdx = item.origIdx;
      pushUndo({ type: 'edit', rowIndex: origIdx, colIndex: colIdx, oldValue, newValue });
      setRows(prev => {
        const next = [...prev];
        const r = { ...next[origIdx], data: [...next[origIdx].data], changedCols: new Set(next[origIdx].changedCols) };
        r.data[colIdx] = newValue;
        if (r.status !== 'added') {
          if (newValue === r.original[colIdx]) r.changedCols.delete(colIdx);
          else r.changedCols.add(colIdx);
          r.status = r.changedCols.size > 0 ? 'modified' : 'unchanged';
        }
        next[origIdx] = r;
        return next;
      });
    }
    setEditingCell(null);
  }, [editingCell, editValue, pageRows, result, pushUndo]);

  const cancelEdit = useCallback(() => setEditingCell(null), []);

  // ── Row Operations ──
  const addRow = useCallback(() => {
    if (!result) return;
    const newData = result.columns.map(() => null);
    const newRow: RowState = { status: 'added', data: newData, original: [], changedCols: new Set() };

    let insertIdx = 0;
    if (tableName) {
      insertIdx = 0;
    } else if (filteredSortedIndices !== null) {
      const pageStart = page * pageSize;
      if (pageStart < filteredSortedIndices.length) {
        insertIdx = filteredSortedIndices[pageStart];
      } else {
        insertIdx = rows.length;
      }
    } else {
      insertIdx = page * pageSize;
    }

    setRows(prev => {
      pushUndo({ type: 'addRow', rowIndex: insertIdx });
      const next = [...prev];
      next.splice(insertIdx, 0, newRow);
      return next;
    });
    setSelectedRow(0);
  }, [result, page, pageSize, rows, filteredSortedIndices, tableName, pushUndo]);

  const deleteRows = useCallback((visIdxs: number[]) => {
    const items = Array.from(new Set(visIdxs))
      .map(visIdx => pageRows[visIdx])
      .filter((item): item is { row: RowState; origIdx: number } => !!item)
      .sort((a, b) => b.origIdx - a.origIdx);
    if (items.length === 0) return;

    setRows(prev => {
      const next = [...prev];
      const undoActions: UndoAction[] = [];

      for (const item of items) {
        const current = next[item.origIdx];
        if (!current) continue;
        undoActions.push({ type: 'deleteRow', rowIndex: item.origIdx, row: cloneRowState(current) });
        if (current.status === 'added') {
          next.splice(item.origIdx, 1);
        } else {
          next[item.origIdx] = { ...current, status: 'deleted' };
          hasDeletedRef.current = true;
        }
      }

      if (undoActions.length > 0) {
        setUndoStack(prevUndo => [...prevUndo, ...undoActions]);
        setRedoStack([]);
      }
      return next;
    });
    setSelectedRows(new Set());
  }, [pageRows]);

  const deleteRow = useCallback((visIdx: number) => {
    deleteRows([visIdx]);
  }, [deleteRows]);

  const duplicateRow = useCallback((visIdx: number) => {
    const item = pageRows[visIdx];
    if (!item || !result) return;
    const newData = [...item.row.data];
    result.columns.forEach((col, i) => { if (col.isPrimaryKey || col.isAutoIncrement) newData[i] = null; });
    const newRow: RowState = { status: 'added', data: newData, original: [], changedCols: new Set() };
    setRows(prev => {
      const insertAt = item.origIdx + 1;
      pushUndo({ type: 'duplicateRow', rowIndex: insertAt });
      const next = [...prev]; next.splice(insertAt, 0, newRow); return next;
    });
  }, [pageRows, result, pushUndo]);

  // ── Undo / Redo ──
  const undo = useCallback(() => {
    setUndoStack(prev => {
      if (prev.length === 0) return prev;
      const action = prev[prev.length - 1];
      const next = prev.slice(0, -1);
      setRedoStack(r => [...r, action]);
      setRows(rw => {
        const nr = [...rw];
        switch (action.type) {
          case 'edit': {
            const r = { ...nr[action.rowIndex], data: [...nr[action.rowIndex].data], changedCols: new Set(nr[action.rowIndex].changedCols) };
            r.data[action.colIndex] = action.oldValue;
            if (r.status !== 'added') {
              if (action.oldValue === r.original[action.colIndex]) r.changedCols.delete(action.colIndex);
              else r.changedCols.add(action.colIndex);
              r.status = r.changedCols.size > 0 ? 'modified' : 'unchanged';
            }
            nr[action.rowIndex] = r;
            break;
          }
          case 'addRow': case 'duplicateRow':
            nr.splice(action.rowIndex, 1);
            break;
          case 'deleteRow':
            if (action.row.status === 'added') nr.splice(action.rowIndex, 0, action.row);
            else { nr[action.rowIndex] = { ...action.row }; }
            break;
        }
        return nr;
      });
      return next;
    });
  }, []);

  const redo = useCallback(() => {
    setRedoStack(prev => {
      if (prev.length === 0) return prev;
      const action = prev[prev.length - 1];
      const next = prev.slice(0, -1);
      setUndoStack(u => [...u, action]);
      setRows(rw => {
        const nr = [...rw];
        switch (action.type) {
          case 'edit': {
            const r = { ...nr[action.rowIndex], data: [...nr[action.rowIndex].data], changedCols: new Set(nr[action.rowIndex].changedCols) };
            r.data[action.colIndex] = action.newValue;
            if (r.status !== 'added') {
              if (action.newValue === r.original[action.colIndex]) r.changedCols.delete(action.colIndex);
              else r.changedCols.add(action.colIndex);
              r.status = r.changedCols.size > 0 ? 'modified' : 'unchanged';
            }
            nr[action.rowIndex] = r;
            break;
          }
          case 'addRow': {
            const newData = result?.columns.map(() => null) || [];
            nr.splice(action.rowIndex, 0, { status: 'added', data: newData, original: [], changedCols: new Set() });
            break;
          }
          case 'duplicateRow':
            nr.splice(action.rowIndex, 0, { status: 'added', data: [...(nr[action.rowIndex - 1]?.data || [])], original: [], changedCols: new Set() });
            break;
          case 'deleteRow':
            if (nr[action.rowIndex]?.status === 'added') nr.splice(action.rowIndex, 1);
            else if (nr[action.rowIndex]) {
              nr[action.rowIndex] = { ...nr[action.rowIndex], status: 'deleted' };
              hasDeletedRef.current = true;
            }
            break;
        }
        return nr;
      });
      return next;
    });
  }, [result]);

  // ── Save / Discard ──
  const handleSave = useCallback(() => {
    post({ type: 'saveChanges', data: { rows: rows.map(r => ({ status: r.status, data: r.data, original: r.original, changedCols: Array.from(r.changedCols) })) } });
  }, [rows]);

  const handleDiscard = useCallback(() => {
    setRows(prev => prev.filter(r => r.status !== 'added').map(r => ({
      status: 'unchanged' as const, data: [...r.original], original: [...r.original], changedCols: new Set<number>(),
    })));
    hasDeletedRef.current = false;
    setUndoStack([]); setRedoStack([]);
  }, []);

  const handlePreviewSQL = useCallback(() => {
    setSqlPreview({ open: true, loading: true, sql: '', count: 0 });
    post({ type: 'previewSQL', data: { rows: rows.map(r => ({ status: r.status, data: r.data, original: r.original, changedCols: Array.from(r.changedCols) })) } });
  }, [rows]);

  // ── Reload ──
  const handleReload = useCallback(() => {
    if (tableName) {
      setTotalRows(null);
      setLoadingRows(true);
      if (filterText) setRowFilterApplying(true);
      post({ type: 'fetchPage', data: { page, sortStates, whereFilter: whereFilter || undefined, columnFilters: sqlColumnFilters } });
    } else {
      post({ type: 'reload' });
    }
  }, [tableName, page, sortStates, whereFilter, sqlColumnFilters, filterText]);

  // ── Where Filter ──
  const handleApplyWhere = useCallback(() => {
    if (tableName) {
      setLoadingRows(true);
      post({ type: 'fetchPage', data: { page: 0, sortStates, whereFilter: whereFilter || undefined, columnFilters: sqlColumnFilters } });
    }
    setPage(0);
  }, [tableName, sortStates, whereFilter, sqlColumnFilters]);

  const applyRowFilter = useCallback(() => {
    if (filterInput === filterText) return;
    setRowFilterApplying(true);
    setFilterText(filterInput);
    filterTextRef.current = filterInput;
    setPage(0);
  }, [filterInput, filterText]);

  const serializeSqlColumnFilters = useCallback((filters: Record<number, ColumnFilterState>) => Object.entries(filters)
    .map(([column, filter]) => ({ column: Number(column), operator: filter.operator, value: filter.value }))
    .filter(({ operator, value }) => isColumnFilterActive({ operator, value })), []);

  const applyColumnFilter = useCallback((colIdx: number, filterOverride?: ColumnFilterState) => {
    const defaultFilter = { operator: getDefaultColumnFilterOperator(result?.columns[colIdx]), value: '' };
    const nextFilter = filterOverride || draftColumnFilters[colIdx] || defaultFilter;
    const nextApplied = { ...columnFilters };
    if (isColumnFilterActive(nextFilter)) nextApplied[colIdx] = nextFilter;
    else delete nextApplied[colIdx];
    const didChange = columnFilterKey(nextApplied) !== columnFilterKey(columnFilters);
    if (!didChange) return;
    const nextSqlFilters = serializeSqlColumnFilters(nextApplied);
    setColumnFilters(nextApplied);
    setPage(0);
    if (tableName) {
      setTotalRows(null);
      setLoadingRows(true);
      post({ type: 'fetchPage', data: { page: 0, sortStates, whereFilter: whereFilter || undefined, columnFilters: nextSqlFilters } });
    }
  }, [columnFilters, draftColumnFilters, result, serializeSqlColumnFilters, tableName, sortStates, whereFilter]);

  const updateColumnFilter = useCallback((colIdx: number, patch: Partial<ColumnFilterState>) => {
    const defaultFilter = { operator: getDefaultColumnFilterOperator(result?.columns[colIdx]), value: '' };
    const current = draftColumnFilters[colIdx] || columnFilters[colIdx] || defaultFilter;
    const nextFilter = { ...current, ...patch };
    setDraftColumnFilters(prev => ({ ...prev, [colIdx]: nextFilter }));
    const currentMeta = COLUMN_FILTER_OPERATORS.find(op => op.value === current.operator);
    const operatorMeta = COLUMN_FILTER_OPERATORS.find(op => op.value === nextFilter.operator);
    if (operatorMeta?.needsValue === false || (patch.operator && currentMeta?.needsValue === false)) {
      applyColumnFilter(colIdx, nextFilter);
    }
  }, [applyColumnFilter, columnFilters, draftColumnFilters, result]);

  const handleColumnFilterInputChange = useCallback((colIdx: number, rawValue: string) => {
    const shortcut = parseColumnFilterInputShortcut(rawValue, columnFilterShortcutRef.current[colIdx]);
    if (shortcut) {
      if (shortcut.value === '') columnFilterShortcutRef.current[colIdx] = shortcut.shortcut;
      else delete columnFilterShortcutRef.current[colIdx];
      updateColumnFilter(colIdx, { operator: shortcut.operator, value: shortcut.value });
      return;
    }
    delete columnFilterShortcutRef.current[colIdx];
    updateColumnFilter(colIdx, { value: rawValue });
  }, [updateColumnFilter]);

  const clearColumnFilters = useCallback(() => {
    columnFilterShortcutRef.current = {};
    setDraftColumnFilters({});
    setColumnFilters({});
    setPage(0);
    if (tableName) {
      setTotalRows(null);
      setLoadingRows(true);
      post({ type: 'fetchPage', data: { page: 0, sortStates, whereFilter: whereFilter || undefined, columnFilters: [] } });
    }
  }, [tableName, sortStates, whereFilter]);

  const moveColumnLayoutItem = useCallback((key: string, direction: -1 | 1) => {
    setColumnOrder(prev => {
      const base = orderedColumnKeys.length > 0 ? [...orderedColumnKeys] : [...prev];
      const index = base.indexOf(key);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= base.length) return prev;
      const next = [...base];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  }, [orderedColumnKeys]);

  const toggleColumnVisibility = useCallback((key: string) => {
    setHiddenColumns(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const resetColumnLayout = useCallback(() => {
    const keys = result?.columns.map(getColumnLayoutKey) || [];
    setColumnOrder(keys);
    setHiddenColumns(new Set());
  }, [result]);

  // ── Range Selection ──
  const isCellInRange = useCallback((row: number, col: number) => {
    if (!selectionStart || !selectionEnd) return false;
    const minRow = Math.min(selectionStart.row, selectionEnd.row);
    const maxRow = Math.max(selectionStart.row, selectionEnd.row);
    const minCol = Math.min(selectionStart.col, selectionEnd.col);
    const maxCol = Math.max(selectionStart.col, selectionEnd.col);
    return row >= minRow && row <= maxRow && col >= minCol && col <= maxCol;
  }, [selectionStart, selectionEnd]);

  const getSelectionBounds = useCallback((fallbackVisIdx?: number, fallbackColIdx?: number) => {
    if (selectionStart && selectionEnd) {
      return {
        startRow: Math.min(selectionStart.row, selectionEnd.row),
        endRow: Math.max(selectionStart.row, selectionEnd.row),
        startCol: Math.min(selectionStart.col, selectionEnd.col),
        endCol: Math.max(selectionStart.col, selectionEnd.col),
      };
    }
    if (fallbackVisIdx !== undefined && fallbackColIdx !== undefined) {
      return { startRow: fallbackVisIdx, endRow: fallbackVisIdx, startCol: fallbackColIdx, endCol: fallbackColIdx };
    }
    if (selectedRow >= 0 && selectedCol >= 0) {
      return { startRow: selectedRow, endRow: selectedRow, startCol: selectedCol, endCol: selectedCol };
    }
    return null;
  }, [selectionStart, selectionEnd, selectedRow, selectedCol]);

  const setCellsToNull = useCallback((fallbackVisIdx?: number, fallbackColIdx?: number) => {
    if (!result) return;
    const bounds = getSelectionBounds(fallbackVisIdx, fallbackColIdx);
    if (!bounds) return;

    setRows(prev => {
      const next = [...prev];
      const undoActions: UndoAction[] = [];

      for (let r = bounds.startRow; r <= bounds.endRow; r++) {
        const item = pageRows[r];
        if (!item) continue;
        const rowState = { ...next[item.origIdx], data: [...next[item.origIdx].data], changedCols: new Set(next[item.origIdx].changedCols) };

        for (let c = bounds.startCol; c <= bounds.endCol; c++) {
          if (!result.columns[c]?.nullable) continue;
          const oldValue = rowState.data[c];
          if (oldValue === null) continue;
          undoActions.push({ type: 'edit', rowIndex: item.origIdx, colIndex: c, oldValue, newValue: null });
          rowState.data[c] = null;
          if (rowState.status !== 'added') {
            if (rowState.original[c] === null) rowState.changedCols.delete(c);
            else rowState.changedCols.add(c);
            rowState.status = rowState.changedCols.size > 0 ? 'modified' : 'unchanged';
          }
        }

        next[item.origIdx] = rowState;
      }

      if (undoActions.length > 0) {
        setUndoStack(prevUndo => [...prevUndo, ...undoActions]);
        setRedoStack([]);
      }
      return next;
    });
  }, [result, pageRows, getSelectionBounds]);

  const selectColumn = useCallback((colIdx: number) => {
    if (!result) return;
    setSelectionStart({ row: 0, col: colIdx });
    setSelectionEnd({ row: pageRows.length - 1, col: colIdx });
    setSelectedRow(0);
    setSelectedCol(colIdx);
    setSelectedRows(new Set());
  }, [result, pageRows.length]);

  const selectRowAllColumns = useCallback((rowIdx: number, e: React.MouseEvent) => {
    if (!result) return;
    if (e.ctrlKey || e.metaKey) {
      // Toggle row in multi-selection
      setSelectedRows(prev => {
        const next = new Set(prev);
        if (next.has(rowIdx)) next.delete(rowIdx);
        else next.add(rowIdx);
        return next;
      });
    } else if (e.shiftKey && selectedRow >= 0) {
      // Shift-click: select range of rows
      const minR = Math.min(selectedRow, rowIdx);
      const maxR = Math.max(selectedRow, rowIdx);
      const newSet = new Set<number>();
      for (let r = minR; r <= maxR; r++) newSet.add(r);
      setSelectedRows(newSet);
    } else {
      setSelectedRows(new Set([rowIdx]));
      setSelectionStart({ row: rowIdx, col: 0 });
      setSelectionEnd({ row: rowIdx, col: result.columns.length - 1 });
    }
    setSelectedRow(rowIdx);
    setSelectedCol(0);
  }, [result, selectedRow]);

  const handleRowClick = useCallback((visIdx: number, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      setSelectedRows(prev => {
        const next = new Set(prev);
        if (next.has(visIdx)) next.delete(visIdx);
        else next.add(visIdx);
        return next;
      });
    } else if (e.shiftKey && selectedRow >= 0) {
      const minR = Math.min(selectedRow, visIdx);
      const maxR = Math.max(selectedRow, visIdx);
      const newSet = new Set<number>();
      for (let r = minR; r <= maxR; r++) newSet.add(r);
      setSelectedRows(newSet);
    } else {
      setSelectedRows(new Set([visIdx]));
    }
    setSelectedRow(visIdx);
  }, [selectedRow]);

  const handleCellMouseDown = useCallback((row: number, col: number, e: React.MouseEvent) => {
    if (editingCell) return;
    if (e.button !== 0) return;
    // Prevent browser text selection during drag
    e.preventDefault();

    if (e.ctrlKey || e.metaKey) {
      // Ctrl/Cmd+click toggles the whole row without disturbing the cell
      // selection, so multi-row copy/delete is reachable anywhere in the grid.
      setSelectedRows(prev => {
        const next = new Set(prev);
        if (next.has(row)) next.delete(row);
        else next.add(row);
        return next;
      });
      setSelectedRow(row);
      setSelectedCol(col);
      return;
    }

    if (e.shiftKey && selectionStart) {
      // Extend selection from anchor
      setSelectionEnd({ row, col });
      setSelectedRow(row);
      setSelectedCol(col);
      setSelectedRows(new Set());
    } else {
      // Start fresh selection
      setSelectionStart({ row, col });
      setSelectionEnd({ row, col });
      setSelectedRow(row);
      setSelectedCol(col);
      setSelectedRows(new Set());
      setIsSelecting(true);
    }
  }, [editingCell, selectionStart]);

  const handleCellMouseEnter = useCallback((row: number, col: number) => {
    if (isSelecting) {
      setSelectionEnd({ row, col });
    }
  }, [isSelecting]);

  useEffect(() => {
    const handleMouseUpGlobal = () => setIsSelecting(false);
    window.addEventListener('mouseup', handleMouseUpGlobal);
    return () => window.removeEventListener('mouseup', handleMouseUpGlobal);
  }, []);

  // ── Quick View real-time update ──
  useEffect(() => {
    if (selectedRow >= 0 && selectedRow < pageRows.length) {
      const item = pageRows[selectedRow];
      if (item && result && showQuickViewSidebar) {
        setQuickViewData({ columns: result.columns, rowData: item.row.data });
        setQuickViewRowIdx(selectedRow);
      }
    }
  }, [selectedRow, pageRows, result, showQuickViewSidebar]);

  useEffect(() => {
    if (selectedCol >= 0 && visibleColumnIndices.length > 0 && !visibleColumnIndices.includes(selectedCol)) {
      const nextCol = visibleColumnIndices.find(idx => idx > selectedCol) ?? visibleColumnIndices[visibleColumnIndices.length - 1];
      setSelectedCol(nextCol);
      setSelectionStart(prev => prev ? { ...prev, col: nextCol } : prev);
      setSelectionEnd(prev => prev ? { ...prev, col: nextCol } : prev);
    }
  }, [selectedCol, visibleColumnIndices]);

  // ── Pagination ──
  const handleCountRows = useCallback(() => {
    if (tableName) post({ type: 'countRows', data: { whereFilter: whereFilter || undefined, columnFilters: sqlColumnFilters } });
  }, [tableName, whereFilter, sqlColumnFilters]);

  const handlePageChange = useCallback((nextPage: number) => {
    if (tableName) {
      setLoadingRows(true);
      if (filterText) setRowFilterApplying(true);
      post({ type: 'fetchPage', data: { page: nextPage, sortStates, whereFilter: whereFilter || undefined, columnFilters: sqlColumnFilters } });
    } else {
      setPage(nextPage);
    }
  }, [tableName, sortStates, whereFilter, sqlColumnFilters, filterText]);

  // ── Multi-Sort ──
  const toggleSort = useCallback((colIdx: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const useMulti = e.ctrlKey || e.metaKey;

    setSortStates(prev => {
      let next: SortState[];
      const existingIdx = prev.findIndex(s => s.column === colIdx);

      if (useMulti) {
        if (existingIdx >= 0) {
          const existing = prev[existingIdx];
          if (existing.direction === 'asc') {
            next = [...prev];
            next[existingIdx] = { column: colIdx, direction: 'desc' };
          } else {
            next = prev.filter((_, i) => i !== existingIdx);
          }
        } else {
          next = [...prev, { column: colIdx, direction: 'asc' }];
        }
      } else {
        if (existingIdx >= 0) {
          const existing = prev[existingIdx];
          if (existing.direction === 'asc') {
            next = [{ column: colIdx, direction: 'desc' }];
          } else {
            next = [];
          }
        } else {
          next = [{ column: colIdx, direction: 'asc' }];
        }
      }

      if (tableName) {
        setLoadingRows(true);
        if (filterText) setRowFilterApplying(true);
        post({ type: 'fetchPage', data: { page: 0, sortStates: next, whereFilter: whereFilter || undefined, columnFilters: sqlColumnFilters } });
      }
      return next;
    });
    setPage(0);
  }, [tableName, whereFilter, sqlColumnFilters, filterText]);

  // ── Paste ──
  const pasteData = useCallback((text: string) => {
    if (!result || selectedRow < 0 || selectedCol < 0) return;
    const lines = text.split(/\r?\n/);
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const gridData = lines.map(line => line.split('\t'));
    const bounds = getSelectionBounds(selectedRow, selectedCol);
    const fillRangeWithSingleCell = gridData.length === 1
      && gridData[0].length === 1
      && bounds !== null
      && (bounds.startRow !== bounds.endRow || bounds.startCol !== bounds.endCol);

    const parsePastedValue = (valStr: string, colIdx: number): unknown => {
      let newValue: unknown = valStr === 'NULL' ? null : valStr;
      const ntype = result.columns[colIdx]?.normalizedType;
      if (newValue !== null && newValue !== '' && (ntype === 'integer' || ntype === 'float' || ntype === 'decimal')) {
        const num = Number(newValue);
        if (!isNaN(num)) newValue = num;
      }
      if (newValue !== null && newValue !== '' && ntype === 'boolean') {
        newValue = newValue === 'true' || newValue === '1';
      }
      return newValue;
    };

    setRows(prev => {
      const next = [...prev];
      const undoActions: UndoAction[] = [];

      if (fillRangeWithSingleCell && bounds) {
        const valStr = gridData[0][0];
        for (let visRowIdx = bounds.startRow; visRowIdx <= bounds.endRow; visRowIdx++) {
          const item = pageRows[visRowIdx];
          if (!item) continue;
          const origIdx = item.origIdx;
          const rState = { ...next[origIdx], data: [...next[origIdx].data], changedCols: new Set(next[origIdx].changedCols) };
          for (let colIdx = bounds.startCol; colIdx <= bounds.endCol; colIdx++) {
            if (colIdx >= result.columns.length) break;
            const newValue = parsePastedValue(valStr, colIdx);
            const oldValue = rState.data[colIdx];
            if (oldValue !== newValue) {
              undoActions.push({ type: 'edit', rowIndex: origIdx, colIndex: colIdx, oldValue, newValue });
              rState.data[colIdx] = newValue;
              if (rState.status !== 'added') {
                if (newValue === rState.original[colIdx]) rState.changedCols.delete(colIdx);
                else rState.changedCols.add(colIdx);
                rState.status = rState.changedCols.size > 0 ? 'modified' : 'unchanged';
              }
            }
          }
          next[origIdx] = rState;
        }
      } else {
        for (let r = 0; r < gridData.length; r++) {
          const visRowIdx = selectedRow + r;
          if (visRowIdx >= pageRows.length) break;
          const item = pageRows[visRowIdx];
          if (!item) continue;
          const origIdx = item.origIdx;
          const rState = { ...next[origIdx], data: [...next[origIdx].data], changedCols: new Set(next[origIdx].changedCols) };
          for (let c = 0; c < gridData[r].length; c++) {
            const colIdx = selectedCol + c;
            if (colIdx >= result.columns.length) break;
            const valStr = gridData[r][c];
            const newValue = parsePastedValue(valStr, colIdx);
            const oldValue = rState.data[colIdx];
            if (oldValue !== newValue) {
              undoActions.push({ type: 'edit', rowIndex: origIdx, colIndex: colIdx, oldValue, newValue });
              rState.data[colIdx] = newValue;
              if (rState.status !== 'added') {
                if (newValue === rState.original[colIdx]) rState.changedCols.delete(colIdx);
                else rState.changedCols.add(colIdx);
                rState.status = rState.changedCols.size > 0 ? 'modified' : 'unchanged';
              }
            }
          }
          next[origIdx] = rState;
        }
      }

      if (undoActions.length > 0) {
        setUndoStack(prevUndo => [...prevUndo, ...undoActions]);
        setRedoStack([]);
      }
      return next;
    });
  }, [result, pageRows, selectedRow, selectedCol, getSelectionBounds]);

  // ── Context Menu ──
  const handleContextMenu = useCallback((e: React.MouseEvent, visIdx: number, colIdx?: number) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxSubmenu(null);

    // Right-clicking inside an existing multi-row selection keeps it, so the
    // row actions apply to every selected row instead of just this one.
    if (selectedRows.size > 1 && selectedRows.has(visIdx)) {
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        visIdx,
        colIdx,
        rowVisIdxs: Array.from(selectedRows).sort((a, b) => a - b),
      });
      return;
    }

    // A plain right-click targets the row under the cursor.
    setSelectedRows(new Set([visIdx]));

    let copyText: string | undefined;
    let copyLabel: string | undefined;
    if (colIdx !== undefined && !isCellInRange(visIdx, colIdx)) {
      setSelectionStart({ row: visIdx, col: colIdx });
      setSelectionEnd({ row: visIdx, col: colIdx });
      setSelectedRow(visIdx);
      setSelectedCol(colIdx);
      setSelectedRows(new Set());
      const cellVal = pageRows[visIdx]?.row.data[colIdx];
      copyText = cellVal === null || cellVal === undefined ? '' : String(cellVal);
      copyLabel = t('Copy cell value');
    } else if (colIdx !== undefined && selectionStart && selectionEnd) {
      const minRow = Math.min(selectionStart.row, selectionEnd.row);
      const maxRow = Math.max(selectionStart.row, selectionEnd.row);
      const minCol = Math.min(selectionStart.col, selectionEnd.col);
      const maxCol = Math.max(selectionStart.col, selectionEnd.col);
      const lines: string[] = [];
      for (let r = minRow; r <= maxRow; r++) {
        const rowCells: string[] = [];
        for (let c = minCol; c <= maxCol; c++) {
          const cellVal = pageRows[r]?.row.data[c];
          rowCells.push(cellVal === null || cellVal === undefined ? '' : String(cellVal));
        }
        lines.push(rowCells.join('\t'));
      }
      copyText = lines.join('\n');
      copyLabel = minRow === maxRow && minCol === maxCol ? t('Copy cell value') : t('Copy selected range');
    }
    setContextMenu({ x: e.clientX, y: e.clientY, visIdx, colIdx, copyText, copyLabel });
  }, [isCellInRange, pageRows, selectionStart, selectionEnd, selectedRows]);

  const formatDelimitedCell = useCallback((value: unknown, separator: ',' | '\t') => {
    if (value === null || value === undefined) return separator === '\t' ? 'NULL' : '';
    const s = String(value);
    if (separator === '\t') return s.replace(/\t/g, ' ');
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  }, []);

  const writeClipboard = useCallback(async (text: string, successText: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showStatus('success', successText);
      return true;
    } catch (err) {
      showStatus('error', `Copy failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }, []);

  const getSelectionText = useCallback((fallbackVisIdx?: number, fallbackColIdx?: number) => {
    if (!result) return '';
    const bounds = getSelectionBounds(fallbackVisIdx, fallbackColIdx);
    if (!bounds) {
      return '';
    }

    const lines: string[] = [];
    for (let r = bounds.startRow; r <= bounds.endRow; r++) {
      const rowCells: string[] = [];
      for (let c = bounds.startCol; c <= bounds.endCol; c++) {
        const cellVal = pageRows[r]?.row.data[c];
        rowCells.push(cellVal === null || cellVal === undefined ? '' : String(cellVal));
      }
      lines.push(rowCells.join('\t'));
    }
    return lines.join('\n');
  }, [result, pageRows, getSelectionBounds]);

  const copySelection = useCallback((fallbackVisIdx?: number, fallbackColIdx?: number) => {
    const bounds = getSelectionBounds(fallbackVisIdx, fallbackColIdx);
    if (!bounds) return null;
    const text = getSelectionText(fallbackVisIdx, fallbackColIdx);
    const isRange = bounds.startRow !== bounds.endRow || bounds.startCol !== bounds.endCol;
    void writeClipboard(text, isRange ? 'Copied range' : 'Copied cell');
    return text;
  }, [getSelectionBounds, getSelectionText, writeClipboard]);

  const getAllClientRowsForCopy = useCallback(() => {
    if (filteredSortedIndices !== null) {
      return filteredSortedIndices
        .map(origIdx => rows[origIdx])
        .filter(row => row && row.status !== 'deleted')
        .map((row, origIdx) => ({ row, origIdx }));
    }
    return rows
      .map((row, origIdx) => ({ row, origIdx }))
      .filter(item => item.row.status !== 'deleted');
  }, [filteredSortedIndices, rows]);

  const buildDelimited = useCallback((items: { row: RowState; origIdx: number }[], includeHeader: boolean, format: 'csv' | 'tsv') => {
    if (!result) return '';
    const separator = format === 'tsv' ? '\t' : ',';
    const columnIndices = visibleColumnIndices;
    const header = columnIndices.map(idx => formatDelimitedCell(result.columns[idx].name, separator)).join(separator);
    const body = items.map(x => columnIndices.map(idx => formatDelimitedCell(x.row.data[idx], separator)).join(separator)).join('\n');
    return includeHeader ? `${header}\n${body}` : body;
  }, [result, visibleColumnIndices, formatDelimitedCell]);

  /** Copy one or many rows in the requested format. */
  const copyRowsAs = useCallback((format: CopyFormat, visIdxs: number[]) => {
    if (!result) return;
    const rowsData = visIdxs
      .map(visIdx => pageRows[visIdx]?.row.data)
      .filter((row): row is unknown[] => !!row);
    if (rowsData.length === 0) return;

    const columnIndices = visibleColumnIndices;
    const cols = columnIndices.map(idx => result.columns[idx]);
    const noHeader = format === 'csv-noheader' || format === 'tsv-noheader';
    // Query results have no source table, so keep the SQL copyable.
    const target = tableName || 'table_name';
    let output = '';

    if (format === 'csv' || format === 'csv-noheader') {
      const lines = rowsData.map(row => columnIndices.map(idx => formatDelimitedCell(row[idx], ',')).join(','));
      output = noHeader ? lines.join('\n') : [cols.map(c => formatDelimitedCell(c.name, ',')).join(','), ...lines].join('\n');
    } else if (format === 'tsv' || format === 'tsv-noheader') {
      const lines = rowsData.map(row => columnIndices.map(idx => formatDelimitedCell(row[idx], '\t')).join('\t'));
      output = noHeader ? lines.join('\n') : [cols.map(c => c.name).join('\t'), ...lines].join('\n');
    } else if (format === 'json') {
      const objects = rowsData.map(row => {
        const obj: Record<string, unknown> = {};
        columnIndices.forEach((idx, i) => { obj[cols[i].name] = row[idx]; });
        return obj;
      });
      // Keep the single-row shape (an object) unchanged; batches become an array.
      output = JSON.stringify(objects.length === 1 ? objects[0] : objects, null, 2);
    } else if (format === 'xml') {
      output = rowsData.map(row => {
        const inner = columnIndices.map((idx, i) => {
          const val = row[idx];
          const escaped = val === null ? '' : String(val).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          return `  <${cols[i].name}>${escaped}</${cols[i].name}>`;
        }).join('\n');
        return `<row>\n${inner}\n</row>`;
      }).join('\n');
    } else if (format === 'insert') {
      const colList = cols.map(c => `\`${c.name}\``).join(', ');
      const tuples = rowsData.map(row => `(${columnIndices.map(idx => sqlLiteral(row[idx])).join(', ')})`);
      // One multi-VALUES statement is what a batch copy is usually for.
      output = tuples.length === 1
        ? `INSERT INTO ${target} (${colList}) VALUES ${tuples[0]};`
        : `INSERT INTO ${target} (${colList}) VALUES\n  ${tuples.join(',\n  ')};`;
    } else if (format === 'update') {
      output = rowsData.map(row => {
        const pkCols = cols.filter(c => c.isPrimaryKey);
        const sets = cols.map((col, i) => `\`${col.name}\` = ${sqlLiteral(row[columnIndices[i]])}`).join(', ');
        const where = (pkCols.length > 0 ? pkCols : cols)
          .map(col => `\`${col.name}\` = ${sqlLiteral(row[columnIndices[cols.indexOf(col)]])}`)
          .join(' AND ');
        return `UPDATE ${target} SET ${sets} WHERE ${where};`;
      }).join('\n');
    }

    const label = rowsData.length === 1 ? 'row' : `${rowsData.length} rows`;
    void writeClipboard(output, `Copied ${format.toUpperCase()} (${label})`);
  }, [result, pageRows, tableName, visibleColumnIndices, formatDelimitedCell, writeClipboard]);

  const copyRowAs = useCallback((format: CopyFormat, visIdx: number) => {
    copyRowsAs(format, [visIdx]);
  }, [copyRowsAs]);

  const handleCopyDelimited = useCallback((format: 'csv' | 'tsv', includeHeader = true, scope: 'page' | 'all' = 'page') => {
    if (!result) return;
    setCsvMenuOpen(false);
    const label = format.toUpperCase();
    if (scope === 'all' && tableName) {
      showStatus('info', `Copy all ${label} started...`);
      post({
        type: 'copyTableData',
        data: {
          format,
          includeHeader,
          sortStates,
          whereFilter: whereFilter || undefined,
          columnFilters: sqlColumnFilters,
        },
      });
      return;
    }

    const items = scope === 'all' ? getAllClientRowsForCopy() : pageRows;
    const text = buildDelimited(items, includeHeader, format);
    void writeClipboard(text, scope === 'all' ? `Copied all rows as ${label}` : `Copied current page as ${label}`);
  }, [result, tableName, sortStates, whereFilter, sqlColumnFilters, getAllClientRowsForCopy, pageRows, buildDelimited, writeClipboard]);

  // ── Export query results to file ──
  const handleExportResults = useCallback((format: 'csv' | 'json' | 'sql') => {
    if (!result) return;
    setCsvMenuOpen(false);
    showStatus('info', `Exporting as ${format.toUpperCase()}...`);
    post({
      type: 'exportQueryResults',
      data: {
        format,
        columns: result.columns.map(c => c.name),
        rows: result.rows,
        tableName: tableName || undefined,
      },
    });
  }, [result, tableName]);

  // ── Quick View ──
  const closeQuickView = useCallback(() => {
    setShowQuickViewSidebar(false);
    setQuickViewRowIdx(null);
  }, []);

  // ── Header tooltips: shown after HEADER_TOOLTIP_DELAY_MS of hovering ──
  const hideHeaderTooltip = useCallback(() => {
    window.clearTimeout(headerTooltipTimerRef.current);
    setHeaderTooltip(null);
  }, []);

  const scheduleHeaderTooltip = useCallback((el: HTMLElement, text: string) => {
    window.clearTimeout(headerTooltipTimerRef.current);
    // A new anchor means a different hint, so retire the visible one first.
    setHeaderTooltip(null);
    headerTooltipTimerRef.current = window.setTimeout(() => {
      const rect = el.getBoundingClientRect();
      setHeaderTooltip({
        text,
        left: Math.max(8, Math.min(rect.left + 6, window.innerWidth - HEADER_TOOLTIP_MAX_WIDTH - 16)),
        top: rect.bottom + 4,
      });
    }, HEADER_TOOLTIP_DELAY_MS);
  }, []);

  useEffect(() => () => window.clearTimeout(headerTooltipTimerRef.current), []);

  /**
   * Show the quick view for a row. Clicking the same row again closes it, so
   * the eye button works as a toggle; pass mode 'open' to force it open.
   */
  const handleQuickView = useCallback((visIdx: number, mode: 'toggle' | 'open' = 'toggle') => {
    if (!result) return;
    const item = pageRows[visIdx];
    if (!item) return;
    if (mode === 'toggle' && showQuickViewSidebar && quickViewRowIdx === visIdx) {
      closeQuickView();
      return;
    }
    setQuickViewData({ columns: result.columns, rowData: item.row.data });
    setQuickViewRowIdx(visIdx);
    setShowQuickViewSidebar(true);
  }, [result, pageRows, showQuickViewSidebar, quickViewRowIdx, closeQuickView]);

  // ── Quick View sidebar resizing ──
  const startQuickViewResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const measured = quickViewSidebarRef.current?.getBoundingClientRect().width;
    const startWidth = quickViewWidth ?? (measured && measured > 0 ? measured : 360);
    const maxWidth = Math.max(320, Math.round(window.innerWidth * 0.8));
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    setResizingQuickView(true);

    const onMove = (ev: MouseEvent) => {
      const next = Math.min(Math.max(startWidth - (ev.clientX - startX), 240), maxWidth);
      setQuickViewWidth(next);
    };
    const onUp = () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      setResizingQuickView(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [quickViewWidth]);

  // ── Go to Column locator ──
  const openColumnLocator = useCallback((visIdx: number) => {
    setColumnLocator({ rowVisIdx: visIdx });
    setColumnLocatorQuery('');
    setColumnLocatorActive(0);
  }, []);

  const handleColumnLocatorPick = useCallback((ci: number) => {
    if (!columnLocator) return;
    const rowIdx = columnLocator.rowVisIdx;
    setColumnLocator(null);
    setSelectedRow(rowIdx);
    setSelectedCol(ci);
    setSelectionStart({ row: rowIdx, col: ci });
    setSelectionEnd({ row: rowIdx, col: ci });
    // Focus the picked cell once React has applied the selection class.
    requestAnimationFrame(() => {
      gridRef.current?.querySelector('.cell-selected')?.scrollIntoView({ block: 'nearest', inline: 'center' });
    });
  }, [columnLocator]);

  const switchViewMode = useCallback((mode: GridViewMode) => {
    setViewMode(mode);
    if (mode === 'table' && tableName) {
      handleReload();
    }
    if (mode === 'ddl' && tableName && !ddlText && !ddlLoading) {
      setDdlLoading(true);
      post({ type: 'getDDL' });
    }
  }, [tableName, ddlText, ddlLoading, handleReload]);

  const closeAfterSecondEsc = useCallback((target: 'filter' | 'quickview', close: () => void) => {
    const now = Date.now();
    const previous = escStateRef.current;
    const count = previous.target === target && now - previous.time < 900 ? previous.count + 1 : 1;
    escStateRef.current = { target, count, time: now };
    if (count >= 2) {
      close();
      escStateRef.current = { target: null, count: 0, time: 0 };
    }
  }, []);

  // ── Keyboard Navigation ──
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (editingCell) {
      if (e.key === 'Escape') cancelEdit();
      else if (e.key === 'Enter') commitEdit();
      else if (e.key === 'Tab') { e.preventDefault(); commitEdit(); }
      return;
    }
    const target = e.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, [contenteditable="true"]')) {
      return;
    }
    if (!result) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    switch (key) {
      case 'Escape':
        if (showWhereInput) {
          e.preventDefault();
          closeAfterSecondEsc('filter', () => setShowWhereInput(false));
        } else if (showQuickViewSidebar) {
          e.preventDefault();
          closeAfterSecondEsc('quickview', closeQuickView);
        }
        break;
      case 'ArrowDown': {
        e.preventDefault();
        const nextR = Math.min(selectedRow + 1, pageRows.length - 1);
        setSelectedRow(nextR);
        if (e.shiftKey) {
          setSelectionEnd(prev => ({ row: nextR, col: prev ? prev.col : selectedCol }));
        } else {
          setSelectionStart({ row: nextR, col: selectedCol });
          setSelectionEnd({ row: nextR, col: selectedCol });
          setSelectedRows(new Set());
        }
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        const nextR = Math.max(selectedRow - 1, 0);
        setSelectedRow(nextR);
        if (e.shiftKey) {
          setSelectionEnd(prev => ({ row: nextR, col: prev ? prev.col : selectedCol }));
        } else {
          setSelectionStart({ row: nextR, col: selectedCol });
          setSelectionEnd({ row: nextR, col: selectedCol });
          setSelectedRows(new Set());
        }
        break;
      }
      case 'ArrowRight': {
        e.preventDefault();
        const currentVisibleIdx = visibleColumnIndices.indexOf(selectedCol);
        const nextC = currentVisibleIdx >= 0
          ? visibleColumnIndices[Math.min(currentVisibleIdx + 1, visibleColumnIndices.length - 1)]
          : (visibleColumnIndices[0] ?? Math.min(selectedCol + 1, result.columns.length - 1));
        setSelectedCol(nextC);
        if (e.shiftKey) {
          setSelectionEnd(prev => ({ row: prev ? prev.row : selectedRow, col: nextC }));
        } else {
          setSelectionStart({ row: selectedRow, col: nextC });
          setSelectionEnd({ row: selectedRow, col: nextC });
        }
        break;
      }
      case 'ArrowLeft': {
        e.preventDefault();
        const currentVisibleIdx = visibleColumnIndices.indexOf(selectedCol);
        const nextC = currentVisibleIdx >= 0
          ? visibleColumnIndices[Math.max(currentVisibleIdx - 1, 0)]
          : (visibleColumnIndices[0] ?? Math.max(selectedCol - 1, 0));
        setSelectedCol(nextC);
        if (e.shiftKey) {
          setSelectionEnd(prev => ({ row: prev ? prev.row : selectedRow, col: nextC }));
        } else {
          setSelectionStart({ row: selectedRow, col: nextC });
          setSelectionEnd({ row: selectedRow, col: nextC });
        }
        break;
      }
      case 'Enter': case 'F2': if (selectedRow >= 0 && selectedCol >= 0) startEdit(selectedRow, selectedCol); break;
      case 'Delete': case 'Backspace':
        if (selectedRows.size > 0) {
          e.preventDefault();
          deleteRows(Array.from(selectedRows));
        } else if (selectedRow >= 0 && selectedCol >= 0 && !editingCell) {
          e.preventDefault();
          setCellsToNull(selectedRow, selectedCol);
        }
        break;
      case 'z': if (e.metaKey || e.ctrlKey) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); } break;
      case 'r': if (e.metaKey || e.ctrlKey) { e.preventDefault(); handleReload(); } break;
      case 'c':
        if (e.metaKey || e.ctrlKey) {
          if (selectedRow >= 0 && selectedCol >= 0) {
            copySelection(selectedRow, selectedCol);
            e.preventDefault();
          }
        }
        break;
      case 'v':
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          navigator.clipboard.readText().then(pasteData).catch(console.error);
        }
        break;
    }
  }, [editingCell, result, showWhereInput, showQuickViewSidebar, selectedRow, selectedCol, selectedRows, pageRows, visibleColumnIndices, startEdit, commitEdit, cancelEdit, undo, redo, pasteData, handleReload, copySelection, closeAfterSecondEsc, deleteRows, setCellsToNull, closeQuickView]);

  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) {
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && selectedRow >= 0 && selectedCol >= 0) {
        event.preventDefault();
        copySelection(selectedRow, selectedCol);
      }
    };
    const handleNativeCopy = (event: ClipboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) {
        return;
      }
      const bounds = getSelectionBounds(selectedRow, selectedCol);
      if (!bounds || !event.clipboardData) {
        return;
      }
      const text = getSelectionText(selectedRow, selectedCol);
      event.clipboardData.setData('text/plain', text);
      event.preventDefault();
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    window.addEventListener('copy', handleNativeCopy);
    return () => {
      window.removeEventListener('keydown', handleGlobalKeyDown);
      window.removeEventListener('copy', handleNativeCopy);
    };
  }, [selectedRow, selectedCol, copySelection, getSelectionBounds, getSelectionText]);

  if (!result && awaitingInitialResult) {
    return (
      <div className="datagrid-empty">
        <span className="loading-spinner" />
        <h3>{t('Loading...')}</h3>
        <p className="text-muted">{t('Preparing data grid')}</p>
      </div>
    );
  }
  if (!result) return <div className="datagrid-empty"><div className="empty-icon"><Icon name="database" size={40} strokeWidth={1.2} /></div><h3>{t('No Results')}</h3><p className="text-muted">{t('Run a query to see results here')}</p></div>;
  if (result.columns.length === 0 && !loadingRows) return <div className="datagrid-message"><div className="message-icon"><Icon name="checkCircle" size={36} strokeWidth={1.4} /></div><h3>{result.affectedRows} rows affected</h3><p className="text-muted">{result.executionTime}ms</p></div>;

  const latestLog = logEntries[0];
  const selectedLog = logEntries.find(entry => entry.id === selectedLogId) || latestLog;
  const quickFields = (quickViewData?.columns || [])
    .map((col, idx) => ({ col, value: quickViewData?.rowData[idx], idx }))
    .filter(item => item.col.name.toLowerCase().includes(quickViewFilter.toLowerCase()));

  const locatorQuery = columnLocatorQuery.toLowerCase();
  const locatorCols = columnLocator
    ? visibleColumnIndices
        .map(ci => ({ ci, col: result.columns[ci] }))
        .filter(({ col }) => col.name.toLowerCase().includes(locatorQuery))
    : [];

  return (
    <div className="datagrid" ref={gridRef} onKeyDown={handleKeyDown} onMouseDown={() => gridRef.current?.focus()} tabIndex={0}>
      {/* Toolbar */}
      <div className="datagrid-toolbar">
        <div className="toolbar-left">
          <button className="toolbar-btn icon-btn" onClick={handleReload} title={t('Reload (Ctrl+R)')}><Icon name="refresh" /></button>
          <button className={`toolbar-btn icon-btn ${showWhereInput ? 'btn-active' : ''}`} onClick={() => setShowWhereInput(v => !v)} title={t('Filter with WHERE SQL')}><Icon name="search" /></button>
          <button className="toolbar-btn icon-btn" onClick={() => post({ type: 'openNewTab' })} title={t('Open New Query Tab')}>sql</button>
          <button
            className="toolbar-btn icon-btn"
            onClick={() => { if (selectedRow >= 0) openColumnLocator(selectedRow); }}
            disabled={selectedRow < 0 || pageRows.length === 0}
            title={t('Go to Column (locate column on current row)')}
          ><Icon name="locate" /></button>
          <div className="row-filter-wrap">
            <input
              type="text"
              className="filter-input"
              placeholder={t('Filter rows...')}
              value={filterInput}
              onChange={e => setFilterInput(e.target.value)}
              onBlur={applyRowFilter}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  applyRowFilter();
                }
                if (e.key === 'Escape') {
                  setFilterInput(filterText);
                }
              }}
            />
            <div className="filter-mode-actions">
              <button
                className={`filter-mode-btn ${filterMatchCase ? 'active' : ''}`}
                onClick={() => setFilterMatchCase(v => !v)}
                title={t('Match case')}
                type="button"
              >
                Aa
              </button>
              <button
                className={`filter-mode-btn ${filterUseRegex ? 'active' : ''}`}
                onClick={() => setFilterUseRegex(v => !v)}
                title={t('Use regular expression')}
                type="button"
              >
                .*
              </button>
            </div>
          </div>
          {showWhereInput && (
            <div className="where-filter-group">
              <span className="where-label">WHERE</span>
              <input
                type="text"
                className="where-input"
                placeholder="e.g. id > 100 AND status = 'active'"
                value={whereFilter}
                onChange={e => setWhereFilter(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleApplyWhere();
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    closeAfterSecondEsc('filter', () => setShowWhereInput(false));
                  }
                }}
              />
              <button className="toolbar-btn icon-btn" onClick={handleApplyWhere} title={t('Apply WHERE filter')}><Icon name="check" /></button>
              <button className="toolbar-btn icon-btn" onClick={() => { setWhereFilter(''); setShowWhereInput(false); handleApplyWhere(); }} title={t('Clear WHERE filter')}><Icon name="close" /></button>
            </div>
          )}
          <span className="row-count">
            {rowFilterApplying ? 'Đang tìm kiếm trên trang hiện tại...' : `${visibleRowsCount.toLocaleString()} rows`}
          </span>
        </div>
        <div className="toolbar-right">
          {hasChanges && (
            <div className="change-indicator">
              {changeStats.modified > 0 && <span className="badge badge-modified">{changeStats.modified} modified</span>}
              {changeStats.added > 0 && <span className="badge badge-added">{changeStats.added} added</span>}
              {changeStats.deleted > 0 && <span className="badge badge-deleted">{changeStats.deleted} deleted</span>}
            </div>
          )}
          {selectedRow >= 0 && (
            <button
              className={`toolbar-btn icon-btn btn-quickview${showQuickViewSidebar ? ' btn-active' : ''}`}
              onClick={() => handleQuickView(selectedRow)}
              title={showQuickViewSidebar ? t('Hide Quick View') : t('Quick View Row')}
            ><Icon name="eye" /></button>
          )}
          {viewMode === 'table' && (
            <button
              className={`toolbar-btn icon-btn${verticalView ? ' btn-active' : ''}`}
              onClick={() => setVerticalView(v => !v)}
              title={verticalView ? 'Exit Vertical View' : 'Vertical View (records as columns)'}
            ><Icon name="columns" /></button>
          )}
          <button className="toolbar-btn icon-btn" onClick={addRow} title={t('Add Row')}><Icon name="plus" /></button>
          <div className="csv-copy-group" ref={csvMenuRef}>
            <button className="toolbar-btn icon-btn" onClick={() => setCsvMenuOpen(v => !v)} title={t('Copy / Export data')}><Icon name="download" /></button>
            {csvMenuOpen && (
              <div className="csv-copy-menu">
                <div className="csv-copy-menu-heading">{t('Copy')}</div>
                <button onClick={() => handleCopyDelimited('csv', true, 'page')}>{t('CSV · Current page with header')}</button>
                <button onClick={() => handleCopyDelimited('csv', true, 'all')}>{t('CSV · All rows with header')}</button>
                <button onClick={() => handleCopyDelimited('tsv', true, 'page')}>{t('TSV · Current page with header')}</button>
                <button onClick={() => handleCopyDelimited('tsv', true, 'all')}>{t('TSV · All rows with header')}</button>
                <div className="csv-copy-menu-separator" />
                <div className="csv-copy-menu-heading">{t('Export')}</div>
                <button onClick={() => handleExportResults('csv')}>{t('Export as CSV')}</button>
                <button onClick={() => handleExportResults('json')}>{t('Export as JSON')}</button>
                <button onClick={() => handleExportResults('sql')}>{t('Export as SQL INSERT')}</button>
              </div>
            )}
          </div>
          <button className="toolbar-btn icon-btn" onClick={undo} disabled={undoStack.length === 0} title={t('Undo (Ctrl+Z)')}><Icon name="undo" /></button>
          <button className="toolbar-btn icon-btn" onClick={redo} disabled={redoStack.length === 0} title={t('Redo (Ctrl+Shift+Z)')}><Icon name="redo" /></button>
          {hasChanges && <>
            <button className="toolbar-btn icon-btn btn-preview sql-preview-btn" onClick={handlePreviewSQL} title={t('Preview SQL')}><Icon name="terminal" /></button>
            <button className="toolbar-btn icon-btn btn-discard" onClick={handleDiscard} title={t('Discard Changes')}><Icon name="close" /></button>
            <button className="toolbar-btn icon-btn btn-save" onClick={handleSave} title={t('Save Changes')}><Icon name="save" /></button>
          </>}
          <span className="execution-time">{result.executionTime}ms</span>
        </div>
      </div>

      {/* Table */}
      <div className="datagrid-main">
        {viewMode === 'ddl' ? (
          <div className="ddl-view">
            {ddlLoading ? (
              <div className="ddl-state">{t('Loading DDL...')}</div>
            ) : ddlText ? (
              <pre className="ddl-code-view">{ddlText}</pre>
            ) : (
              <div className="ddl-state">{t('No DDL available')}</div>
            )}
          </div>
        ) : (
          <div className="datagrid-table-pane">
            {verticalView ? (
            <div className="datagrid-table-wrapper vertical-view-wrapper" onScroll={hideHeaderTooltip}>
              <table className="datagrid-table vertical-view-table">
                <thead>
                  <tr>
                    <th className="row-num-header vertical-field-header"><span>{t('Field')}</span></th>
                    {pageRows.map((item, i) => (
                      <th key={item.origIdx} className="vertical-record-header">{page * pageSize + i + 1}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {!loadingRows && pageRows.length === 0 ? (
                    <tr><td className="loading-row" colSpan={2}>{t('No rows')}</td></tr>
                  ) : visibleColumnIndices.map(ci => {
                    const col = result.columns[ci];
                    return (
                      <tr key={ci} className="vertical-field-row">
                        <th className="vertical-field-name" title={buildColumnTooltip(col)}>
                          <span className="col-name">{col.isPrimaryKey && <span className="pk-icon"><Icon name="key" size={12} /></span>}{col.name}</span>
                          <span className="col-type">{formatColumnType(col)}</span>
                        </th>
                        {pageRows.map((item, visIdx) => {
                          const cell = item.row.data[ci];
                          const isEditing = editingCell?.row === visIdx && editingCell?.col === ci;
                          const isChanged = item.row.changedCols.has(ci);
                          const isInSelection = isCellInRange(visIdx, ci);
                          const isFocused = selectedRow === visIdx && selectedCol === ci;
                          const cellClass = `cell${isFocused ? ' cell-selected' : ''}${isInSelection ? ' cell-selected-range' : ''}${cell === null ? ' cell-null' : ''}${isChanged ? ' cell-changed' : ''}${isEditing ? ' cell-editing' : ''} cell-type-${col?.normalizedType || 'unknown'}`;
                          return (
                            <td
                              key={item.origIdx}
                              className={cellClass}
                              onMouseDown={(e) => { if (!e.shiftKey) { setSelectedCol(ci); } handleCellMouseDown(visIdx, ci, e); }}
                              onMouseEnter={() => handleCellMouseEnter(visIdx, ci)}
                              onClick={(e) => e.stopPropagation()}
                              onContextMenu={(e) => handleContextMenu(e, visIdx, ci)}
                              onDoubleClick={() => startEdit(visIdx, ci)}
                              title={cell === null ? 'NULL' : String(cell)}
                            >
                              {isEditing ? (
                                <input ref={editInputRef} className="cell-editor" value={editValue}
                                  onMouseDown={e => e.stopPropagation()}
                                  onClick={e => e.stopPropagation()}
                                  onDoubleClick={e => e.stopPropagation()}
                                  onChange={e => setEditValue(e.target.value)}
                                  onBlur={commitEdit}
                                  onKeyDown={e => {
                                    if (e.key === 'Escape') cancelEdit();
                                    else if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
                                  }} />
                              ) : renderCell(cell, col)}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            ) : (
            <div className="datagrid-table-wrapper" onScroll={hideHeaderTooltip}>
            <table className="datagrid-table">
              <thead>
                <tr>
                  <th className="row-num-header">
                    <div className="row-num-header-inner">
                      <span>#</span>
                      <button
                        type="button"
                        className={`column-filter-toggle ${showColumnFilters ? 'active' : ''}`}
                        onClick={e => {
                          e.stopPropagation();
                          setShowColumnFilters(v => !v);
                        }}
                        title={t('Column filters')}
                      >
                        <Icon name="search" size={12} />
                      </button>
                    </div>
                  </th>
                  {visibleColumnIndices.map(i => {
                    const col = result.columns[i];
                    const colSort = sortStates.find(s => s.column === i);
                    const sortOrder = sortStates.findIndex(s => s.column === i) + 1;
                    return (
                      <th key={i} className={`column-header-th ${colSort ? `sorted-${colSort.direction}` : ''}`}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={(e) => selectColumn(i)}
                        onMouseEnter={(e) => {
                          // The sort button lives inside the header and carries
                          // its own hint, so only cover the rest of the cell.
                          if (!(e.target as HTMLElement).closest('.sort-action-btn')) {
                            scheduleHeaderTooltip(e.currentTarget, buildColumnTooltip(col));
                          }
                        }}
                        onMouseLeave={hideHeaderTooltip}>
                        <div className="header-content-wrapper">
                          <span className="col-name">{col.isPrimaryKey && <span className="pk-icon"><Icon name="key" size={12} /></span>}{col.name}</span>
                          <button className="sort-action-btn" onClick={(e) => toggleSort(i, e)}
                            onMouseEnter={(e) => scheduleHeaderTooltip(e.currentTarget, 'Sort (hold Ctrl for multi-sort)')}
                            onMouseLeave={hideHeaderTooltip}>
                            <Icon name={colSort ? (colSort.direction === 'asc' ? 'chevronUp' : 'chevronDown') : 'sort'} size={12} />
                            {sortStates.length > 1 && colSort && <sup className="sort-order">{sortOrder}</sup>}
                          </button>
                        </div>
                        <span className="col-type">{formatColumnType(col)}</span>
                      </th>
                    );
                  })}
                  {showRowActions && <th className="row-actions-header"><Icon name="more" size={14} /></th>}
                </tr>
                {showColumnFilters && (
                  <tr className="column-filter-row">
                    <th className="row-num-header">
                      <button
                        type="button"
                        className={`column-filter-clear ${activeColumnFilterCount > 0 ? 'active' : ''}`}
                        onClick={e => {
                          e.stopPropagation();
                          clearColumnFilters();
                        }}
                        title={t('Clear column filters')}
                      >
                        <Icon name="close" size={12} />
                        {activeColumnFilterCount > 0 && <span className="column-filter-badge">{activeColumnFilterCount}</span>}
                      </button>
                    </th>
                    {visibleColumnIndices.map(i => {
                      const col = result.columns[i];
                      const defaultFilter = { operator: getDefaultColumnFilterOperator(col), value: '' };
                      const filter = draftColumnFilters[i] || columnFilters[i] || defaultFilter;
                      const operatorMeta = COLUMN_FILTER_OPERATORS.find(op => op.value === filter.operator);
                      const applied = isColumnFilterActive(columnFilters[i]);
                      return (
                        <th key={`filter-${i}`} className={`column-filter-cell ${applied ? 'active' : ''}`} onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
                          <div className="column-filter-control">
                            <span className="column-filter-operator-wrap">
                              <span className="column-filter-operator-icon" aria-hidden="true">{operatorMeta?.icon || '~'}</span>
                              <select
                                className="column-filter-operator"
                                value={filter.operator}
                                onChange={e => {
                                  delete columnFilterShortcutRef.current[i];
                                  updateColumnFilter(i, { operator: e.target.value as ColumnFilterOperator });
                                }}
                                title={`Filter ${col.name} operator`}
                              >
                                {COLUMN_FILTER_OPERATORS.map(op => (
                                  <option key={op.value} value={op.value}>{op.icon} {op.label}</option>
                                ))}
                              </select>
                            </span>
                            <input
                              value={filter.value}
                              disabled={operatorMeta?.needsValue === false}
                              onChange={e => handleColumnFilterInputChange(i, e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  applyColumnFilter(i);
                                }
                              }}
                              onBlur={() => applyColumnFilter(i)}
                              placeholder={operatorMeta?.needsValue === false ? '' : col.name}
                              title={`Filter ${col.name}`}
                            />
                          </div>
                        </th>
                      );
                    })}
                    {showRowActions && <th className="row-actions-header" />}
                  </tr>
                )}
              </thead>
              <tbody>
                {!loadingRows && pageRows.length === 0 ? (
                  <tr>
                    <td className="loading-row" colSpan={visibleColumnCount + (showRowActions ? 2 : 1)}>
                      No rows
                    </td>
                  </tr>
                ) : pageRows.map((item, visIdx) => {
                  const absIdx = page * pageSize + visIdx;
                  const isRowSelected = selectedRows.has(visIdx);
                  const rowClass = `row-${item.row.status}${isRowSelected ? ' selected' : ''}${selectedRows.size > 1 && selectedRows.has(visIdx) ? ' multi-selected' : ''}`;
                  return (
                    <tr key={item.origIdx} className={rowClass}
                      onClick={(e) => handleRowClick(visIdx, e)}
                      onContextMenu={(e) => handleContextMenu(e, visIdx)}>
                      <td className="row-num" onClick={(e) => { e.stopPropagation(); selectRowAllColumns(visIdx, e); }}>
                        {item.row.status === 'added' ? <Icon name="dot" size={9} /> : absIdx + 1}
                      </td>
                      {visibleColumnIndices.map(ci => {
                        const cell = item.row.data[ci];
                        const isEditing = editingCell?.row === visIdx && editingCell?.col === ci;
                        const isChanged = item.row.changedCols.has(ci);
                        const isInSelection = isCellInRange(visIdx, ci);
                        const isFocused = selectedRow === visIdx && selectedCol === ci;
                        const cellClass = `cell${isFocused ? ' cell-selected' : ''}${isInSelection ? ' cell-selected-range' : ''}${cell === null ? ' cell-null' : ''}${isChanged ? ' cell-changed' : ''}${isEditing ? ' cell-editing' : ''} cell-type-${result.columns[ci]?.normalizedType || 'unknown'}`;
                        return (
                          <td key={ci} className={cellClass}
                            onMouseDown={(e) => { if (!e.shiftKey) { setSelectedCol(ci); } handleCellMouseDown(visIdx, ci, e); }}
                            onMouseEnter={() => handleCellMouseEnter(visIdx, ci)}
                            onClick={(e) => e.stopPropagation()}
                            onContextMenu={(e) => handleContextMenu(e, visIdx, ci)}
                            onDoubleClick={() => startEdit(visIdx, ci)}
                            title={cell === null ? 'NULL' : String(cell)}>
                            {isEditing ? (
                              <input ref={editInputRef} className="cell-editor" value={editValue}
                                onMouseDown={e => e.stopPropagation()}
                                onClick={e => e.stopPropagation()}
                                onDoubleClick={e => e.stopPropagation()}
                                onChange={e => setEditValue(e.target.value)}
                                onBlur={commitEdit}
                                onKeyDown={e => {
                                  if (e.key === 'Escape') cancelEdit();
                                  else if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
                                }} />
                            ) : renderCell(cell, result.columns[ci])}
                          </td>
                        );
                      })}
                      {showRowActions && <td className="row-actions">
                        <button className="row-action-btn" onClick={e => { e.stopPropagation(); handleQuickView(visIdx); }} title={t('Quick View')}><Icon name="eye" size={13} /></button>
                        <button className="row-action-btn" onClick={e => { e.stopPropagation(); duplicateRow(visIdx); }} title={t('Duplicate')}><Icon name="copy" size={13} /></button>
                      </td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
            )}
            {loadingRows && (
              <div className="datagrid-loading-overlay">
                <div className="datagrid-loading-pill">
                  <span className="loading-spinner" /> {t('Loading rows...')} </div>
              </div>
            )}
          </div>
        )}

        {viewMode === 'table' && showQuickViewSidebar && quickViewData && (
          <aside
            className={`datagrid-quickview-sidebar${resizingQuickView ? ' resizing' : ''}`}
            ref={quickViewSidebarRef}
            style={quickViewWidth ? { width: quickViewWidth } : undefined}
          >
            <div className="dqv-resizer" onMouseDown={startQuickViewResize} title={t('Drag to resize')} />
            <div className="dqv-header">
              <div>
                <h2>{t('Quick View')}</h2>
                <span>{quickViewData.columns.length} fields</span>
              </div>
              <button onClick={closeQuickView} title={t('Close Quick View')}><Icon name="close" size={13} /></button>
            </div>
            <div className="dqv-search">
              <input
                value={quickViewFilter}
                onChange={e => setQuickViewFilter(e.target.value)}
                placeholder={t('Filter fields...')}
              />
            </div>
            <div className="dqv-list">
              {quickFields.length === 0 ? (
                <div className="dqv-empty">{t('No matching fields')}</div>
              ) : quickFields.map(({ col, value, idx }) => {
                const text = valueToText(value);
                return (
                  <div key={`${col.name}-${idx}`} className={`dqv-field ${col.isPrimaryKey ? 'primary' : ''}`}>
                    <div className="dqv-field-meta">
                      <strong>{col.isPrimaryKey ? <Icon name="key" size={12} /> : null}{col.isPrimaryKey ? ' ' : ''}{col.name}</strong>
                      <span>{formatColumnType(col)}</span>
                    </div>
                    {col.comment && <div className="dqv-field-comment" title={col.comment}>{col.comment}</div>}
                    <button
                      className={`dqv-value ${value === null || value === undefined ? 'null' : ''}`}
                      onClick={() => setExpandedQuickValue({ name: col.name, type: formatColumnType(col), value: text, comment: col.comment })}
                      title={t('Click to view full value')}
                    >
                      {text}
                    </button>
                    <button className="dqv-copy" onClick={() => void writeClipboard(text, `Copied ${col.name}`)} title={t('Copy value')}>{t('Copy')}</button>
                  </div>
                );
              })}
            </div>
          </aside>
        )}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={e => e.stopPropagation()}>
          {contextMenu.rowVisIdxs ? (
            <>
              <div className="context-menu-heading">{contextMenu.rowVisIdxs.length} rows selected</div>
              <div className="context-menu-item" onClick={() => { copyRowsAs('csv', contextMenu.rowVisIdxs!); setContextMenu(null); }}><Icon name="copy" size={13} /> {t('Copy as CSV (with header)')} </div>
              <div className="context-menu-item" onClick={() => { copyRowsAs('tsv', contextMenu.rowVisIdxs!); setContextMenu(null); }}><Icon name="copy" size={13} /> {t('Copy as TSV (with header)')} </div>
              <div className="context-menu-item" onClick={() => { copyRowsAs('json', contextMenu.rowVisIdxs!); setContextMenu(null); }}><Icon name="copy" size={13} /> {t('Copy as JSON')} </div>
              <div className="context-menu-item" onClick={() => { copyRowsAs('xml', contextMenu.rowVisIdxs!); setContextMenu(null); }}><Icon name="copy" size={13} /> {t('Copy as XML')} </div>
              <div className="context-menu-separator" />
              <div className="context-menu-item" onClick={() => { copyRowsAs('insert', contextMenu.rowVisIdxs!); setContextMenu(null); }}><Icon name="copy" size={13} /> {t('Copy as SQL INSERT (batch)')} </div>
              <div className="context-menu-item" onClick={() => { copyRowsAs('update', contextMenu.rowVisIdxs!); setContextMenu(null); }}><Icon name="copy" size={13} /> {t('Copy as SQL UPDATE (batch)')} </div>
              <div className="context-menu-separator" />
              <div className="context-menu-item context-menu-danger" onClick={() => { deleteRows(contextMenu.rowVisIdxs!); setContextMenu(null); }}><Icon name="close" size={13} /> Delete {contextMenu.rowVisIdxs.length} Rows</div>
            </>
          ) : (
            <>
              {contextMenu.colIdx !== undefined && (
                <>
                  <div className="context-menu-item" onClick={() => {
                    const text = contextMenu.copyText ?? getSelectionText(contextMenu.visIdx, contextMenu.colIdx);
                    if (text !== undefined) void writeClipboard(text, contextMenu.copyLabel || 'Copied value');
                    setContextMenu(null);
                  }}><Icon name="copy" size={13} /> {contextMenu.copyLabel || 'Copy value'}</div>
                  <div className="context-menu-separator" />
                </>
              )}
              <div
                className={`context-menu-item has-submenu${ctxSubmenu === 'delimited' ? ' expanded' : ''}`}
                onClick={e => { e.stopPropagation(); setCtxSubmenu(v => (v === 'delimited' ? null : 'delimited')); }}
              >
                <Icon name="copy" size={13} /> {t('Copy as CSV / TSV')}
                <span className="submenu-arrow"><Icon name="chevronRight" size={12} /></span>
                {ctxSubmenu === 'delimited' && (
                  <div className="context-menu context-submenu" onClick={e => e.stopPropagation()}>
                    <div className="context-menu-item" onClick={() => { copyRowAs('csv', contextMenu.visIdx); setContextMenu(null); }}>{t('CSV (with header)')}</div>
                    <div className="context-menu-item" onClick={() => { copyRowAs('csv-noheader', contextMenu.visIdx); setContextMenu(null); }}>{t('CSV (no header)')}</div>
                    <div className="context-menu-item" onClick={() => { copyRowAs('tsv', contextMenu.visIdx); setContextMenu(null); }}>{t('TSV (with header)')}</div>
                    <div className="context-menu-item" onClick={() => { copyRowAs('tsv-noheader', contextMenu.visIdx); setContextMenu(null); }}>{t('TSV (no header)')}</div>
                  </div>
                )}
              </div>
              <div className="context-menu-item" onClick={() => { copyRowAs('json', contextMenu.visIdx); setContextMenu(null); }}><Icon name="copy" size={13} /> {t('Copy as JSON')} </div>
              <div className="context-menu-item" onClick={() => { copyRowAs('xml', contextMenu.visIdx); setContextMenu(null); }}><Icon name="copy" size={13} /> {t('Copy as XML')} </div>
              <div className="context-menu-separator" />
              <div className="context-menu-item" onClick={() => { copyRowAs('insert', contextMenu.visIdx); setContextMenu(null); }}><Icon name="copy" size={13} /> {t('Copy as SQL INSERT')} </div>
              <div className="context-menu-item" onClick={() => { copyRowAs('update', contextMenu.visIdx); setContextMenu(null); }}><Icon name="copy" size={13} /> {t('Copy as SQL UPDATE')} </div>
              <div className="context-menu-separator" />
              <div className="context-menu-item" onClick={() => { handleQuickView(contextMenu.visIdx, 'open'); setContextMenu(null); }}><Icon name="eye" size={13} /> {t('Quick View')}</div>
              <div className="context-menu-item" onClick={() => { duplicateRow(contextMenu.visIdx); setContextMenu(null); }}><Icon name="copy" size={13} /> {t('Duplicate Row')} </div>
              <div className="context-menu-item context-menu-danger" onClick={() => { deleteRow(contextMenu.visIdx); setContextMenu(null); }}><Icon name="close" size={13} /> {t('Delete Row')} </div>
            </>
          )}
        </div>
      )}

      {/* Pagination */}
      {(page > 0 || hasMore || pageRows.length === pageSize || tableName) && (
        <div className="datagrid-pagination">
          <div className="pagination-left">
            {tableName && (
              <div className="view-toggle" role="group" aria-label="Toggle table or DDL view">
                <button className={`view-toggle-btn ${viewMode === 'table' ? 'active' : ''}`} onClick={() => switchViewMode('table')} title={t('Table view')}><Icon name="table" size={13} /></button>
                <button className={`view-toggle-btn ${viewMode === 'ddl' ? 'active' : ''}`} onClick={() => switchViewMode('ddl')} title={t('DDL view')}>{'{}'}</button>
              </div>
            )}
          </div>
          <div className="pagination-center">
            <button className="page-btn" disabled={loadingRows || page === 0 || viewMode === 'ddl'} onClick={() => handlePageChange(0)}><Icon name="chevronsLeft" size={13} /></button>
            <button className="page-btn" disabled={loadingRows || page === 0 || viewMode === 'ddl'} onClick={() => handlePageChange(page - 1)}><Icon name="chevronLeft" size={13} /></button>
            <span className="page-info">
              {viewMode === 'ddl' ? 'DDL' : (
                <>
                  {loadingRows ? t('Loading...') : ''}{t('Page {0}', page + 1)}
                  {tableName ? (
                    <button className="page-count-link" onClick={handleCountRows} title={t('Recount rows and total pages')}>
                      {totalRows !== null ? ` / ${Math.max(1, Math.ceil(totalRows / pageSize))}` : ' / ?'}
                    </button>
                  ) : ` / ${totalPages}`}
                  {totalRows !== null
                    ? ` (${t('{0} rows', totalRows.toLocaleString())})`
                    : tableName
                      ? <> (<span style={{ cursor: 'pointer', textDecoration: 'underline dotted', color: 'var(--vscode-textLink-foreground)' }} onClick={handleCountRows} title={t('Click to count all records')}>{t('count?')}</span>)</>  
                      : ` (${t('{0} rows', visibleRowsCount.toLocaleString())})`}
                </>
              )}
            </span>
            <button className="page-btn"
              disabled={loadingRows || viewMode === 'ddl' || (tableName ? !hasMore : (page + 1) * pageSize >= visibleRowsCount)}
              onClick={() => handlePageChange(page + 1)}><Icon name="chevronRight" size={13} /></button>
          </div>
          <div className="pagination-right">
            <div className="column-menu-wrap" ref={columnMenuRef}>
              <button
                className={`page-btn column-menu-btn ${showColumnMenu ? 'active' : ''}`}
                onClick={() => setShowColumnMenu(v => !v)}
                disabled={viewMode === 'ddl' || result.columns.length === 0}
                title={t('Columns')}
              >
                {t('Columns')}
              </button>
              {showColumnMenu && (
                <div className="column-menu-popover" onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
                  <div className="column-menu-header">
                    <strong>{t('Columns')}</strong>
                    <span>{visibleColumnCount}/{result.columns.length}</span>
                  </div>
                  <div className="column-menu-list">
                    {columnLayoutItems.map((item, idx) => (
                      <div key={item.key} className={`column-menu-item ${item.visible ? '' : 'hidden'}`}>
                        <label title={item.col.name}>
                          <input
                            type="checkbox"
                            checked={item.visible}
                            onChange={() => toggleColumnVisibility(item.key)}
                          />
                          <span>{item.col.name}</span>
                        </label>
                        <div className="column-menu-move">
                          <button disabled={idx === 0} onClick={() => moveColumnLayoutItem(item.key, -1)} title={t('Move up')}><Icon name="chevronUp" size={12} /></button>
                          <button disabled={idx === columnLayoutItems.length - 1} onClick={() => moveColumnLayoutItem(item.key, 1)} title={t('Move down')}><Icon name="chevronDown" size={12} /></button>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="column-menu-footer">
                    <label className="column-menu-save" title={t('Show per-row action buttons (Quick View / Duplicate)')}>
                      <input
                        type="checkbox"
                        checked={showRowActions}
                        onChange={e => setShowRowActions(e.target.checked)}
                      />
                      <span>{t('Row action buttons')}</span>
                    </label>
                    <label className="column-menu-save">
                      <input
                        type="checkbox"
                        checked={autoApplyColumnLayout}
                        onChange={e => setAutoApplyColumnLayout(e.target.checked)}
                      />
                      <span>{t('Apply automatically next time')}</span>
                    </label>
                    <button onClick={resetColumnLayout}>{t('Reset')}</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      <button className={`datagrid-log-strip ${latestLog?.level || 'info'}`} onClick={() => setShowLogDrawer(v => !v)} title={t('Toggle logs')}>
        <span className="log-toggle">{showLogDrawer ? <Icon name="chevronDown" size={12} /> : <Icon name="chevronRight" size={12} />}</span>
        <span className="log-time">{latestLog?.time || '--:--:--'}</span>
        <span className="log-message">{latestLog?.message || 'No logs yet'}</span>
        {latestLog?.query && (
          <>
            <span className="log-query-separator">-</span>
            <span
              className="log-query-inline"
              title={t('Open query')}
              onClick={e => {
                e.stopPropagation();
                setExpandedLogQuery(latestLog.query || '');
              }}
            >
              {latestLog.query}
            </span>
          </>
        )}
      </button>
      {showLogDrawer && (
        <div className="datagrid-log-drawer">
          {logEntries.length === 0 ? (
            <div className="log-empty">{t('No logs yet')}</div>
          ) : (
            <div className="log-outlook-layout">
              <div className="log-list" role="list">
                {logEntries.map(entry => (
                  <button
                    key={entry.id}
                    className={`log-list-item ${entry.level}${selectedLog?.id === entry.id ? ' active' : ''}`}
                    onClick={() => setSelectedLogId(entry.id)}
                  >
                    <span className="log-list-level">{entry.level}</span>
                    <span className="log-list-message">{entry.message}</span>
                    <span className="log-list-time">{entry.time}</span>
                  </button>
                ))}
              </div>
              <div className={`log-detail ${selectedLog?.level || 'info'}`}>
                {selectedLog && (
                  <>
                    <div className="log-detail-header">
                      <span className="log-detail-level">{selectedLog.level}</span>
                      <span className="log-detail-time">{selectedLog.time}</span>
                      <button
                        className="log-copy-btn"
                        onClick={() => {
                          const text = selectedLog.query
                            ? `${selectedLog.message}\n\nSQL:\n${selectedLog.query}`
                            : selectedLog.message;
                          void writeClipboard(text, 'Copied log');
                        }}
                      >
                        Copy
                      </button>
                    </div>
                    <pre className="log-detail-message">{selectedLog.message}</pre>
                    {selectedLog.query && (
                      <div className="log-detail-query">
                        <div className="log-detail-query-header">
                          <span>SQL</span>
                          <div>
                            <button onClick={() => setExpandedLogQuery(selectedLog.query || '')}>{t('Open')}</button>
                            <button onClick={() => void writeClipboard(selectedLog.query || '', 'Copied query')}>{t('Copy')}</button>
                          </div>
                        </div>
                        <pre className="log-detail-query-text">{selectedLog.query}</pre>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}
      {columnLocator && (
        <div className="dqv-modal-backdrop" onClick={() => setColumnLocator(null)}>
          <div className="query-modal column-locator-modal" onClick={e => e.stopPropagation()}>
            <div className="dqv-modal-header">
              <div>
                <strong>{t('Go to Column')}</strong>
                <span>Row {page * pageSize + columnLocator.rowVisIdx + 1}</span>
              </div>
              <button onClick={() => setColumnLocator(null)} title={t('Close')}>x</button>
            </div>
            <div className="column-locator-search">
              <input
                autoFocus
                value={columnLocatorQuery}
                onChange={e => { setColumnLocatorQuery(e.target.value); setColumnLocatorActive(0); }}
                placeholder={t('Filter columns...')}
                onKeyDown={e => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setColumnLocatorActive(i => Math.min(i + 1, Math.max(locatorCols.length - 1, 0)));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setColumnLocatorActive(i => Math.max(i - 1, 0));
                  } else if (e.key === 'Enter') {
                    e.preventDefault();
                    const match = locatorCols[columnLocatorActive] || locatorCols[0];
                    if (match) handleColumnLocatorPick(match.ci);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setColumnLocator(null);
                  }
                }}
              />
            </div>
            <div className="column-locator-list">
              {locatorCols.length === 0 ? (
                <div className="column-locator-empty">{t('No matching columns')}</div>
              ) : locatorCols.map(({ ci, col }, i) => (
                <button
                  key={ci}
                  className={`column-locator-item${i === columnLocatorActive ? ' active' : ''}`}
                  onMouseEnter={() => setColumnLocatorActive(i)}
                  onClick={() => handleColumnLocatorPick(ci)}
                >
                  <span className="col-name">{col.isPrimaryKey && <span className="pk-icon"><Icon name="key" size={12} /></span>}{col.name}</span>
                  <span className="col-type">{formatColumnType(col)}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {expandedQuickValue && (
        <div className="dqv-modal-backdrop" onClick={() => setExpandedQuickValue(null)}>
          <div className="dqv-modal" onClick={e => e.stopPropagation()}>
            <div className="dqv-modal-header">
              <div>
                <strong>{expandedQuickValue.name}</strong>
                <span>{expandedQuickValue.type}</span>
                {expandedQuickValue.comment && <span className="dqv-modal-comment">{expandedQuickValue.comment}</span>}
              </div>
              <button onClick={() => setExpandedQuickValue(null)} title={t('Close')}>x</button>
            </div>
            <pre className="dqv-modal-content">{expandedQuickValue.value}</pre>
            <div className="dqv-modal-actions">
              <button onClick={() => void writeClipboard(expandedQuickValue.value, 'Copied full value')}>{t('Copy')}</button>
            </div>
          </div>
        </div>
      )}
      {sqlPreview.open && (
        <div className="dqv-modal-backdrop" onClick={() => setSqlPreview(prev => ({ ...prev, open: false }))}>
          <div className="query-modal" onClick={e => e.stopPropagation()}>
            <div className="dqv-modal-header">
              <div>
                <strong>{t('Preview SQL')}</strong>
                <span>{sqlPreview.loading ? 'Generating...' : `${sqlPreview.count} change${sqlPreview.count === 1 ? '' : 's'}`}</span>
              </div>
              <button onClick={() => setSqlPreview(prev => ({ ...prev, open: false }))} title={t('Close')}>x</button>
            </div>
            {sqlPreview.loading ? (
              <div className="sql-preview-loading">
                <span className="loading-spinner" /> {t('Generating SQL preview...')} </div>
            ) : sqlPreview.error ? (
              <pre className="dqv-modal-content sql-preview-error">{sqlPreview.error}</pre>
            ) : (
              <pre className="dqv-modal-content">{sqlPreview.sql || 'No changes to preview.'}</pre>
            )}
            <div className="dqv-modal-actions">
              <button
                disabled={sqlPreview.loading || !sqlPreview.sql}
                onClick={() => void writeClipboard(sqlPreview.sql, 'Copied SQL preview')}
              >
                Copy
              </button>
            </div>
          </div>
        </div>
      )}
      {expandedLogQuery && (
        <div className="dqv-modal-backdrop" onClick={() => setExpandedLogQuery(null)}>
          <div className="query-modal" onClick={e => e.stopPropagation()}>
            <div className="dqv-modal-header">
              <div>
                <strong>{t('Query')}</strong>
                <span>SQL</span>
              </div>
              <button onClick={() => setExpandedLogQuery(null)} title={t('Close')}>x</button>
            </div>
            <pre className="dqv-modal-content">{expandedLogQuery}</pre>
            <div className="dqv-modal-actions">
              <button onClick={() => void writeClipboard(expandedLogQuery, 'Copied query')}>{t('Copy')}</button>
            </div>
          </div>
        </div>
      )}
      {copyStatus && <div className={`datagrid-toast ${copyStatus.kind}`}>{copyStatus.text}</div>}
      {headerTooltip && (
        <div className="grid-tooltip" style={{ left: headerTooltip.left, top: headerTooltip.top }}>
          {headerTooltip.text}
        </div>
      )}
    </div>
  );
}

function renderCell(value: unknown, col?: ColumnHeader): React.ReactNode {
  if (value === null || value === undefined) return <span className="null-value">NULL</span>;
  if (typeof value === 'boolean') return <span className="bool-value">{value ? <Icon name="check" size={13} /> : <Icon name="close" size={13} />}</span>;
  // Handle objects that weren't serialized yet (fallback)
  if (typeof value === 'object') {
    try { const s = JSON.stringify(value); return <span className="json-value" title={s}>{s.length > 120 ? s.substring(0, 120) + '…' : s}</span>; } catch { return <span>[object]</span>; }
  }
  const str = String(value);
  // Detect JSON strings (objects and arrays)
  const isJsonCol = col?.normalizedType === 'json';
  const looksLikeJson = (str.startsWith('{') && str.endsWith('}')) || (str.startsWith('[') && str.endsWith(']'));
  if (isJsonCol || looksLikeJson) {
    try {
      JSON.parse(str);
      const display = str.length > 120 ? str.substring(0, 120) + '…' : str;
      return <span className="json-value" title={str}>{display}</span>;
    } catch {}
  }
  return str.length > 200 ? <span title={str}>{str.substring(0, 200)}…</span> : str;
}
