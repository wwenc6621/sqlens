import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { glob } from 'glob';
import { v4 as uuidv4 } from 'uuid';
import { ConnectionManager } from './core/connection/ConnectionManager';
import { ConnectionStorage } from './core/connection/ConnectionStorage';
import { ConnectionTransfer } from './core/connection/ConnectionTransfer';
import { ConnectionTreeProvider, ConnectionDragAndDropController } from './views/sidebar/ConnectionTreeProvider';
import { SchemaTreeProvider } from './views/sidebar/SchemaTreeProvider';
import { SavedQueryTreeProvider } from './views/sidebar/SavedQueryTreeProvider';
import { Logger, LogEntry } from './core/utils/Logger';
import { WebviewManager } from './views/webview/WebviewManager';
import { QueryResultsViewProvider } from './views/webview/QueryResultsViewProvider';
import { SchemaProvider } from './core/schema/SchemaProvider';
import type { RedisDriver } from './core/drivers/RedisDriver';
import { isRedisGroup, decodeRedisKeyTable } from './core/drivers/redisTableEncoding';
import { QueryEngine } from './core/query/QueryEngine';
import { QueryHistory } from './core/query/QueryHistory';
import { SQLCompletionProvider } from './views/editor/SQLCompletionProvider';
import { SQLHoverProvider } from './views/editor/SQLHoverProvider';
import { SQLCodeLensProvider } from './views/editor/SQLCodeLensProvider';
import {
  ConnectionConfig,
  DatabaseType,
  DATABASE_TYPE_META,
  WebviewMessage,
  QueryResult,
  ColumnHeader,
  ColumnInfo,
  createDefaultConnectionConfig,
  SSLMode,
} from './core/types';
import { DriverFactory } from './core/drivers';
import type { DatabaseDriver, RowEditCapable } from './core/drivers/DatabaseDriver';
import { ProjectConnectionStorage } from './core/connection/ProjectConnectionStorage';
import { DatabaseDumpService } from './core/utils/DatabaseDumpService';
import { ImportExportService } from './core/utils/ImportExportService';
import { McpService } from './core/mcp/McpService';
import { ActivityBridge } from './core/mcp/ActivityBridge';
import { AssistantRegistrar } from './core/mcp/AssistantRegistrar';
import { initI18n, t } from './core/i18n';

let connectionManager: ConnectionManager;
let databaseDumpService: DatabaseDumpService;
let webviewManager: WebviewManager;
let connectionTreeProvider: ConnectionTreeProvider;
let savedQueryTreeProvider: SavedQueryTreeProvider;
let schemaTreeProvider: SchemaTreeProvider;
let schemaTreeView: vscode.TreeView<any>;
let schemaProvider: SchemaProvider;
let queryEngine: QueryEngine;
let queryHistory: QueryHistory;
let queryResultsViewProvider: QueryResultsViewProvider;
let queryDocContexts: Record<string, { connectionId: string, connectionName: string, database: string }> = {};
let queryContextStatusBarItem: vscode.StatusBarItem;
let extensionContext: vscode.ExtensionContext;
let sqlCodeLensProvider: SQLCodeLensProvider | undefined;
let mcpService: McpService | undefined;
let mcpActivity: ActivityBridge | undefined;
let mcpRegistrar: AssistantRegistrar | undefined;

/**
 * Per-tab message handlers for everything hosted in the Sqlens panel view
 * (`sqlens.queryResultsView`), keyed by tab instance id. One instance per
 * table/object, so the same thing can never be opened twice.
 */
const panelTabHandlers = new Map<string, (message: WebviewMessage) => void | Promise<void>>();

/** Connection that owns each open panel tab, used to close tabs on switch. */
const panelTabConnections = new Map<string, string>();

type GridSend = (message: any) => void;

/**
 * Export a query result payload (columns + rows sent by the webview) to a file
 * chosen by the user. Self-contained: needs no per-tab state, so it also works
 * for tabs replayed after an extension-host restart.
 */
async function handleExportQueryResultsMessage(message: any, send: GridSend): Promise<void> {
  const data = message.data || {};
  const format: 'csv' | 'json' | 'sql' = ['csv', 'json', 'sql'].includes(data.format) ? data.format : 'csv';
  const columns: string[] = Array.isArray(data.columns) ? data.columns : [];
  const rows: unknown[][] = Array.isArray(data.rows) ? data.rows : [];
  const targetTable: string = data.tableName || 'query_result';

  const filters: Record<string, Record<string, string[]>> = {
    csv: { 'CSV': ['csv'] },
    json: { 'JSON': ['json'] },
    sql: { 'SQL': ['sql'] },
  };
  const fileUri = await vscode.window.showSaveDialog({
    filters: filters[format],
    title: t('Export Results as {0}', format.toUpperCase()),
  });
  if (!fileUri) { return; }

  const csvEscapeField = (v: unknown): string => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const sqlValue = (v: unknown): string => {
    if (v === null || v === undefined) { return 'NULL'; }
    if (typeof v === 'number') { return String(v); }
    if (typeof v === 'boolean') { return v ? 'TRUE' : 'FALSE'; }
    return `'${String(v).replace(/'/g, "''")}'`;
  };

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('Exporting {0} row(s) as {1}...', rows.length.toLocaleString(), format.toUpperCase()), cancellable: false },
      async () => {
        let content = '';
        if (format === 'json') {
          content = JSON.stringify(
            rows.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i] ?? null]))),
            null,
            2,
          );
        } else if (format === 'sql') {
          const cols = columns.map(c => `"${c}"`).join(', ');
          content = rows
            .map(row => `INSERT INTO ${targetTable} (${cols}) VALUES (${row.map(sqlValue).join(', ')});`)
            .join('\n');
        } else {
          const lines = [columns.map(csvEscapeField).join(',')];
          for (const row of rows) { lines.push(row.map(csvEscapeField).join(',')); }
          content = lines.join('\n');
        }
        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf8'));
        send({
          type: 'copyResult',
          success: true,
          message: `Exported ${rows.length.toLocaleString()} row(s) to ${fileUri.fsPath}`,
        } as any);
      },
    );
  } catch (err) {
    send({
      type: 'copyResult',
      success: false,
      message: `Export failed: ${err instanceof Error ? err.message : String(err)}`,
    } as any);
  }
}

/**
 * Parse the table name out of a simple single-table SELECT (no JOIN/UNION/
 * GROUP BY). Returns `schema.table` or `table` with quotes stripped, or
 * undefined when the query is too complex to target safely.
 */
function extractSingleTableFromQuery(sql: string | undefined): string | undefined {
  if (!sql) { return undefined; }
  const cleaned = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  if (/\b(join|union|group\s+by|having|distinct|intersect|except)\b/i.test(cleaned)) { return undefined; }
  const ident = '(?:`[^`]+`|"[^"]+"|\\[[^\\]]+\\]|[A-Za-z_][\\w$]*)';
  const m = cleaned.match(new RegExp(`\\bfrom\\s+(${ident}(?:\\s*\\.\\s*${ident})?)`, 'i'));
  if (!m) { return undefined; }
  return m[1].replace(/[`"[\]]/g, '');
}

/**
 * Build UPDATE/INSERT/DELETE preview statements for grid edits. Always replies
 * (result or error) so the webview never hangs on its loading state. For
 * ad-hoc query tabs, the target table is parsed from the query SQL when the
 * query is a simple single-table SELECT.
 */
async function handlePreviewSQLMessage(
  message: any,
  connId: string | undefined,
  tableName: string | undefined,
  schemaName: string | undefined,
  resultColumns: any[],
  getDriver: (id: string) => any,
  send: GridSend,
  querySql?: string,
): Promise<void> {
  let targetTable = tableName;
  let targetSchema = schemaName;
  if (!targetTable) {
    const parsed = extractSingleTableFromQuery(querySql);
    if (parsed) {
      if (parsed.includes('.')) {
        const [s, t] = parsed.split('.');
        targetSchema = s;
        targetTable = t;
      } else {
        targetTable = parsed;
      }
    }
  }
  // Neither an owning table nor a parseable single-table query: edits cannot
  // be turned into UPDATE/INSERT/DELETE statements.
  if (!connId || !targetTable) {
    send({
      type: 'previewSQLError',
      data: { message: 'Preview SQL needs an editable table. Only simple single-table queries (no JOIN / UNION / GROUP BY) can be previewed from a query result.' },
    } as any);
    return;
  }
  try {
    const driver = getDriver(connId);
    if (!driver) {
      send({
        type: 'previewSQLError',
        data: { message: 'Failed to preview SQL: not connected' },
      } as any);
      return;
    }
    const changedRows = message.data.rows as any[];
    const columns = resultColumns.map(c => c.name);
    const pkCols = resultColumns.filter(c => c.isPrimaryKey).map(c => c.name);
    const escapedTable = targetSchema
      ? `${driver.escapeIdentifier(targetSchema)}.${driver.escapeIdentifier(targetTable)}`
      : driver.escapeIdentifier(targetTable);

    const stmts: string[] = [];
    for (const row of changedRows) {
      if (row.status === 'modified') {
        const sets = (row.changedCols as number[]).map(ci => `${driver.escapeIdentifier(columns[ci])} = ${driver.escapeValue(row.data[ci])}`).join(', ');
        const where = (pkCols.length > 0 ? pkCols : columns).map(col => { const ci = columns.indexOf(col); const val = row.original[ci]; return val === null ? `${driver.escapeIdentifier(col)} IS NULL` : `${driver.escapeIdentifier(col)} = ${driver.escapeValue(val)}`; }).join(' AND ');
        stmts.push(`UPDATE ${escapedTable} SET ${sets} WHERE ${where};`);
      } else if (row.status === 'added') {
        const nonNull = columns.map((col, i) => ({ col, val: row.data[i] })).filter(x => x.val !== null);
        if (nonNull.length > 0) stmts.push(`INSERT INTO ${escapedTable} (${nonNull.map(x => driver.escapeIdentifier(x.col)).join(', ')}) VALUES (${nonNull.map(x => driver.escapeValue(x.val)).join(', ')});`);
      } else if (row.status === 'deleted') {
        const where = (pkCols.length > 0 ? pkCols : columns).map(col => { const ci = columns.indexOf(col); const val = row.original[ci]; return val === null ? `${driver.escapeIdentifier(col)} IS NULL` : `${driver.escapeIdentifier(col)} = ${driver.escapeValue(val)}`; }).join(' AND ');
        stmts.push(`DELETE FROM ${escapedTable} WHERE ${where};`);
      }
    }

    const sql = stmts.length > 0 ? `-- Preview: ${stmts.length} changes\n\n${stmts.join('\n\n')}\n` : '';
    send({
      type: 'previewSQLResult',
      data: { sql, count: stmts.length },
    } as any);
  } catch (err) {
    send({
      type: 'previewSQLError',
      data: { message: `Failed to preview SQL: ${err instanceof Error ? err.message : String(err)}` },
    } as any);
  }
}

/** Tab instance id of the reusable query-results tab. */
const QUERY_RESULTS_TAB_ID = 'query-results';

/** Tab instance id of the single row quick-view tab. */
const QUICK_VIEW_TAB_ID = 'sqlens-quick-view';

/** Tab instance id of the single log-detail tab. */
const LOG_DETAIL_TAB_ID = 'log-detail';

/** De-duplicates the two command fires produced by a single double click. */
let lastTableOpen: { key: string; timestamp: number } | undefined;

type ColumnFilterOperator = 'like' | 'startsWith' | 'endsWith' | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'empty' | 'notEmpty' | 'null' | 'notNull';
interface SqlColumnFilter {
  column: number;
  operator: ColumnFilterOperator;
  value?: string;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[!%_]/g, match => `!${match}`);
}

function buildColumnFilterSql(driver: DatabaseDriver, columns: string[], filters?: SqlColumnFilter[]): string[] {
  if (!Array.isArray(filters)) return [];
  const clauses: string[] = [];

  for (const filter of filters) {
    const colName = columns[filter.column];
    if (!colName) continue;
    const col = driver.escapeIdentifier(colName);
    const op = filter.operator || 'like';
    const value = String(filter.value ?? '').trim();
    const like = (pattern: string) => `${col} LIKE ${driver.escapeValue(pattern)} ESCAPE ${driver.escapeValue('!')}`;

    if (op === 'null') clauses.push(`${col} IS NULL`);
    else if (op === 'notNull') clauses.push(`${col} IS NOT NULL`);
    else if (op === 'empty') clauses.push(`(${col} IS NULL OR ${col} = ${driver.escapeValue('')})`);
    else if (op === 'notEmpty') clauses.push(`(${col} IS NOT NULL AND ${col} <> ${driver.escapeValue('')})`);
    else {
      if (!value) continue;
      if (op === 'like') clauses.push(like(`%${escapeLikePattern(value)}%`));
      else if (op === 'startsWith') clauses.push(like(`${escapeLikePattern(value)}%`));
      else if (op === 'endsWith') clauses.push(like(`%${escapeLikePattern(value)}`));
      else if (op === 'eq') clauses.push(`${col} = ${driver.escapeValue(value)}`);
      else if (op === 'neq') clauses.push(`${col} <> ${driver.escapeValue(value)}`);
      else if (op === 'gt') clauses.push(`${col} > ${driver.escapeValue(value)}`);
      else if (op === 'gte') clauses.push(`${col} >= ${driver.escapeValue(value)}`);
      else if (op === 'lt') clauses.push(`${col} < ${driver.escapeValue(value)}`);
      else if (op === 'lte') clauses.push(`${col} <= ${driver.escapeValue(value)}`);
    }
  }

  return clauses;
}

function appendWhereClauses(sql: string, whereFilter: string | undefined, columnFilterClauses: string[]): string {
  const clauses: string[] = [];
  if (whereFilter && whereFilter.trim()) clauses.push(`(${whereFilter})`);
  clauses.push(...columnFilterClauses.map(clause => `(${clause})`));
  return clauses.length > 0 ? `${sql} WHERE ${clauses.join(' AND ')}` : sql;
}

async function getCurrentDatabaseName(connectionId: string): Promise<string> {
  const activeConn = connectionManager.getActiveConnection(connectionId);
  if (!activeConn) return '';
  try {
    return await activeConn.driver.getCurrentDatabase();
  } catch {
    return activeConn.config.database || '';
  }
}

function sanitizeFilenamePart(value: string): string {
  return value.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'database';
}

function defaultSqlDumpUri(name: string): vscode.Uri {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return vscode.Uri.file(path.join(workspaceFolder || os.homedir(), `${sanitizeFilenamePart(name)}_dump.sql`));
}

async function pickMysqlCharsetOptions(titlePrefix: string): Promise<{ charset: string; collation: string } | undefined> {
  const charsets = [
    { label: 'utf8mb4', description: t('Recommended: Full UTF-8 support') },
    { label: 'utf8', description: t('Standard UTF-8 (3-byte limit)') },
    { label: 'latin1', description: t('ISO 8859-1 West European') },
    { label: 'DEFAULT', description: t('Use server default character set') }
  ];

  const selectedCharset = await vscode.window.showQuickPick(charsets, {
    title: (t('{0}: Character Set', titlePrefix)),
    placeHolder: t('Choose character set')
  });
  if (!selectedCharset) { return undefined; }

  let collation = '';
  if (selectedCharset.label !== 'DEFAULT') {
    let collations: { label: string; description: string }[] = [];
    if (selectedCharset.label === 'utf8mb4') {
      collations = [
        { label: 'utf8mb4_0900_ai_ci', description: t('Modern Unicode 9.0 accent/case insensitive') },
        { label: 'utf8mb4_unicode_ci', description: t('Unicode accent/case insensitive') },
        { label: 'utf8mb4_general_ci', description: t('General comparison') }
      ];
    } else if (selectedCharset.label === 'utf8') {
      collations = [
        { label: 'utf8_general_ci', description: t('General collation') },
        { label: 'utf8_unicode_ci', description: t('Unicode collation') }
      ];
    } else if (selectedCharset.label === 'latin1') {
      collations = [
        { label: 'latin1_swedish_ci', description: t('Default latin1 collation') },
        { label: 'latin1_general_ci', description: t('General latin1 collation') }
      ];
    }

    if (collations.length > 0) {
      const selectedCollation = await vscode.window.showQuickPick(
        [{ label: 'DEFAULT', description: t('Use charset default collation') }, ...collations],
        {
          title: (t('{0}: Collation', titlePrefix)),
          placeHolder: t('Choose collation')
        }
      );
      if (!selectedCollation) { return undefined; }
      collation = selectedCollation.label === 'DEFAULT' ? '' : selectedCollation.label;
    }
  }

  return { charset: selectedCharset.label, collation };
}

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  initI18n(context.extensionPath);
  console.log('Sqlens extension activated');

  // Initialize core services
  connectionManager = new ConnectionManager(context);
  databaseDumpService = new DatabaseDumpService(context, connectionManager);
  webviewManager = new WebviewManager(context);
  queryHistory = new QueryHistory(context);
  queryEngine = new QueryEngine(connectionManager, queryHistory);
  queryResultsViewProvider = new QueryResultsViewProvider(context, async (message: WebviewMessage) => {
    const instanceId = (message as any).instanceId as string | undefined;

    // A tab was closed in the panel; release its handler and cached result.
    if ((message as any).type === 'closePanelTab') {
      if (instanceId) {
        panelTabHandlers.delete(instanceId);
        panelTabConnections.delete(instanceId);
        queryResultsViewProvider.removeTab(instanceId);
      }
      return;
    }

    // Route tab messages to the handler that owns that tab instance.
    if (instanceId) {
      const handler = panelTabHandlers.get(instanceId);
      if (handler) {
        await handler(message);
        return;
      }

      // Tabs replayed from cache after an extension-host restart have no live
      // handler. Preview/export are self-contained enough to still serve them
      // from the cached tab payload instead of silently dropping the message.
      const type = (message as any).type;
      if (type === 'previewSQL' || type === 'exportQueryResults') {
        const cached = queryResultsViewProvider.getTabMessage(instanceId) as any;
        const fallbackConnId = panelTabConnections.get(instanceId) || connectionManager.activeConnectionId;
        const send: GridSend = (m) => queryResultsViewProvider.postSilently({ ...m, instanceId });
        if (type === 'exportQueryResults') {
          await handleExportQueryResultsMessage(message, send);
        } else {
          await handlePreviewSQLMessage(
            message,
            fallbackConnId,
            cached?.tableName,
            cached?.schemaName,
            cached?.data?.columns || [],
            (id) => connectionManager.getDriver(id),
            send,
            cached?.querySql,
          );
        }
        return;
      }
    }

    if (message.type === 'openQuickView') {
      openQuickViewPanel(message.data.columns, message.data.rowData);
    }
    if (message.type === 'rowSelected') {
      postQuickViewRowSelected(message.data);
    }
    if ((message as any).type === 'openNewTab') {
      vscode.commands.executeCommand('sqlens.newQuery');
    }
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      QueryResultsViewProvider.viewType,
      queryResultsViewProvider
    )
  );

  // ── Panel tab helpers ──

  /** Register a handler for a panel tab and reveal it. */
  function openPanelTab(options: {
    instanceId: string;
    kind: string;
    title: string;
    connectionId?: string;
    activate?: boolean;
    /** Ask the panel to rebuild the tab so it reloads its data from scratch. */
    remount?: boolean;
    handler: (message: WebviewMessage) => void | Promise<void>;
  }) {
    panelTabHandlers.set(options.instanceId, options.handler);
    if (options.connectionId) {
      panelTabConnections.set(options.instanceId, options.connectionId);
    }
    void vscode.commands.executeCommand('sqlens.queryResultsView.focus').then(() => {
      queryResultsViewProvider.postMessage({
        type: 'openPanel',
        instanceId: options.instanceId,
        tabKind: options.kind,
        tabTitle: options.title,
        activate: options.activate !== false,
        remount: options.remount === true,
      } as any);
    });
  }

  /** Close a panel tab and release everything associated with it. */
  function closePanelTab(instanceId: string) {
    panelTabHandlers.delete(instanceId);
    panelTabConnections.delete(instanceId);
    queryResultsViewProvider.removeTab(instanceId);
    // Never reveal the panel just to close a tab.
    queryResultsViewProvider.postSilently({ type: 'closePanelTab', instanceId } as any);
  }

  /** Close every panel tab owned by a connection. */
  function closePanelTabsForConnection(connectionId: string) {
    const ids = [...panelTabConnections.entries()]
      .filter(([, connId]) => connId === connectionId)
      .map(([instanceId]) => instanceId);
    for (const instanceId of ids) { closePanelTab(instanceId); }
  }

  /** Close every panel tab whose connection is no longer active. */
  function closeInactiveConnectionPanelTabs(activeConnectionId: string | undefined) {
    const ids = [...panelTabConnections.entries()]
      .filter(([, connId]) => connId !== activeConnectionId)
      .map(([instanceId]) => instanceId);
    for (const instanceId of ids) { closePanelTab(instanceId); }
  }

  /** Push the newly selected row into the quick-view tab, when it is open. */
  function postQuickViewRowSelected(data: any) {
    if (!panelTabHandlers.has(QUICK_VIEW_TAB_ID)) { return; }
    queryResultsViewProvider.postMessage({
      type: 'rowSelected',
      instanceId: QUICK_VIEW_TAB_ID,
      tabKind: 'quickView',
      tabTitle: t('Row Quick View'),
      data,
    } as any);
  }

  schemaProvider = new SchemaProvider(connectionManager);
  connectionTreeProvider = new ConnectionTreeProvider(connectionManager, context);

  // File watcher for .sqlens.json project configurations
  const fileWatcher = vscode.workspace.createFileSystemWatcher('**/.sqlens.json');
  fileWatcher.onDidChange(() => connectionTreeProvider.refresh());
  fileWatcher.onDidCreate(() => connectionTreeProvider.refresh());
  fileWatcher.onDidDelete(() => connectionTreeProvider.refresh());
  context.subscriptions.push(fileWatcher);
  schemaTreeProvider = new SchemaTreeProvider(connectionManager);
  savedQueryTreeProvider = new SavedQueryTreeProvider(connectionManager, context);

  queryDocContexts = context.workspaceState.get<Record<string, { connectionId: string, connectionName: string, database: string }>>('queryDocContexts', {});
  queryContextStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(queryContextStatusBarItem);

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => updateStatusBar()),
    connectionManager.onActiveConnectionChanged(() => updateStatusBar()),
    connectionManager.onConnectionChanged(() => updateStatusBar())
  );

  updateStatusBar();

  // ── Tree Views ──

  const connectionsTreeView = vscode.window.createTreeView('sqlens.connections', {
      treeDataProvider: connectionTreeProvider,
      showCollapseAll: true,
      dragAndDropController: new ConnectionDragAndDropController(connectionTreeProvider),
    });
  context.subscriptions.push(
    connectionsTreeView,
  );

  // Double click on a disconnected connection row connects it. VS Code tree
  // views have no dblclick event, and re-clicking an already-selected row does
  // not fire a selection change — but the item command runs on every click.
  // So the item command records the click time and connects only when the same
  // row is clicked twice within the window.
  const DOUBLE_CLICK_MS = 400;
  const lastRowClick = new Map<string, number>();
  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.connectionRowClick', (id: string) => {
      if (!id) { return; }
      const now = Date.now();
      const previous = lastRowClick.get(id);
      if (previous !== undefined && now - previous < DOUBLE_CLICK_MS) {
        lastRowClick.delete(id);
        void vscode.commands.executeCommand('sqlens.connect', id);
        return;
      }
      lastRowClick.set(id, now);
    }),
  );

  context.subscriptions.push(
    vscode.window.createTreeView('sqlens.savedQueries', {
      treeDataProvider: savedQueryTreeProvider,
      showCollapseAll: true,
    }),
  );

  schemaTreeView = vscode.window.createTreeView('sqlens.schema', {
      treeDataProvider: schemaTreeProvider,
      showCollapseAll: true,
    });
  context.subscriptions.push(schemaTreeView);

  // ── Language Features (Phase 2) ──

  const sqlSelector: vscode.DocumentSelector = [{ language: 'sql' }, { language: 'redis' }];

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      sqlSelector,
      new SQLCompletionProvider(schemaProvider),
      '.', ' ', '\n',
    ),
  );

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      sqlSelector,
      new SQLHoverProvider(schemaProvider),
    ),
  );

  const codeLensProvider = new SQLCodeLensProvider(getQueryContextTitle);
  sqlCodeLensProvider = codeLensProvider;
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(sqlSelector, codeLensProvider),
  );

  // ── MCP Server for AI assistants ──

  const AI_ACTIVITY_TAB_ID = 'ai-activity';
  const MCP_TAB_ID = 'mcp-server';

  mcpActivity = new ActivityBridge(context);
  mcpService = new McpService(connectionManager, queryHistory, mcpActivity, (table) => {
    // Action follow: briefly select the table the AI touched in the Schema tree.
    const connId = connectionManager.activeConnectionId;
    if (!connId) { return; }
    void schemaTreeProvider
      .findTableItem(table, connId)
      .then(item => item ? schemaTreeView.reveal(item, { select: true, focus: false }) : undefined)
      .catch(() => {});
  });
  mcpRegistrar = new AssistantRegistrar(
    () => mcpService?.endpoint || '',
    () => (mcpService && extensionContext ? mcpService.getAuthToken(extensionContext) : ''),
  );

  /** Push the current activity snapshot into the AI Activity tab (creating it on first use). */
  function postAiActivityData(activate: boolean) {
    if (!mcpActivity) { return; }
    const hasTab = panelTabHandlers.has(AI_ACTIVITY_TAB_ID);
    queryResultsViewProvider.postMessage({
      type: 'aiActivityData',
      instanceId: AI_ACTIVITY_TAB_ID,
      tabKind: 'aiActivity',
      tabTitle: t('AI Activity'),
      activate,
      data: {
        entries: mcpActivity.getEntries(),
        pending: mcpActivity.getPendingWrites(),
      },
    } as any);
    if (!hasTab) {
      panelTabHandlers.set(AI_ACTIVITY_TAB_ID, async (message: WebviewMessage) => {
        const data = (message as any).data || {};
        switch ((message as any).type) {
          case 'aiActivityResult': {
            if (data.action === 'confirmWrite' || data.action === 'denyWrite') {
              mcpActivity?.resolvePending(data.pendingId, data.action === 'confirmWrite');
            } else if (data.action === 'runSql' && data.sql) {
              try {
                await queryEngine.execute(data.sql, data.connectionId);
              } catch (err) {
                vscode.window.showErrorMessage(t('AI Activity: {0}', (err as Error).message));
              }
            }
            return;
          }
          case 'clearAiActivity':
            mcpActivity?.clear();
            return;
        }
      });
    }
  }

  /** Build the serialisable status object shown in the MCP panel. */
  function buildMcpStatus() {
    const cfg = vscode.workspace.getConfiguration('sqlens.mcp');
    const enabled = cfg.get<boolean>('enabled', true);
    const readOnly = cfg.get<boolean>('readOnly', true);
    const writeMode = cfg.get<string>('writeMode', 'confirm');
    const maxRows = cfg.get<number>('maxRows', 100);
    const status = mcpService
      ? mcpService.getStatus(extensionContext)
      : { running: false, endpoint: '', port: 0, token: '' };
    const registered = mcpRegistrar ? mcpRegistrar.getRegisteredAssistants() : [];
    const activity = mcpActivity
      ? { entries: mcpActivity.getEntries().length, pending: mcpActivity.getPendingWrites().length }
      : { entries: 0, pending: 0 };
    return {
      enabled,
      running: status.running,
      endpoint: status.endpoint,
      port: status.port,
      token: status.token,
      readOnly,
      writeMode,
      maxRows,
      registeredAssistants: registered,
      activity,
    };
  }

  /** Push current MCP status into the MCP panel tab (creating it on first use). */
  function postMcpStatus(activate: boolean) {
    if (!mcpService) { return; }
    const hasTab = panelTabHandlers.has(MCP_TAB_ID);
    queryResultsViewProvider.postMessage({
      type: 'mcpStatus',
      instanceId: MCP_TAB_ID,
      tabKind: 'mcp',
      tabTitle: t('MCP Server'),
      activate,
      data: buildMcpStatus(),
    } as any);
    if (!hasTab) {
      panelTabHandlers.set(MCP_TAB_ID, async (message: WebviewMessage) => {
        const msg = message as any;
        switch (msg.type) {
          case 'mcpGetStatus':
            postMcpStatus(false);
            return;
          case 'mcpStart':
            await mcpService!.start(extensionContext);
            postMcpStatus(true);
            return;
          case 'mcpStop':
            await mcpService!.stop();
            postMcpStatus(true);
            return;
          case 'mcpRegenerateToken':
            await mcpService!.regenerateToken(extensionContext);
            postMcpStatus(true);
            return;
          case 'mcpCopyEndpoint': {
            const ep = mcpService!.endpoint;
            await vscode.env.clipboard.writeText(ep);
            vscode.window.showInformationMessage(t('Copied: {0}', ep));
            return;
          }
          case 'mcpCopyConfig':
            await vscode.env.clipboard.writeText(mcpRegistrar!.configSnippet());
            vscode.window.showInformationMessage(t('Sqlens MCP config snippet copied to clipboard.'));
            return;
          case 'mcpRegister':
            await mcpRegistrar!.registerInteractive();
            postMcpStatus(false);
            return;
          case 'mcpToggleReadOnly': {
            const next = Boolean(msg.data?.readOnly);
            await vscode.workspace.getConfiguration('sqlens.mcp').update('readOnly', next, vscode.ConfigurationTarget.Global);
            postMcpStatus(false);
            return;
          }
          case 'mcpOpenActivity':
            postAiActivityData(true);
            return;
        }
      });
    }
  }

  // Live-update the tab whenever activity changes; auto-open on first AI call.
  context.subscriptions.push(mcpActivity.onDidChange(() => {
    const hasTab = panelTabHandlers.has(AI_ACTIVITY_TAB_ID);
    if (!hasTab) {
      const entries = mcpActivity!.getEntries();
      const pending = mcpActivity!.getPendingWrites();
      const autoOpen = vscode.workspace.getConfiguration('sqlens.mcp').get<boolean>('autoOpenActivity', true);
      if ((entries.length > 0 || pending.length > 0) && autoOpen) {
        // First AI activity in this window: open the panel so the user sees it.
        postAiActivityData(true);
      }
      return;
    }
    queryResultsViewProvider.postSilently({
      type: 'aiActivityData',
      instanceId: AI_ACTIVITY_TAB_ID,
      tabKind: 'aiActivity',
      tabTitle: t('AI Activity'),
      data: {
        entries: mcpActivity!.getEntries(),
        pending: mcpActivity!.getPendingWrites(),
      },
    } as any);
  }));

  const mcpEnabled = vscode.workspace.getConfiguration('sqlens.mcp').get<boolean>('enabled', true);
  if (mcpEnabled) {
    void mcpService.start(context);
    // The MCP Server panel is opened on demand only (title-bar button or
    // command palette) — never automatically on startup.
  }

  // Refresh the MCP panel whenever the server starts/stops or the token changes.
  context.subscriptions.push(mcpService.onDidChangeStatus(() => {
    void vscode.commands.executeCommand('setContext', 'sqlens.mcpRunning', mcpService.running);
    if (panelTabHandlers.has(MCP_TAB_ID)) { postMcpStatus(false); }
  }));
  // Seed the title-bar icon state so the running (green) icon shows immediately.
  void vscode.commands.executeCommand('setContext', 'sqlens.mcpRunning', mcpService.running);

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.mcp.register', () => mcpRegistrar?.registerInteractive()),
    vscode.commands.registerCommand('sqlens.mcp.copyConfig', () => {
      if (!mcpService?.running) {
        vscode.window.showWarningMessage(t('MCP server is not running. Enable "sqlens.mcp.enabled" and reload.'));
        return;
      }
      void vscode.env.clipboard.writeText(mcpRegistrar!.configSnippet());
      vscode.window.showInformationMessage(t('Sqlens MCP config snippet copied to clipboard.'));
    }),
    vscode.commands.registerCommand('sqlens.mcp.copyEndpoint', () => {
      if (!mcpService?.running) {
        vscode.window.showWarningMessage(t('MCP server is not running.'));
        return;
      }
      void vscode.env.clipboard.writeText(mcpService.endpoint);
      vscode.window.showInformationMessage(t('Copied: {0}', mcpService.endpoint));
    }),
    vscode.commands.registerCommand('sqlens.mcp.showActivity', () => postAiActivityData(true)),
    vscode.commands.registerCommand('sqlens.mcp.openPanel', () => postMcpStatus(true)),
    // Same handler as openPanel; exists only so the title-bar icon can turn
    // green while the MCP server is running (menu `when` picks the variant).
    vscode.commands.registerCommand('sqlens.mcp.openPanel.running', () => postMcpStatus(true)),
    vscode.commands.registerCommand('sqlens.mcp.clearActivity', () => mcpActivity?.clear()),
    { dispose: () => void mcpService?.dispose() },
    mcpActivity,
  );

  // ── Logging Commands ──

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.clearLogs', () => {
      Logger.getInstance().clear();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.showLogsOutput', () => {
      Logger.getInstance().showOutput();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.showLogItem', async (log: LogEntry) => {
      if (!log) { return; }

      const title = log.message.replace(/\s+/g, ' ').trim().slice(0, 40) || 'Log Detail';
      const payload = {
        time: log.timestamp instanceof Date ? log.timestamp.toLocaleTimeString() : String(log.timestamp),
        type: log.type,
        message: log.message,
        details: log.details,
        executionTime: log.executionTime,
      };

      // A single reusable tab, refreshed for each selected entry.
      openPanelTab({
        instanceId: LOG_DETAIL_TAB_ID,
        kind: 'logDetail',
        title,
        remount: true,
        handler: (message: WebviewMessage) => {
          if (message.type === 'ready') {
            if (!panelTabHandlers.has(LOG_DETAIL_TAB_ID)) { return; }
            queryResultsViewProvider.postMessage({
              type: 'logDetailData',
              instanceId: LOG_DETAIL_TAB_ID,
              tabKind: 'logDetail',
              tabTitle: title,
              data: payload,
            } as any);
          }
        },
      });
    }),
  );

  // ── Connection Commands ──

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.newConnection', async () => {
      // Open the form directly; the form has a type tab bar, so no QuickPick
      // prompt is needed. Default to MySQL.
      const config = createDefaultConnectionConfig(DatabaseType.MySQL);
      openConnectionForm(config);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.exportConnections', async () => {
      const transfer = new ConnectionTransfer(new ConnectionStorage(context));
      const file = await transfer.exportConnections();
      if (file) {
        vscode.window.showInformationMessage(`Connections exported to ${file}`);
      }
    }),
    vscode.commands.registerCommand('sqlens.importConnections', async () => {
      const transfer = new ConnectionTransfer(new ConnectionStorage(context));
      await transfer.importConnections();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.saveConnectionToProject', async (item?: any) => {
      const id = item?.config?.id || item;
      let config: ConnectionConfig | undefined;
      const allConfigs = await connectionManager.getSavedConnections();

      if (id) {
        config = allConfigs.find(c => c.id === id);
      } else {
        const globalConfigs = allConfigs.filter(c => !c.options?.sqlensProjectConfig && !c.tags?.includes('project-config'));
        if (globalConfigs.length === 0) {
          vscode.window.showInformationMessage(t('No global connections to save to project.'));
          return;
        }
        const pick = await vscode.window.showQuickPick(
          globalConfigs.map(c => ({ label: c.name || 'Untitled', description: c.host, config: c })),
          { placeHolder: t('Select connection to save to project') }
        );
        if (pick) {
          config = pick.config;
        }
      }

      if (!config) { return; }

      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        vscode.window.showErrorMessage(t('No workspace folder open. Cannot save project connection config.'));
        return;
      }

      let selectedFolder = folders[0];
      if (folders.length > 1) {
        const folderPick = await vscode.window.showWorkspaceFolderPick({
          placeHolder: t('Select workspace folder to save connection config to'),
        });
        if (!folderPick) { return; }
        selectedFolder = folderPick;
      }

      try {
        await connectionManager.saveConnectionToProject(config, selectedFolder);
        vscode.window.showInformationMessage(t('Saved connection "{0}" to project in workspace folder "{1}".', config.name, selectedFolder.name));
        connectionTreeProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(t('Failed to save connection to project: {0}', err instanceof Error ? err.message : String(err)));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.openProjectConfig', async () => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        vscode.window.showErrorMessage(t('No workspace folder open.'));
        return;
      }

      let selectedFolder = folders[0];
      if (folders.length > 1) {
        const folderPick = await vscode.window.showWorkspaceFolderPick({
          placeHolder: t('Select workspace folder to open .sqlens.json from'),
        });
        if (!folderPick) { return; }
        selectedFolder = folderPick;
      }

      const filePath = path.join(selectedFolder.uri.fsPath, '.sqlens.json');
      if (!fs.existsSync(filePath)) {
        const create = await vscode.window.showInformationMessage(
          `No .sqlens.json file found in "${selectedFolder.name}". Create one now?`,
          'Create'
        );
        if (create === 'Create') {
          const projectStorage = new ProjectConnectionStorage(context);
          await projectStorage.saveToProject(selectedFolder, []);
        } else {
          return;
        }
      }

      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.window.showTextDocument(doc);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.searchConnections', async () => {
      const allConfigs = await connectionManager.getSavedConnections();
      if (allConfigs.length === 0) {
        vscode.window.showInformationMessage(t('No saved connections found.'));
        return;
      }

      const quickPick = vscode.window.createQuickPick();
      quickPick.title = 'Search Database Connections';
      quickPick.placeholder = 'Type to filter connections by name, host, database, type, or tags...';
      quickPick.ignoreFocusOut = true;

      const connectButton = {
        iconPath: new vscode.ThemeIcon('plug'),
        tooltip: t('Connect')
      };
      const disconnectButton = {
        iconPath: new vscode.ThemeIcon('debug-disconnect'),
        tooltip: t('Disconnect')
      };
      const editButton = {
        iconPath: new vscode.ThemeIcon('edit'),
        tooltip: t('Edit Connection')
      };
      const deleteButton = {
        iconPath: new vscode.ThemeIcon('trash'),
        tooltip: t('Delete Connection')
      };

      const mapConfigToItem = (c: ConnectionConfig) => {
        const isConnected = connectionManager.isConnected(c.id);
        const isProject = c.options?.sqlensProjectConfig === true || c.tags?.includes('project-config');
        const prefix = isProject ? '$(project) ' : '$(database) ';
        const statusText = isConnected ? 'Connected' : 'Disconnected';

        let desc = '';
        if (c.type === DatabaseType.SQLite) {
          desc = c.filepath || c.database || '';
        } else {
          desc = `${c.host}:${c.port}${c.database ? '/' + c.database : ''}`;
        }

        const buttons: vscode.QuickInputButton[] = [];
        if (isConnected) {
          buttons.push(disconnectButton);
        } else {
          buttons.push(connectButton);
        }
        buttons.push(editButton, deleteButton);

        return {
          label: `${prefix}${c.name || 'Untitled'}`,
          description: (t('{0} • {1}', desc, statusText)),
          detail: `Type: ${c.type} | Group: ${c.group || 'None'} | Tags: ${c.tags.join(', ') || 'None'}`,
          config: c,
          buttons
        };
      };

      quickPick.items = allConfigs.map(mapConfigToItem);

      quickPick.onDidAccept(async () => {
        const selectedItem = quickPick.selectedItems[0] as any;
        if (!selectedItem) { return; }
        quickPick.hide();

        const config = selectedItem.config;
        const isConnected = connectionManager.isConnected(config.id);

        if (isConnected) {
          try {
            await connectionManager.selectConnection(config.id);
            vscode.window.showInformationMessage(t('Switched to active connection: {0}', config.name));
          } catch (err) {
            vscode.window.showErrorMessage(t('Failed to select connection: {0}', err instanceof Error ? err.message : String(err)));
          }
        } else {
          try {
            await vscode.window.withProgress(
              { location: vscode.ProgressLocation.Notification, title: t('Connecting...'), cancellable: false },
              () => connectionManager.connect(config.id)
            );
            vscode.window.showInformationMessage(t('Connected to {0}', config.name));
          } catch (err) {
            vscode.window.showErrorMessage(t('Failed to connect: {0}', err instanceof Error ? err.message : String(err)));
          }
        }
      });

      quickPick.onDidTriggerItemButton(async (e) => {
        const item = e.item as any;
        const config = item.config;
        const button = e.button;

        quickPick.hide();

        if (button.tooltip === 'Connect') {
          try {
            await vscode.window.withProgress(
              { location: vscode.ProgressLocation.Notification, title: t('Connecting...'), cancellable: false },
              () => connectionManager.connect(config.id)
            );
            vscode.window.showInformationMessage(t('Connected to {0}', config.name));
          } catch (err) {
            vscode.window.showErrorMessage(t('Failed to connect: {0}', err instanceof Error ? err.message : String(err)));
          }
        } else if (button.tooltip === 'Disconnect') {
          try {
            await connectionManager.disconnect(config.id);
            vscode.window.showInformationMessage(t('Disconnected from {0}', config.name));
          } catch (err) {
            vscode.window.showErrorMessage(t('Failed to disconnect: {0}', err instanceof Error ? err.message : String(err)));
          }
        } else if (button.tooltip === 'Edit Connection') {
          vscode.commands.executeCommand('sqlens.editConnection', config.id);
        } else if (button.tooltip === 'Delete Connection') {
          vscode.commands.executeCommand('sqlens.deleteConnection', config.id);
        }
      });

      quickPick.show();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.editDatabase', async (item?: any) => {
      let connectionId = item?.connectionId || connectionManager.activeConnectionId;
      if (!connectionId) {
        vscode.window.showErrorMessage(t('No active connection. Please connect to a database first.'));
        return;
      }

      const activeConn = connectionManager.getActiveConnection(connectionId);
      if (!activeConn) {
        vscode.window.showErrorMessage(t('Connection not found or not connected.'));
        return;
      }

      const dbName = item?.dbName || await getCurrentDatabaseName(connectionId);
      if (!dbName) {
        vscode.window.showErrorMessage(t('No database selected.'));
        return;
      }

      if (activeConn.config.type !== DatabaseType.MySQL && activeConn.config.type !== DatabaseType.MariaDB) {
        vscode.window.showWarningMessage(t('Changing database charset is only supported for MySQL/MariaDB.'));
        return;
      }

      const charsetOptions = await pickMysqlCharsetOptions(`Edit database "${dbName}"`);
      if (!charsetOptions || charsetOptions.charset === 'DEFAULT') { return; }

      const collationSql = charsetOptions.collation ? ` COLLATE ${charsetOptions.collation}` : '';
      const sql = `ALTER DATABASE ${activeConn.driver.escapeIdentifier(dbName)} CHARACTER SET ${charsetOptions.charset}${collationSql}`;

      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: (t('Updating database "{0}"...', dbName)), cancellable: false },
          async () => {
            await connectionManager.query(connectionId!, sql);
          }
        );
        vscode.window.showInformationMessage(t('Database "{0}" updated successfully.', dbName));
        connectionTreeProvider.refresh();
        schemaTreeProvider.clearCache();
        schemaTreeProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(t('Failed to edit database: {0}', err instanceof Error ? err.message : String(err)));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.createDatabase', async (item?: any) => {
      let connectionId = item?.config?.id || connectionManager.activeConnectionId;
      if (!connectionId) {
        vscode.window.showErrorMessage(t('No active connection. Please connect to a database first.'));
        return;
      }

      const activeConn = connectionManager.getActiveConnection(connectionId);
      if (!activeConn) {
        vscode.window.showErrorMessage(t('Connection not found or not connected.'));
        return;
      }

      const type = activeConn.config.type;

      if (type === DatabaseType.SQLite) {
        const fileUri = await vscode.window.showSaveDialog({
          filters: { 'SQLite Database': ['sqlite', 'db', 'sqlite3'] },
          title: t('Create New SQLite Database File'),
        });
        if (!fileUri) { return; }

        const filepath = fileUri.fsPath;
        try {
          fs.writeFileSync(filepath, new Uint8Array(0));

          const newConfig = connectionManager.createConnectionConfig(DatabaseType.SQLite);
          newConfig.name = `SQLite - ${path.basename(filepath)}`;
          newConfig.filepath = filepath;
          newConfig.database = filepath;

          const newId = await connectionManager.saveConnection(newConfig);
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: t('Connecting to new SQLite database...'), cancellable: false },
            () => connectionManager.connect(newId)
          );
          vscode.window.showInformationMessage(t('Created and connected to SQLite database: {0}', path.basename(filepath)));
          connectionTreeProvider.refresh();
        } catch (err) {
          vscode.window.showErrorMessage(t('Failed to create SQLite database: {0}', err instanceof Error ? err.message : String(err)));
        }
        return;
      }

      const dbName = await vscode.window.showInputBox({
        prompt: 'Enter the name of the new database',
        placeHolder: 'my_new_database',
        validateInput: (value) => {
          if (!value || value.trim().length === 0) {
            return 'Database name cannot be empty';
          }
          if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
            return 'Database name can only contain alphanumeric characters, underscores, and hyphens';
          }
          return null;
        }
      });

      if (!dbName) { return; }

      let sql = '';

      if (type === DatabaseType.MySQL || type === DatabaseType.MariaDB) {
        const charsets = [
          { label: 'utf8mb4', description: t('Recommended: Full UTF-8 support (including emojis)') },
          { label: 'utf8', description: t('Standard UTF-8 (3-byte limit)') },
          { label: 'latin1', description: t('ISO 8859-1 West European') },
          { label: 'DEFAULT', description: t('Use server default character set') }
        ];
        const selectedCharset = await vscode.window.showQuickPick(charsets, {
          title: t('Select Character Set'),
          placeHolder: t('Choose character set for the database')
        });
        if (!selectedCharset) { return; }

        let collation = '';
        if (selectedCharset.label !== 'DEFAULT') {
          let collations: { label: string; description: string }[] = [];
          if (selectedCharset.label === 'utf8mb4') {
            collations = [
              { label: 'utf8mb4_0900_ai_ci', description: t('Recommended: Modern Unicode 9.0 accent/case insensitive') },
              { label: 'utf8mb4_unicode_ci', description: t('Unicode accent/case insensitive') },
              { label: 'utf8mb4_general_ci', description: t('Faster but slightly less accurate general comparison') }
            ];
          } else if (selectedCharset.label === 'utf8') {
            collations = [
              { label: 'utf8_general_ci', description: t('Standard general collation') },
              { label: 'utf8_unicode_ci', description: t('Standard Unicode collation') }
            ];
          }

          if (collations.length > 0) {
            const selectedCollation = await vscode.window.showQuickPick(collations, {
              title: t('Select Collation'),
              placeHolder: t('Choose collation')
            });
            if (!selectedCollation) { return; }
            collation = selectedCollation.label;
          }
        }

        sql = `CREATE DATABASE \`${dbName}\``;
        if (selectedCharset.label !== 'DEFAULT') {
          sql += ` CHARACTER SET ${selectedCharset.label}`;
          if (collation) {
            sql += ` COLLATE ${collation}`;
          }
        }

      } else if (type === DatabaseType.PostgreSQL) {
        const encodings = [
          { label: 'UTF8', description: t('Recommended: Unicode encoding') },
          { label: 'SQL_ASCII', description: t('Standard ASCII') },
          { label: 'LATIN1', description: t('ISO 8859-1 West European') },
          { label: 'DEFAULT', description: t('Use template default encoding') }
        ];
        const selectedEncoding = await vscode.window.showQuickPick(encodings, {
          title: t('Select Database Encoding'),
          placeHolder: t('Choose encoding')
        });
        if (!selectedEncoding) { return; }

        const templates = [
          { label: 'DEFAULT', description: t('Use default template (usually template1)') },
          { label: 'template1', description: t('Standard PG template database') }
        ];
        const selectedTemplate = await vscode.window.showQuickPick(templates, {
          title: t('Select Base Template'),
          placeHolder: t('Choose template database')
        });
        if (!selectedTemplate) { return; }

        sql = `CREATE DATABASE "${dbName}"`;
        if (selectedEncoding.label !== 'DEFAULT') {
          sql += ` ENCODING '${selectedEncoding.label}'`;
        }
        if (selectedTemplate.label !== 'DEFAULT') {
          sql += ` TEMPLATE ${selectedTemplate.label}`;
        }
      } else {
        vscode.window.showErrorMessage(t('Database creation is not supported for driver type: {0}', type));
        return;
      }

      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: (t('Creating database "{0}"...', dbName)), cancellable: false },
          async () => {
            await connectionManager.query(connectionId, sql);
          }
        );
        vscode.window.showInformationMessage(t('Database "{0}" created successfully.', dbName));
        vscode.commands.executeCommand('sqlens.refreshSchema');
      } catch (err) {
        vscode.window.showErrorMessage(t('Failed to create database: {0}', err instanceof Error ? err.message : String(err)));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.dumpDatabase', async (item?: any) => {
      let connectionId = item?.connectionId || item?.config?.id || (typeof item === 'string' ? item : undefined) || connectionManager.activeConnectionId;
      if (!connectionId) {
        vscode.window.showErrorMessage(t('No active connection selected for dump.'));
        return;
      }

      const activeConn = connectionManager.getActiveConnection(connectionId);
      if (!activeConn) {
        vscode.window.showErrorMessage(t('Connection is not active. Please connect first.'));
        return;
      }

      const databaseName = item?.dbName || await getCurrentDatabaseName(connectionId);
      const dumpName = databaseName || activeConn.config.database || activeConn.config.name || 'database';

      const typeItems = [
        { label: t('Full Dump'), value: 'full', description: t('Export both schema and data') },
        { label: t('Schema Only'), value: 'schema-only', description: t('Export schema structure only') },
        { label: t('Data Only'), value: 'data-only', description: t('Export records/data insert statements only') }
      ];

      const selectedType = await vscode.window.showQuickPick(typeItems, {
        placeHolder: t('Select dump type')
      });
      if (!selectedType) return;

      const fileUri = await vscode.window.showSaveDialog({
        defaultUri: defaultSqlDumpUri(dumpName),
        filters: {
          'SQL Dump File': ['sql']
        }
      });

      if (!fileUri) return;

      try {
        await databaseDumpService.dump(connectionId, {
          type: selectedType.value as any,
          outputPath: fileUri.fsPath,
          databaseName
        });
        vscode.window.showInformationMessage(t('Database dumped successfully to {0}', path.basename(fileUri.fsPath)));
      } catch (err) {
        vscode.window.showErrorMessage(t('Database dump failed: {0}', err instanceof Error ? err.message : String(err)));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.importDatabase', async (item?: any) => {
      let connectionId = item?.connectionId || item?.config?.id || (typeof item === 'string' ? item : undefined) || connectionManager.activeConnectionId;
      if (!connectionId) {
        vscode.window.showErrorMessage(t('No active connection selected for import.'));
        return;
      }

      const databaseName = item?.dbName || await getCurrentDatabaseName(connectionId);

      const fileUris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: {
          'SQL File': ['sql']
        },
        openLabel: 'Import'
      });

      if (!fileUris || fileUris.length === 0) return;
      const fileUri = fileUris[0];

      try {
        await databaseDumpService.import(connectionId, {
          inputPath: fileUri.fsPath,
          databaseName
        });
        vscode.window.showInformationMessage(t('Database imported successfully from {0}', path.basename(fileUri.fsPath)));
        vscode.commands.executeCommand('sqlens.refreshSchema');
      } catch (err) {
        vscode.window.showErrorMessage(t('Database import failed: {0}', err instanceof Error ? err.message : String(err)));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.editConnection', async (item?: any) => {
      const id = item?.config?.id || item;
      if (!id) { return; }
      const configs = await connectionManager.getSavedConnections();
      const config = configs.find(c => c.id === id);
      if (config) { openConnectionForm(config); }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.deleteConnection', async (item?: any) => {
      const id = item?.config?.id || item;
      if (!id) { return; }
      const configs = await connectionManager.getSavedConnections();
      const config = configs.find(c => c.id === id);
      if (!config) { return; }

      const confirm = await vscode.window.showWarningMessage(
        `Delete connection "${config.name || 'Untitled'}"?`,
        { modal: true },
        'Delete',
      );
      if (confirm === 'Delete') {
        await connectionManager.deleteConnection(id);
        // Saved queries belong to the connection, so they go with it.
        await savedQueryTreeProvider.deleteAllForConnection(id);
        vscode.window.showInformationMessage(t('Connection deleted.'));
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.connect', async (idOrItem?: any) => {
      const id = typeof idOrItem === 'string' ? idOrItem : idOrItem?.config?.id;
      if (!id) { return; }

      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t('Connecting...'), cancellable: false },
          () => connectionManager.connect(id),
        );

        const config = (await connectionManager.getSavedConnections()).find(c => c.id === id);
        vscode.window.showInformationMessage(t('Connected to {0}', config?.name || 'database'));
        connectionTreeProvider.refresh();
        schemaTreeProvider.clearCache();
        schemaTreeProvider.refresh();
        schemaProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(t('Connection failed: {0}', err instanceof Error ? err.message : String(err)));
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.selectConnection', async (idOrItem?: any) => {
      const id = typeof idOrItem === 'string' ? idOrItem : idOrItem?.config?.id;
      if (!id) { return; }

      try {
        await connectionManager.selectConnection(id);
        connectionTreeProvider.refresh();
        schemaTreeProvider.clearCache();
        schemaTreeProvider.refresh();
        schemaProvider.refresh();
        updateStatusBar();
        codeLensProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(t('Failed to select connection: {0}', err instanceof Error ? err.message : String(err)));
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.disconnect', async (item?: any) => {
      const id = item?.config?.id || connectionManager.activeConnectionId;
      if (!id) { return; }
      await connectionManager.disconnect(id);
      // Drop the panel tabs that belonged to the closed connection.
      closePanelTabsForConnection(id);
      vscode.window.showInformationMessage(t('Disconnected.'));
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.testConnection', async (config?: ConnectionConfig) => {
      if (!config) { return; }
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: t('Testing connection...'), cancellable: false },
        () => connectionManager.testConnection(config),
      );
      if (result.success) {
        vscode.window.showInformationMessage(result.message);
      } else {
        vscode.window.showErrorMessage(result.message);
      }
    }),
  );

  // ── Query Commands ──

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.newQuery', async (item?: any) => {
      const requestedConnId = item?.config?.id || item?.id || item?.connectionId;
      const activeConnId = requestedConnId || connectionManager.activeConnectionId;
      if (!activeConnId) {
        vscode.window.showWarningMessage(t('No active connection. Connect to a database first.'));
        return;
      }
      if (!connectionManager.isConnected(activeConnId)) {
        vscode.window.showWarningMessage(t('Selected connection is not active. Connect to a database first.'));
        return;
      }

      if (connectionManager.activeConnectionId !== activeConnId) {
        connectionManager.setActiveConnection(activeConnId);
      }

      const conn = connectionManager.getActiveConnection(activeConnId);
      const connName = conn?.config.name || 'Connected';
      const requestedDb = typeof item?.database === 'string' ? item.database : undefined;
      const db = requestedDb || await getCurrentDatabaseName(activeConnId);

      const queryLanguage = conn?.config.type === DatabaseType.Redis ? 'redis' : 'sql';
      const doc = await vscode.workspace.openTextDocument({ language: queryLanguage, content: queryLanguage === 'redis' ? '# Redis commands\n' : '-- New Query\n' });
      const uri = doc.uri.toString();

      queryDocContexts[uri] = {
        connectionId: activeConnId,
        connectionName: connName,
        database: db
      };
      await context.workspaceState.update('queryDocContexts', queryDocContexts);

      await vscode.window.showTextDocument(doc);
      updateStatusBar();
      codeLensProvider.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.runQuery', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { return; }

      try {
        await applyQueryContext(editor.document);
      } catch (err) {
        vscode.window.showErrorMessage(String(err));
        return;
      }

      if (!connectionManager.activeConnectionId) {
        vscode.window.showWarningMessage(t('No active connection. Connect to a database first.'));
        return;
      }

      const config = vscode.workspace.getConfiguration('sqlens');
      if (config.get<boolean>('autoSaveQueries', false) && editor.document.isDirty) {
        await editor.document.save();
      }

      let sql: string;
      if (!editor.selection.isEmpty) {
        sql = editor.document.getText(editor.selection);
      } else {
        sql = getCurrentStatement(editor);
      }

      sql = sql.trim();
      if (!sql) { return; }

      await executeAndShowResults(sql);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.runAllQueries', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { return; }

      try {
        await applyQueryContext(editor.document);
      } catch (err) {
        vscode.window.showErrorMessage(String(err));
        return;
      }

      if (!connectionManager.activeConnectionId) { return; }

      const config = vscode.workspace.getConfiguration('sqlens');
      if (config.get<boolean>('autoSaveQueries', false) && editor.document.isDirty) {
        await editor.document.save();
      }

      const sql = editor.document.getText().trim();
      if (!sql) { return; }

      await executeAndShowResults(sql);
    }),
  );

  // Run a specific statement identified by character offset (from CodeLens)
  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.runStatementAt', async (startOffset: number, endOffset: number) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { return; }

      try {
        await applyQueryContext(editor.document);
      } catch (err) {
        vscode.window.showErrorMessage(String(err));
        return;
      }

      if (!connectionManager.activeConnectionId) { return; }

      const config = vscode.workspace.getConfiguration('sqlens');
      if (config.get<boolean>('autoSaveQueries', false) && editor.document.isDirty) {
        await editor.document.save();
      }

      const sql = editor.document.getText().substring(startOffset, endOffset + 1).trim();
      if (!sql) { return; }

      // Remove trailing semicolon for execution
      const cleanSql = sql.endsWith(';') ? sql.slice(0, -1).trim() : sql;
      await executeAndShowResults(cleanSql);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.saveQuery', async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        await editor.document.save();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.toggleQueryAutoSave', async () => {
      const config = vscode.workspace.getConfiguration('sqlens');
      const current = config.get<boolean>('autoSaveQueries', false);
      await config.update('autoSaveQueries', !current, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(t('Sqlens Auto Save Queries: {0}', !current ? 'Enabled' : 'Disabled'));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.changeQueryContext', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'sql') return;

      const uri = editor.document.uri.toString();
      const currentContext = queryDocContexts[uri];
      const savedConfigs = await connectionManager.getSavedConnections();
      const connectedIds = connectionManager.getConnectedIds();

      if (connectedIds.length === 0) {
        vscode.window.showWarningMessage(t('No active connections. Please connect to a database first.'));
        return;
      }

      const connItems = savedConfigs
        .filter(c => connectedIds.includes(c.id))
        .sort((a, b) => {
          const currentId = currentContext?.connectionId || connectionManager.activeConnectionId;
          if (a.id === currentId) return -1;
          if (b.id === currentId) return 1;
          return 0;
        })
        .map(c => ({
          label: c.name || 'Untitled',
          description: c.id === (currentContext?.connectionId || connectionManager.activeConnectionId) ? 'current' : (c.host ? `${c.host}:${c.port}` : c.filepath),
          config: c
        }));

      if (connItems.length === 0) {
        vscode.window.showWarningMessage(t('No active connections found.'));
        return;
      }

      const selectedConn = await vscode.window.showQuickPick(connItems, { placeHolder: t('Select Connection') });
      if (!selectedConn) return;

      const driver = connectionManager.getDriver(selectedConn.config.id);
      if (!driver) return;

      let dbName = '';
      if (selectedConn.config.type !== DatabaseType.SQLite) {
        try {
          const databases = await driver.getDatabases();
          const currentDb = selectedConn.config.id === currentContext?.connectionId
            ? currentContext.database
            : await getCurrentDatabaseName(selectedConn.config.id);
          const dbItems = databases
            .map(db => ({
              label: db.name,
              description: db.name === currentDb ? 'current' : undefined,
            }))
            .sort((a, b) => {
              if (a.label === currentDb) return -1;
              if (b.label === currentDb) return 1;
              return 0;
            });
          const selectedDb = await vscode.window.showQuickPick(dbItems, { placeHolder: currentDb ? `${t('Select Database')} (${currentDb})` : t('Select Database') });
          if (!selectedDb) return;
          dbName = selectedDb.label;
        } catch (err) {
          vscode.window.showErrorMessage(t('Failed to load databases: {0}', err));
          return;
        }
      }

      // Update association
      queryDocContexts[uri] = {
        connectionId: selectedConn.config.id,
        connectionName: selectedConn.config.name || 'Connected',
        database: dbName
      };
      await context.workspaceState.update('queryDocContexts', queryDocContexts);

      // Switch context
      connectionManager.setActiveConnection(selectedConn.config.id);
      if (dbName) {
        try {
          await driver.switchDatabase(dbName);
        } catch (err) {
          // ignore SQLite unsupported errors
        }
      }

      schemaTreeProvider.clearCache();
      schemaTreeProvider.refresh();

      updateStatusBar();
      codeLensProvider.refresh();
      vscode.window.showInformationMessage(t('Query associated with: {0} [{1}]', selectedConn.config.name || 'Connected', dbName || 'main'));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.cancelQuery', async () => {
      await queryEngine.cancel();
      vscode.window.showInformationMessage(t('Query cancelled.'));
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.formatSQL', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { return; }

      try {
        const { format } = require('sql-formatter');
        const text = editor.selection.isEmpty
          ? editor.document.getText()
          : editor.document.getText(editor.selection);

        // Dialect-aware formatting: T-SQL/PostgreSQL/MySQL have their own
        // formatter grammars; document/key-value drivers get JSON formatting.
        const activeDriver = connectionManager.activeConnectionId
          ? connectionManager.getDriver(connectionManager.activeConnectionId)
          : undefined;
        const driverType = activeDriver?.driverType;

        let formatted: string;
        if (driverType === 'elasticsearch' || driverType === 'mongodb') {
          formatted = formatJsonish(text);
        } else {
          const languageByDriver: Record<string, string> = {
            mssql: 'tsql',
            postgresql: 'postgresql',
            mysql: 'mysql',
            mariadb: 'mysql',
          };
          const language = (driverType && languageByDriver[driverType]) || 'sql';
          formatted = format(text, { language, tabWidth: 2, keywordCase: 'upper' });
        }

        const range = editor.selection.isEmpty
          ? new vscode.Range(
              editor.document.positionAt(0),
              editor.document.positionAt(editor.document.getText().length),
            )
          : editor.selection;

        await editor.edit(editBuilder => { editBuilder.replace(range, formatted); });
      } catch (err) {
        vscode.window.showErrorMessage(t('Format failed: {0}', err));
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.queryHistory', async () => {
      const entry = await queryHistory.showQuickPick();
      if (entry) {
        // Open the selected query in a new editor
        const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: entry.sql + '\n' });
        await vscode.window.showTextDocument(doc);
      }
    }),
  );

  // ── Schema Commands ──

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.openTable', async (connectionIdOrItem?: any, tableInfoArg?: any) => {
      // Invoked either with (connectionId, tableInfo) from the tree item / quick
      // switcher, or with the tree item itself from the inline context menu.
      let connectionId: string | undefined = connectionIdOrItem;
      let tableInfo: any = tableInfoArg;
      if (connectionIdOrItem && typeof connectionIdOrItem === 'object') {
        tableInfo = connectionIdOrItem.tableInfo;
        connectionId = connectionIdOrItem.connectionId;
      }
      if (!connectionId || !tableInfo) { return; }

      const driver = connectionManager.getDriver(connectionId);
      if (!driver) { vscode.window.showErrorMessage(t('Not connected.')); return; }

      let attemptedSql: string | undefined;
      let gridInstanceId: string | undefined;
      try {
        const table = tableInfo.name;
        const schema = tableInfo.schema;
        // One grid instance per table, so re-opening a table reuses its tab.
        const openKey = `${connectionId}:${schema || ''}:${table}`;
        gridInstanceId = openKey;
        const now = Date.now();
        // The schema tree runs this command on both clicks of a double click.
        // Ignore the second one so a single gesture runs a single query.
        if (lastTableOpen?.key === openKey && now - lastTableOpen.timestamp < 500) {
          return;
        }
        lastTableOpen = { key: openKey, timestamp: now };
        const config = vscode.workspace.getConfiguration('sqlens');
        const pageSize = config.get<number>('defaultRowsPerPage', 100);
        const dbName = await getCurrentDatabaseName(connectionId);

        // ── Redis: no SQL — open a key-list or entry grid instead ──
        if (driver.driverType === 'redis') {
          await openRedisTable(driver as RedisDriver, connectionId, table, schema, dbName, pageSize, gridInstanceId);
          return;
        }

        const escapedTable = schema
          ? `${driver.escapeIdentifier(schema)}.${driver.escapeIdentifier(table)}`
          : driver.escapeIdentifier(table);

        // Use limit+1 trick: fetch one extra row to know if there are more pages.
        // Non-SQL drivers build their own page query (ES from/size, MongoDB
        // skip/limit, T-SQL OFFSET/FETCH, ClickHouse LIMIT/OFFSET).
        const pageAware = driver as unknown as Partial<RowEditCapable>;
        const sql = typeof pageAware.pageQuery === 'function'
          ? pageAware.pageQuery(table, pageSize + 1, schema, 0)
          : `SELECT * FROM ${escapedTable} ${driver.paginationSQL(pageSize + 1, 0)}`;
        attemptedSql = sql;

        const initialLoadingResult: QueryResult = {
          columns: [],
          rows: [],
          affectedRows: 0,
          executionTime: 0,
          truncated: false,
          messages: [],
        };

        showResultsInDataGrid(table, initialLoadingResult, table, schema, connectionId, dbName, pageSize, false, {
          instanceId: gridInstanceId,
          tabKind: 'table',
          tabTitle: table,
          activate: true,
          querySql: sql,
          loadingRows: true,
          inPanel: true,
        });

        let columnInfos: any[] = [];
        try {
          columnInfos = await driver.getColumns(table, schema);
        } catch {
          columnInfos = [];
        }

        const loadingResult: QueryResult = {
          columns: columnInfos.map(col => ({
            name: col.name,
            type: col.type,
            normalizedType: col.normalizedType,
            nullable: col.nullable,
            isPrimaryKey: col.isPrimaryKey,
            isAutoIncrement: col.isAutoIncrement,
            defaultValue: col.defaultValue ?? null,
            maxLength: col.maxLength,
            precision: col.precision,
            scale: col.scale,
            comment: col.comment,
            rawType: col.type,
            table,
            schema,
          })),
          rows: [],
          affectedRows: 0,
          executionTime: 0,
          truncated: false,
          messages: [],
        };

        if (columnInfos.length > 0) {
          showResultsInDataGrid(table, loadingResult, table, schema, connectionId, dbName, pageSize, false, {
            instanceId: gridInstanceId,
            tabKind: 'table',
            tabTitle: table,
            activate: true,
            querySql: sql,
            loadingRows: true,
            inPanel: true,
          });
        }

        const result = await driver.query(sql);

        // Enrich column types with schema info
        let enrichedResult = serializeQueryResult(result);
        if (columnInfos.length > 0) {
          const infoMap = new Map(columnInfos.map(ci => [ci.name, ci]));
          enrichedResult = {
            ...enrichedResult,
            columns: enrichedResult.columns.length > 0
              ? enrichedResult.columns.map(col => {
                  const info = infoMap.get(col.name);
                  if (!info) return col;
                  return {
                    ...col,
                    type: info.type,
                    rawType: info.type,
                    normalizedType: info.normalizedType,
                    maxLength: info.maxLength,
                    precision: info.precision,
                    scale: info.scale,
                    comment: info.comment,
                    isPrimaryKey: info.isPrimaryKey,
                    isAutoIncrement: info.isAutoIncrement,
                    nullable: info.nullable,
                  };
                })
              : columnInfos.map(col => ({
                  name: col.name,
                  type: col.type,
                  normalizedType: col.normalizedType,
                  nullable: col.nullable,
                  isPrimaryKey: col.isPrimaryKey,
                  isAutoIncrement: col.isAutoIncrement,
                  defaultValue: col.defaultValue ?? null,
                  maxLength: col.maxLength,
                  precision: col.precision,
                  scale: col.scale,
                  comment: col.comment,
                  rawType: col.type,
                  table,
                  schema,
                })),
          };
        }

        // If we got pageSize+1 rows, trim back to pageSize and note there are more
        const hasMore = enrichedResult.rows.length > pageSize;
        if (hasMore) enrichedResult = { ...enrichedResult, rows: enrichedResult.rows.slice(0, pageSize) };

        showResultsInDataGrid(table, enrichedResult, table, schema, connectionId, dbName, pageSize, hasMore, {
          instanceId: gridInstanceId,
          tabKind: 'table',
          tabTitle: table,
          activate: true,
          querySql: sql,
          loadingRows: false,
          inPanel: true,
        });
      } catch (err) {
        if (gridInstanceId) {
          queryResultsViewProvider.postMessage({
            type: 'error',
            instanceId: gridInstanceId,
            tabKind: 'table',
            tabTitle: tableInfo.name,
            activate: true,
            data: { message: `Failed to open table: ${err instanceof Error ? err.message : String(err)}` },
            querySql: attemptedSql,
          } as any);
        }
        vscode.window.showErrorMessage(t('Failed to open table: {0}', err));
      }
    }),
  );

  // ── Redis JSON export / import (P4 Dump/Import) ──
  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.redisExport', async () => {
      const connId = connectionManager.activeConnectionId;
      if (!connId) { vscode.window.showErrorMessage(t('No active connection.')); return; }
      const driver = connectionManager.getDriver(connId);
      if (!driver || driver.driverType !== 'redis') {
        vscode.window.showErrorMessage(t('Redis export requires an active Redis connection.'));
        return;
      }
      const rdriver = driver as RedisDriver;
      const filter = await vscode.window.showInputBox({ prompt: t('Key pattern to export (default *)'), value: '*' });
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: t('Exporting Redis keys...'), cancellable: false },
        async () => {
          const data = await rdriver.exportKeys(filter || '*');
          const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(`redis-dump-${Date.now()}.json`),
            filters: { JSON: ['json'] },
          });
          if (!uri) { return; }
          await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(data, null, 2)));
          vscode.window.showInformationMessage(t('Exported {0} keys to {1}', Object.keys(data).length, uri.fsPath));
        },
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.redisImport', async (uri?: vscode.Uri) => {
      const connId = connectionManager.activeConnectionId;
      if (!connId) { vscode.window.showErrorMessage(t('No active connection.')); return; }
      const driver = connectionManager.getDriver(connId);
      if (!driver || driver.driverType !== 'redis') {
        vscode.window.showErrorMessage(t('Redis import requires an active Redis connection.'));
        return;
      }
      const rdriver = driver as RedisDriver;
      const fileUri = uri || (await vscode.window.showOpenDialog({ canSelectMany: false, filters: { JSON: ['json'] } }))?.[0];
      if (!fileUri) { return; }
      try {
        const bytes = await vscode.workspace.fs.readFile(fileUri);
        const data = JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, any>;
        const n = await rdriver.importKeys(data);
        vscode.window.showInformationMessage(t('Imported {0} keys.', n));
        vscode.commands.executeCommand('sqlens.refreshConnections');
      } catch (err) {
        vscode.window.showErrorMessage(t('Redis import failed: {0}', err));
      }
    }),
  );

  // ── Elasticsearch / MongoDB / ClickHouse P4 commands ──

  /** Resolve the driver for one of these commands (explicit row or active). */
  const driverOfType = (type: string, item?: any) => {
    const connId = item?.config?.id || item?.connectionId || connectionManager.activeConnectionId;
    if (!connId) { vscode.window.showErrorMessage(t('No active connection.')); return undefined; }
    const driver = connectionManager.getDriver(connId);
    if (!driver || driver.driverType !== type) {
      vscode.window.showErrorMessage(t('This action requires an active connection of type "{0}".', type));
      return undefined;
    }
    return driver as unknown as Record<string, (...args: any[]) => Promise<any>>;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.esCreateIndex', async (item?: any) => {
      const driver = driverOfType('elasticsearch', item); if (!driver) { return; }
      const name = await vscode.window.showInputBox({ prompt: t('Index name'), placeHolder: 'my-index-000001' });
      if (!name) { return; }
      const mapping = await vscode.window.showInputBox({ prompt: t('Mappings JSON (optional)'), placeHolder: '{"properties":{"title":{"type":"text"}}}' });
      try {
        await driver.createIndex(name, mapping || undefined);
        vscode.window.showInformationMessage(t('Index "{0}" created.', name));
        await vscode.commands.executeCommand('sqlens.refreshSchema');
      } catch (err) {
        vscode.window.showErrorMessage(t('Create index failed: {0}', err));
      }
    }),
    vscode.commands.registerCommand('sqlens.esDeleteIndex', async (item?: any) => {
      const driver = driverOfType('elasticsearch', item); if (!driver) { return; }
      const name = item?.tableInfo?.name || await vscode.window.showInputBox({ prompt: t('Index name to delete') });
      if (!name) { return; }
      const confirm = await vscode.window.showWarningMessage(t('Delete index "{0}" and all its documents? This cannot be undone.', name), { modal: true }, t('Delete'));
      if (confirm !== t('Delete')) { return; }
      try {
        await driver.deleteIndex(name);
        vscode.window.showInformationMessage(t('Index "{0}" deleted.', name));
        await vscode.commands.executeCommand('sqlens.refreshSchema');
      } catch (err) {
        vscode.window.showErrorMessage(t('Delete index failed: {0}', err));
      }
    }),
    vscode.commands.registerCommand('sqlens.esExport', async (item?: any) => {
      const driver = driverOfType('elasticsearch', item); if (!driver) { return; }
      const index = item?.tableInfo?.name || await vscode.window.showInputBox({ prompt: t('Index to export') });
      if (!index) { return; }
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(`${index}-${Date.now()}.ndjson`),
        filters: { NDJSON: ['ndjson', 'json'] },
      });
      if (!uri) { return; }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: t('Exporting documents...'), cancellable: false },
        async () => {
          const ndjson = await driver.exportNdjson(index);
          await vscode.workspace.fs.writeFile(uri, Buffer.from(ndjson, 'utf8'));
          vscode.window.showInformationMessage(t('Exported documents from "{0}".', index));
        },
      );
    }),
    vscode.commands.registerCommand('sqlens.esImport', async (item?: any) => {
      const driver = driverOfType('elasticsearch', item); if (!driver) { return; }
      const file = (await vscode.window.showOpenDialog({ canSelectMany: false, filters: { NDJSON: ['ndjson', 'json'] } }))?.[0];
      if (!file) { return; }
      const index = item?.tableInfo?.name || await vscode.window.showInputBox({ prompt: t('Target index') });
      if (!index) { return; }
      try {
        const content = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
        const count = await driver.importNdjson(index, content);
        vscode.window.showInformationMessage(t('Imported documents into "{0}".', index));
        void count;
        await vscode.commands.executeCommand('sqlens.refreshSchema');
      } catch (err) {
        vscode.window.showErrorMessage(t('Import failed: {0}', err));
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.mongoCreateCollection', async (item?: any) => {
      const driver = driverOfType('mongodb', item); if (!driver) { return; }
      const name = await vscode.window.showInputBox({ prompt: t('Collection name') });
      if (!name) { return; }
      try {
        await driver.createCollection(name);
        vscode.window.showInformationMessage(t('Collection "{0}" created.', name));
        await vscode.commands.executeCommand('sqlens.refreshSchema');
      } catch (err) {
        vscode.window.showErrorMessage(t('Create collection failed: {0}', err));
      }
    }),
    vscode.commands.registerCommand('sqlens.mongoCreateIndex', async (item?: any) => {
      const driver = driverOfType('mongodb', item); if (!driver) { return; }
      const collection = item?.tableInfo?.name || await vscode.window.showInputBox({ prompt: t('Collection') });
      if (!collection) { return; }
      const keys = await vscode.window.showInputBox({ prompt: t('Index key JSON'), placeHolder: '{"status": 1}' });
      if (!keys) { return; }
      try {
        const name = await driver.createIndex(collection, keys, false);
        vscode.window.showInformationMessage(t('Index "{0}" created.', name));
      } catch (err) {
        vscode.window.showErrorMessage(t('Create index failed: {0}', err));
      }
    }),
    vscode.commands.registerCommand('sqlens.mongoExport', async (item?: any) => {
      const driver = driverOfType('mongodb', item); if (!driver) { return; }
      const collection = item?.tableInfo?.name || await vscode.window.showInputBox({ prompt: t('Collection to export') });
      if (!collection) { return; }
      const filter = await vscode.window.showInputBox({ prompt: t('Filter JSON (optional)'), placeHolder: '{"status":"PAID"}' });
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(`${collection}-${Date.now()}.json`),
        filters: { JSON: ['json'] },
      });
      if (!uri) { return; }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: t('Exporting documents...'), cancellable: false },
        async () => {
          const docs = await driver.exportJson(collection, filter || undefined);
          await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(docs, null, 2), 'utf8'));
          vscode.window.showInformationMessage(t('Exported {0} documents.', docs.length));
        },
      );
    }),
    vscode.commands.registerCommand('sqlens.mongoImport', async (item?: any) => {
      const driver = driverOfType('mongodb', item); if (!driver) { return; }
      const file = (await vscode.window.showOpenDialog({ canSelectMany: false, filters: { JSON: ['json'] } }))?.[0];
      if (!file) { return; }
      const collection = item?.tableInfo?.name || await vscode.window.showInputBox({ prompt: t('Target collection') });
      if (!collection) { return; }
      try {
        const parsed = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8'));
        const docs = Array.isArray(parsed) ? parsed : [parsed];
        const count = await driver.importJson(collection, docs);
        vscode.window.showInformationMessage(t('Imported {0} documents.', count));
        await vscode.commands.executeCommand('sqlens.refreshSchema');
      } catch (err) {
        vscode.window.showErrorMessage(t('Import failed: {0}', err));
      }
    }),
    vscode.commands.registerCommand('sqlens.mongoShell', async (item?: any) => {
      const driver = driverOfType('mongodb', item); if (!driver) { return; }
      const text = await vscode.window.showInputBox({ prompt: t('mongosh passthrough (stats / listIndexes / validate / drop / renameCollection)') });
      if (!text) { return; }
      try {
        const res = await driver.evalShell(text);
        const output = vscode.window.createOutputChannel('Sqlens mongosh');
        output.clear();
        output.appendLine(res.rows.map((r: unknown[]) => r.map(String).join(' | ')).join('\n'));
        output.show();
      } catch (err) {
        vscode.window.showErrorMessage(t('Passthrough failed: {0}', err));
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.clickhouseExport', async (item?: any) => {
      const driver = driverOfType('clickhouse', item); if (!driver) { return; }
      const table = item?.tableInfo?.name || await vscode.window.showInputBox({ prompt: t('Table to export') });
      if (!table) { return; }
      const format = await vscode.window.showQuickPick(
        ['JSONEachRow', 'CSV', 'TSV', 'JSON', 'PrettyCompact'],
        { placeHolder: t('ClickHouse FORMAT') },
      );
      if (!format) { return; }
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(`${table}-${Date.now()}.${format.toLowerCase()}`),
      });
      if (!uri) { return; }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: t('Exporting table...'), cancellable: false },
        async () => {
          const content = await driver.exportTable(table, format, item?.schema);
          await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
          vscode.window.showInformationMessage(t('Exported "{0}" as {1}.', table, format));
        },
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.mssqlBcpExport', async (item?: any) => {
      const driver = driverOfType('mssql', item); if (!driver) { return; }
      const table = item?.tableInfo?.name || await vscode.window.showInputBox({ prompt: t('Table to export with bcp') });
      if (!table) { return; }
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(`${table}-${Date.now()}.txt`),
        filters: { 'Text (tab separated)': ['txt', 'tsv', 'csv'] },
      });
      if (!uri) { return; }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: t('Exporting with bcp...'), cancellable: false },
        async () => {
          try {
            await (driver as unknown as { exportBcp: (t: string, f: string, s?: string) => Promise<void> })
              .exportBcp(table, uri.fsPath, item?.schema);
            vscode.window.showInformationMessage(t('Exported "{0}" with bcp to {1}.', table, uri.fsPath));
          } catch (err) {
            vscode.window.showErrorMessage(t('bcp export failed: {0}', err));
          }
        },
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.openStructure', async (item?: any) => {
      let connectionId = item?.connectionId || connectionManager.activeConnectionId;
      let tableInfo = item?.tableInfo;

      if (!connectionId || !tableInfo) {
        vscode.window.showErrorMessage(t('No table selected.'));
        return;
      }

      openTableStructure(connectionId, tableInfo);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.createTable', async (item?: any) => {
      let connectionId = item?.connectionId || item?.config?.id || connectionManager.activeConnectionId;
      if (!connectionId) {
        vscode.window.showErrorMessage(t('No active connection. Connect to a database first.'));
        return;
      }
      openCreateTable(connectionId);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.truncateTable', async (item?: any) => {
      let connectionId = item?.connectionId || connectionManager.activeConnectionId;
      let tableInfo = item?.tableInfo;

      if (!connectionId || !tableInfo) {
        vscode.window.showErrorMessage(t('No table selected.'));
        return;
      }

      const driver = connectionManager.getDriver(connectionId);
      if (!driver) {
        vscode.window.showErrorMessage(t('Not connected.'));
        return;
      }

      const tableName = tableInfo.name;
      const schemaName = tableInfo.schema;
      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to truncate table "${tableName}"? This will delete all rows.`,
        { modal: true },
        'Truncate'
      );

      if (confirm !== 'Truncate') { return; }

      try {
        const escapedTable = schemaName
          ? `${driver.escapeIdentifier(schemaName)}.${driver.escapeIdentifier(tableName)}`
          : driver.escapeIdentifier(tableName);

        if (driver.driverType === 'sqlite') {
          await driver.query(`DELETE FROM ${escapedTable}`);
          try {
            await driver.query(`DELETE FROM sqlite_sequence WHERE name = ${driver.escapeValue(tableName)}`);
          } catch {}
        } else {
          await driver.query(`TRUNCATE TABLE ${escapedTable}`);
        }

        vscode.window.showInformationMessage(t('Table "{0}" truncated successfully.', tableName));
        schemaTreeProvider.clearCache();
        schemaTreeProvider.refresh();
        schemaProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(t('Failed to truncate table: {0}', err instanceof Error ? err.message : err));
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.dropTable', async (item?: any) => {
      let connectionId = item?.connectionId || connectionManager.activeConnectionId;
      let tableInfo = item?.tableInfo;

      if (!connectionId || !tableInfo) {
        vscode.window.showErrorMessage(t('No table selected.'));
        return;
      }

      const driver = connectionManager.getDriver(connectionId);
      if (!driver) {
        vscode.window.showErrorMessage(t('Not connected.'));
        return;
      }

      const tableName = tableInfo.name;
      const schemaName = tableInfo.schema;
      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to drop table "${tableName}"? This cannot be undone.`,
        { modal: true },
        'Drop'
      );

      if (confirm !== 'Drop') { return; }

      try {
        const escapedTable = schemaName
          ? `${driver.escapeIdentifier(schemaName)}.${driver.escapeIdentifier(tableName)}`
          : driver.escapeIdentifier(tableName);

        await driver.query(`DROP TABLE ${escapedTable}`);

        vscode.window.showInformationMessage(t('Table "{0}" dropped successfully.', tableName));
        schemaTreeProvider.clearCache();
        schemaTreeProvider.refresh();
        schemaProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(t('Failed to drop table: {0}', err instanceof Error ? err.message : err));
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.quickSwitcher', async () => {
      const connId = connectionManager.activeConnectionId;
      if (!connId) {
        vscode.window.showWarningMessage(t('No active connection. Connect to a database first.'));
        return;
      }

      const driver = connectionManager.getDriver(connId);
      if (!driver) { return; }

      try {
        let tables: any[] = [];
        if (driver.driverType === 'postgresql') {
          const schemas = await driver.getSchemas();
          for (const s of schemas) {
            const schemaTables = await driver.getTables(s.name);
            tables.push(...schemaTables);
          }
        } else {
          tables = await driver.getTables();
        }

        const items = tables.map(t => ({
          label: t.name,
          description: t.schema ? `Schema: ${t.schema}` : '',
          detail: t.type === 'view' ? 'View' : 'Table',
          tableInfo: t
        }));

        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: t('Search table/view name...'),
          title: t('Quick Table Switcher')
        });

        if (selected) {
          vscode.commands.executeCommand('sqlens.openTable', connId, selected.tableInfo);
        }
      } catch (err) {
        vscode.window.showErrorMessage(t('Quick Switcher failed: {0}', err));
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.erDiagram', async (item?: any) => {
      const connId = item?.connectionId || item?.config?.id || connectionManager.activeConnectionId;
      if (!connId) {
        vscode.window.showWarningMessage(t('No active connection.'));
        return;
      }

      const driver = connectionManager.getDriver(connId);
      if (!driver) { return; }

      // Invoked from the Databases view the item names a database, and the diagram
      // is scoped to it; invoked from the Connections view it covers everything.
      const scopedDb: string | undefined = typeof item?.dbName === 'string' ? item.dbName : undefined;

      // One editor tab per connection + database scope, so diagrams for different
      // databases can sit side by side instead of overwriting each other.
      const panelId = `er-diagram-${connId}-${scopedDb || 'all'}`;
      const title = scopedDb ? `ER Diagram - ${scopedDb}` : 'ER Diagram';

      // ERDiagram is mounted standalone here (no panel-tab host), so it uses the
      // default instance id and drops any message tagged differently.
      const viewInstanceId = 'default';
      const send = (message: any) => {
        webviewManager.postMessage(panelId, { ...message, instanceId: viewInstanceId } as any);
      };

      const handleMessage = async (message: WebviewMessage) => {
        if (message.type === 'saveImage') {
          await saveDiagramImage(message.data.base64, message.data.fileName);
          return;
        }

        if (message.type === 'ready') {
          try {
            let tables: any[] = [];
            if (driver.driverType === 'postgresql') {
              // In PostgreSQL each database is its own catalog, reachable only
              // through its own connection — a database name is not a valid
              // schema argument for getTables().
              if (scopedDb) {
                const currentDb = await driver.getCurrentDatabase().catch(() => '');
                if (currentDb && currentDb !== scopedDb) {
                  const choice = await vscode.window.showWarningMessage(
                    `"${scopedDb}" is not the connected database. Switching reconnects the connection.`,
                    { modal: true },
                    'Switch and Open',
                  );
                  if (choice !== 'Switch and Open') { return; }
                  await driver.switchDatabase(scopedDb);
                  schemaTreeProvider.clearCache();
                  schemaTreeProvider.refresh();
                  schemaProvider.refresh();
                  connectionTreeProvider.refresh();
                }
              }
              const schemas = await driver.getSchemas();
              for (const s of schemas) {
                const schemaTables = await driver.getTables(s.name);
                tables.push(...schemaTables);
              }
            } else if (scopedDb) {
              // MySQL maps a database onto a schema, so this scopes exactly.
              tables = await driver.getTables(scopedDb);
            } else {
              tables = await driver.getTables();
            }

            const diagramData: any[] = [];
            for (const t of tables) {
              const cols = await driver.getColumns(t.name, t.schema);
              const fks = await driver.getForeignKeys(t.name, t.schema);
              diagramData.push({
                name: t.name,
                schema: t.schema,
                columns: cols,
                foreignKeys: fks
              });
            }

            send({ type: 'erDiagramData', data: diagramData });
          } catch (err) {
            // Tell the view as well, otherwise it would spin forever.
            send({
              type: 'error',
              data: { message: `Failed to load ER Diagram: ${err instanceof Error ? err.message : String(err)}` },
            });
            vscode.window.showErrorMessage(t('Failed to load ER Diagram: {0}', err));
          }
        }
      };

      const alreadyOpen = webviewManager.hasPanel(panelId);
      webviewManager.showPanel(panelId, title, 'erDiagram', handleMessage, vscode.ViewColumn.Active);
      // Reopening an existing tab rescans the schema instead of showing stale data.
      if (alreadyOpen) { send({ type: 'reloadERDiagram' }); }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.exportData', async (item?: any) => {
      let connectionId = item?.connectionId || connectionManager.activeConnectionId;
      let tableInfo = item?.tableInfo;

      if (!connectionId || !tableInfo) {
        vscode.window.showErrorMessage(t('No table selected for export.'));
        return;
      }

      const driver = connectionManager.getDriver(connectionId);
      if (!driver) { return; }

      const formatItems = [
        { label: 'CSV', value: 'csv', description: t('Comma Separated Values') },
        { label: 'JSON', value: 'json', description: t('Javascript Object Notation') },
        { label: 'SQL', value: 'sql', description: t('SQL Insert Statements Dump') }
      ];

      const selectedFormat = await vscode.window.showQuickPick(formatItems, {
        placeHolder: t('Select export format')
      });
      if (!selectedFormat) return;

      const fileUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(`${tableInfo.name}.${selectedFormat.value}`),
        filters: {
          [selectedFormat.label]: [selectedFormat.value]
        }
      });

      if (!fileUri) return;

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: (t('Exporting {0} to {1}...', tableInfo.name, selectedFormat.value.toUpperCase())),
        cancellable: false
      }, async () => {
        try {
          const escapedTable = tableInfo.schema
            ? `${driver.escapeIdentifier(tableInfo.schema)}.${driver.escapeIdentifier(tableInfo.name)}`
            : driver.escapeIdentifier(tableInfo.name);
          const sql = `SELECT * FROM ${escapedTable}`;

          await ImportExportService.exportData(
            driver,
            sql,
            selectedFormat.value as any,
            fileUri.fsPath,
            tableInfo.name
          );
          vscode.window.showInformationMessage(t('Export completed: {0}', fileUri.fsPath));
        } catch (err) {
          vscode.window.showErrorMessage(t('Export failed: {0}', err instanceof Error ? err.message : err));
        }
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.importData', async (item?: any) => {
      let connectionId = item?.connectionId || connectionManager.activeConnectionId;
      let tableInfo = item?.tableInfo;

      if (!connectionId || !tableInfo) {
        vscode.window.showErrorMessage(t('No table selected for import.'));
        return;
      }

      const driver = connectionManager.getDriver(connectionId);
      if (!driver) { return; }

      const formatItems = [
        { label: 'CSV', value: 'csv' },
        { label: 'JSON', value: 'json' }
      ];

      const selectedFormat = await vscode.window.showQuickPick(formatItems, {
        placeHolder: t('Select import file format')
      });
      if (!selectedFormat) return;

      const fileUris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: {
          [selectedFormat.label]: [selectedFormat.value]
        }
      });

      if (!fileUris || fileUris.length === 0) return;
      const fileUri = fileUris[0];

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: (t('Importing data into {0}...', tableInfo.name)),
        cancellable: false
      }, async () => {
        try {
          const result = await ImportExportService.importData(
            driver,
            tableInfo.name,
            tableInfo.schema,
            selectedFormat.value as any,
            fileUri.fsPath
          );

          if (result.errors.length > 0) {
            vscode.window.showWarningMessage(
              `Import completed with errors. Inserted: ${result.inserted} rows. First error: ${result.errors[0]}`
            );
          } else {
            vscode.window.showInformationMessage(t('Import completed successfully: {0} rows inserted.', result.inserted));
          }

          schemaTreeProvider.clearCache();
          schemaTreeProvider.refresh();
          schemaProvider.refresh();
        } catch (err) {
          vscode.window.showErrorMessage(t('Import failed: {0}', err instanceof Error ? err.message : err));
        }
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.explainPlan', async () => {
      const connId = connectionManager.activeConnectionId;
      if (!connId) {
        vscode.window.showWarningMessage(t('No active connection.'));
        return;
      }

      const driver = connectionManager.getDriver(connId);
      if (!driver) return;

      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage(t('Open an SQL file and select a query first.'));
        return;
      }

      const sql = editor.document.getText(editor.selection) || editor.document.getText();
      if (!sql.trim()) {
        vscode.window.showErrorMessage(t('No SQL query selected.'));
        return;
      }

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: t('Running EXPLAIN query...'),
        cancellable: false
      }, async () => {
        try {
          let planResult: any = null;
          if (driver.driverType === 'postgresql') {
            try {
              const res = await driver.query(`EXPLAIN (FORMAT JSON) ${sql}`);
              planResult = { format: 'json', raw: res.rows[0]?.[0] };
            } catch {
              const res = await driver.query(`EXPLAIN ${sql}`);
              planResult = { format: 'text', raw: res.rows.map(r => r[0]).join('\n') };
            }
          } else if (driver.driverType === 'mysql') {
            try {
              const res = await driver.query(`EXPLAIN FORMAT=JSON ${sql}`);
              planResult = { format: 'json', raw: res.rows[0]?.[0] || res.rows[0]?.[1] };
            } catch {
              const res = await driver.query(`EXPLAIN ${sql}`);
              planResult = { format: 'text', raw: res.rows.map(r => JSON.stringify(r)).join('\n') };
            }
          } else if (driver.driverType === 'mssql') {
            // T-SQL has no EXPLAIN; SET STATISTICS PROFILE returns plan rows.
            const res = await (driver as unknown as { explainQuery: (s: string) => Promise<any> }).explainQuery(sql);
            planResult = { format: 'text', raw: res.rows.map((r: unknown[]) => r.map(String).join(' | ')).join('\n') };
          } else if (driver.driverType === 'clickhouse') {
            const res = await driver.query(`EXPLAIN ${sql}`);
            planResult = { format: 'text', raw: res.rows.map(r => r.map(String).join(' | ')).join('\n') };
          } else if (driver.driverType === 'mongodb') {
            const res = await (driver as unknown as { explainQuery: (s: string) => Promise<any> }).explainQuery(sql);
            planResult = { format: 'json', raw: res.rows[0]?.[0] };
          } else if (driver.driverType === 'elasticsearch') {
            const index = sql.match(/^\s*(?:GET|POST)\s+\/?([^/\s?]+)\/_search/i)?.[1] || '_all';
            const body = sql.match(/\{[\s\S]*\}\s*$/)?.[0] || '';
            const res = await (driver as unknown as { explainSearch: (i: string, b: string) => Promise<any> }).explainSearch(index, body);
            planResult = { format: 'json', raw: res.rows[0]?.[0] };
          } else if (driver.driverType === 'sqlite') {
            try {
              const res = await driver.query(`EXPLAIN QUERY PLAN ${sql}`);
              planResult = { format: 'sqlite', raw: res.rows };
            } catch (err) {
              vscode.window.showErrorMessage(t('EXPLAIN failed: {0}', err));
              return;
            }
          }

          // One plan tab per connection: re-running EXPLAIN refreshes it instead
          // of piling up a new editor tab every time.
          const instanceId = `query-plan-${connId}`;
          const title = 'Query Plan';
          const planData = { sql, driverType: driver.driverType, plan: planResult };

          openPanelTab({
            instanceId,
            kind: 'queryPlan',
            title,
            connectionId: connId,
            remount: true,
            handler: (message: WebviewMessage) => {
              if (message.type === 'ready') {
                if (!panelTabHandlers.has(instanceId)) { return; }
                queryResultsViewProvider.postMessage({
                  type: 'planData',
                  instanceId,
                  tabKind: 'queryPlan',
                  tabTitle: title,
                  data: planData,
                } as any);
              }
            },
          });
        } catch (err) {
          vscode.window.showErrorMessage(t('EXPLAIN failed: {0}', err instanceof Error ? err.message : err));
        }
      });
    }),
  );

  async function openTableStructure(connectionId: string, tableInfo: any) {
    const driver = connectionManager.getDriver(connectionId);
    if (!driver) {
      vscode.window.showErrorMessage(t('Not connected.'));
      return;
    }

    let currentTableName = tableInfo.name;
    const schemaName = tableInfo.schema;
    // Deterministic id: one editor tab per table, so reopening an already open
    // table focuses that tab instead of creating a second one.
    const panelId = `table-structure-${connectionId}-${schemaName || 'default'}-${currentTableName}`;
    const currentTitle = () => `Structure: ${currentTableName}`;

    // StructureView is mounted standalone here (no panel-tab host), so it uses the
    // default instance id and drops any message tagged differently.
    const viewInstanceId = 'default';
    const send = (message: any) => {
      webviewManager.postMessage(panelId, { ...message, instanceId: viewInstanceId } as any);
    };

    const alreadyOpen = webviewManager.hasPanel(panelId);
    const panel = webviewManager.showPanel(panelId, currentTitle(), 'structureView', async (message: WebviewMessage) => {
      if (message.type === 'ready') {
        try {
          const columns = await driver.getColumns(currentTableName, schemaName);
          const indexes = await driver.getIndexes(currentTableName, schemaName);
          const foreignKeys = await driver.getForeignKeys(currentTableName, schemaName);

          const ddl = await getTableDDL(driver, currentTableName, schemaName);
          let tableComment = '';
          try {
            const allTables = await driver.getTables(schemaName);
            tableComment = allTables.find(t => t.name === currentTableName)?.comment || '';
          } catch { /* comment is optional */ }

          send({
            type: 'structureData',
            data: {
              tableName: currentTableName,
              schemaName,
              tableComment,
              columns,
              indexes,
              foreignKeys,
              ddl
            }
          });
        } catch (err) {
          vscode.window.showErrorMessage(t('Failed to load structure: {0}', err));
        }
      }

      if (message.type === 'getDriverType') {
        send({
          type: 'driverType',
          data: { type: driver.driverType }
        });
      }

      if (message.type === 'getTableList') {
        try {
          const tables = await driver.getTables(message.data?.schemaName || schemaName);
          send({
            type: 'tableList',
            data: { tables }
          });
        } catch (err) {
          send({
            type: 'error',
            data: { message: `Failed to load table list: ${err instanceof Error ? err.message : String(err)}` }
          });
        }
      }

      if (message.type === 'executeDDL') {
        try {
          const sql = message.data.sql;
          await driver.queryMultiple(sql);

          if (message.data.renameTo) {
            currentTableName = message.data.renameTo;
            // Reflect the new name in the editor tab label.
            panel.title = currentTitle();
          }

          vscode.window.showInformationMessage(t('Structure updated successfully.'));
          send({ type: 'reloadStructure' });
          schemaTreeProvider.clearCache();
          schemaTreeProvider.refresh();
          schemaProvider.refresh();
        } catch (err) {
          vscode.window.showErrorMessage(t('Failed to apply changes: {0}', err instanceof Error ? err.message : err));
        }
      }
      }, vscode.ViewColumn.Active);

    // Reopening a table that already has an editor tab pulls fresh schema data,
    // matching the reload behaviour of the old panel tab.
    if (alreadyOpen) { send({ type: 'reloadStructure' }); }
  }

  async function openCreateTable(connectionId: string) {
    const driver = connectionManager.getDriver(connectionId);
    if (!driver) {
      vscode.window.showErrorMessage(t('Not connected.'));
      return;
    }

    // One editor tab per connection: reopening focuses the existing tab.
    const panelId = `create-table-${connectionId}`;
    const title = 'Create Table';

    // CreateTable is mounted standalone here (no panel-tab host), so it uses the
    // default instance id and drops any message tagged differently.
    const viewInstanceId = 'default';
    const send = (message: any) => {
      webviewManager.postMessage(panelId, { ...message, instanceId: viewInstanceId } as any);
    };

    const handleMessage = async (message: WebviewMessage) => {
      if (message.type === 'ready' || message.type === 'getDriverType') {
        send({
          type: 'driverType',
          data: { type: driver.driverType }
        });
      }

      if (message.type === 'ready' || message.type === 'getTableList') {
        try {
          const tables = await driver.getTables(message.type === 'getTableList' ? message.data?.schemaName : undefined);
          send({
            type: 'tableList',
            data: { tables }
          });
        } catch (err) {
          send({
            type: 'error',
            data: { message: `Failed to load table list: ${err instanceof Error ? err.message : String(err)}` }
          });
        }
      }

      if (message.type === 'executeCreateTable') {
        try {
          const sql = message.data.sql;
          await driver.queryMultiple(sql);
          vscode.window.showInformationMessage(t('Table "{0}" created successfully.', message.data.tableName));
          webviewManager.closePanel(panelId);
          schemaTreeProvider.clearCache();
          schemaTreeProvider.refresh();
          schemaProvider.refresh();
        } catch (err) {
          vscode.window.showErrorMessage(t('Failed to create table: {0}', err instanceof Error ? err.message : err));
        }
      }
    };

    webviewManager.showPanel(panelId, title, 'createTable', handleMessage, vscode.ViewColumn.Active);
  }

  /**
   * Resolve the driver behind a schema-tree item. The item carries its own
   * connection id, so a table can be acted on even when another connection is
   * the active one.
   */
  /**
   * Write a base64 PNG produced by a webview to a file the user picks. Webviews
   * cannot open a native save dialog themselves, so the export round-trips here.
   */
  async function saveDiagramImage(dataUrl: string, suggestedName: string): Promise<void> {
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const stem = (suggestedName || 'diagram').replace(/\.png$/i, '').replace(/[^\w.-]+/g, '_') || 'diagram';

    const options: vscode.SaveDialogOptions = {
      title: t('Export Image'),
      filters: { PNG: ['png'] },
    };
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (folder) { options.defaultUri = vscode.Uri.joinPath(folder, `${stem}.png`); }

    const target = await vscode.window.showSaveDialog(options);
    if (!target) { return; }

    try {
      await vscode.workspace.fs.writeFile(target, Buffer.from(base64, 'base64'));
      vscode.window.showInformationMessage(t('Image saved to {0}', target.fsPath));
    } catch (err) {
      vscode.window.showErrorMessage(t('Failed to save the image: {0}', err instanceof Error ? err.message : String(err)));
    }
  }

  function resolveItemDriver(item?: any): { driver: any; tableInfo: any } | undefined {
    const connectionId = item?.connectionId || connectionManager.activeConnectionId;
    const tableInfo = item?.tableInfo;
    if (!connectionId || !tableInfo) { return undefined; }
    const driver = connectionManager.getDriver(connectionId);
    if (!driver) { return undefined; }
    return { driver, tableInfo };
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.showDDL', async (item?: any) => {
      const resolved = resolveItemDriver(item);
      if (!resolved) { return; }

      try {
        const ddl = await getTableDDL(resolved.driver, resolved.tableInfo.name, resolved.tableInfo.schema);
        const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: ddl + ';\n' });
        // Reuse the active column — an extra split would steal width from the
        // grid the user is looking at.
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preview: false });
      } catch (err) {
        vscode.window.showErrorMessage(t('Failed to get DDL: {0}', err));
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.copyCreateTable', async (item?: any) => {
      const resolved = resolveItemDriver(item);
      if (!resolved) {
        vscode.window.showErrorMessage(t('No table selected.'));
        return;
      }

      const { driver, tableInfo } = resolved;
      try {
        const statement = (await getTableDDL(driver, tableInfo.name, tableInfo.schema)).trim();
        if (!statement) {
          vscode.window.showWarningMessage(t('No CREATE TABLE statement available for "{0}".', tableInfo.name));
          return;
        }
        await vscode.env.clipboard.writeText(statement.endsWith(';') ? statement : `${statement};`);
        vscode.window.showInformationMessage(t('CREATE TABLE statement for "{0}" copied to clipboard.', tableInfo.name));
      } catch (err) {
        vscode.window.showErrorMessage(t('Failed to copy DDL: {0}', err instanceof Error ? err.message : String(err)));
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.renameTable', async (item?: any) => {
      const resolved = resolveItemDriver(item);
      if (!resolved) {
        vscode.window.showErrorMessage(t('No table selected.'));
        return;
      }

      const { driver, tableInfo } = resolved;
      if (tableInfo.type && tableInfo.type !== 'table') {
        vscode.window.showWarningMessage(t('Only tables can be renamed.'));
        return;
      }

      const currentName: string = tableInfo.name;
      const newName = await vscode.window.showInputBox({
        title: (t('Rename table "{0}"', currentName)),
        prompt: 'Enter the new table name',
        value: currentName,
        valueSelection: [0, currentName.length],
        validateInput: (value) => {
          const name = value.trim();
          if (!name) { return 'Table name cannot be empty.'; }
          if (name === currentName) { return 'Enter a different name.'; }
          if (!/^[\w$]+$/.test(name)) { return 'Use letters, digits, underscore or $ only.'; }
          return undefined;
        },
      });
      if (newName === undefined) { return; }
      const target = newName.trim();

      const schemaName: string | undefined = tableInfo.schema;
      const qualified = schemaName
        ? `${driver.escapeIdentifier(schemaName)}.${driver.escapeIdentifier(currentName)}`
        : driver.escapeIdentifier(currentName);
      const targetQualified = schemaName
        ? `${driver.escapeIdentifier(schemaName)}.${driver.escapeIdentifier(target)}`
        : driver.escapeIdentifier(target);

      try {
        // PostgreSQL and SQLite rename with ALTER TABLE ... RENAME TO, MySQL uses
        // RENAME TABLE and needs both sides qualified to stay in the same schema.
        const sql = driver.driverType === 'mysql'
          ? `RENAME TABLE ${qualified} TO ${targetQualified}`
          : `ALTER TABLE ${qualified} RENAME TO ${driver.escapeIdentifier(target)}`;
        await driver.query(sql);
        vscode.window.showInformationMessage(t('Table "{0}" renamed to "{1}".', currentName, target));
        schemaTreeProvider.clearCache();
        schemaTreeProvider.refresh();
        schemaProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(t('Failed to rename table: {0}', err instanceof Error ? err.message : String(err)));
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.switchDatabase', async (connectionId?: string, dbName?: string) => {
      if (!connectionId) { connectionId = connectionManager.activeConnectionId; }
      if (!connectionId) { return; }

      const driver = connectionManager.getDriver(connectionId);
      if (!driver) { return; }

      if (!dbName) {
        const databases = await driver.getDatabases();
        const selected = await vscode.window.showQuickPick(databases.map(db => db.name), { placeHolder: t('Select database') });
        if (!selected) { return; }
        dbName = selected;
      }

      try {
        if (connectionManager.activeConnectionId !== connectionId) {
          await connectionManager.selectConnection(connectionId);
        }

        const currentDb = await driver.getCurrentDatabase().catch(() => '');
        if (currentDb !== dbName) {
          await driver.switchDatabase(dbName);
        }
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.languageId === 'sql') {
          const uri = editor.document.uri.toString();
          const mapped = queryDocContexts[uri];
          if (mapped?.connectionId === connectionId) {
            queryDocContexts[uri] = { ...mapped, database: dbName };
            await context.workspaceState.update('queryDocContexts', queryDocContexts);
          }
        }
        connectionTreeProvider.refresh();
        schemaTreeProvider.clearCache();
        schemaTreeProvider.refresh();
        schemaProvider.refresh();
        updateStatusBar();
        codeLensProvider.refresh();
        vscode.window.showInformationMessage(t('Switched to database: {0}', dbName));
      } catch (err) {
        vscode.window.showErrorMessage(t('Failed to switch database: {0}', err));
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.openTerminal', async (item?: any) => {
      let connectionId = item?.id || item?.connectionId || connectionManager.activeConnectionId;
      if (!connectionId) {
        vscode.window.showWarningMessage(t('No connection selected.'));
        return;
      }

      const activeConn = connectionManager.getActiveConnection(connectionId);
      if (!activeConn) {
        vscode.window.showErrorMessage(t('Connection is not active. Please connect first.'));
        return;
      }

      const { config, driver, tunnel } = activeConn;
      let activeDb = config.database || '';
      if (driver && driver.isConnected) {
        try {
          activeDb = await driver.getCurrentDatabase();
        } catch {}
      }

      const connectHost = tunnel ? '127.0.0.1' : config.host;
      const connectPort = tunnel ? tunnel.localPort : config.port;

      let shellCommand = '';
      const terminalName = `Sqlens CLI: ${config.name}`;

      if (config.type === 'mysql') {
        const portOption = connectPort ? `-P ${connectPort}` : '';
        const dbOption = activeDb ? (driver?.escapeIdentifier ? driver.escapeIdentifier(activeDb) : activeDb) : '';
        const passwordPart = config.password ? `-p"${config.password.replace(/"/g, '\\"')}"` : '';
        shellCommand = `mysql -h ${connectHost} ${portOption} -u ${config.username} ${passwordPart} ${dbOption}`;
      } else if (config.type === 'postgresql') {
        const portOption = connectPort ? `-p ${connectPort}` : '';
        const dbOption = activeDb ? `-d "${activeDb.replace(/"/g, '\\"')}"` : '';
        const envPart = config.password ? `PGPASSWORD="${config.password.replace(/"/g, '\\"')}" ` : '';
        shellCommand = `${envPart}psql -h ${connectHost} ${portOption} -U ${config.username} ${dbOption}`;
      } else if (config.type === 'sqlite') {
        const dbPath = config.database;
        if (!dbPath) {
          vscode.window.showErrorMessage(t('SQLite database file path is not set.'));
          return;
        }
        shellCommand = `sqlite3 "${dbPath.replace(/"/g, '\\"')}"`;
      } else {
        vscode.window.showErrorMessage(t('Terminal CLI integration is not supported for {0}.', config.type));
        return;
      }

      try {
        const terminal = vscode.window.createTerminal({ name: terminalName });
        terminal.show();
        terminal.sendText(shellCommand);
      } catch (err) {
        vscode.window.showErrorMessage(t('Failed to open terminal CLI: {0}', err));
      }
    }),
  );

  // ── Refresh Commands ──

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.refreshConnections', () => connectionTreeProvider.refresh()),

    vscode.commands.registerCommand('sqlens.refreshDatabases', async (item?: any) => {
      // Re-query the connection's database list, then redraw the tree.
      const connectionId = ConnectionTreeProvider.getConnectionId(item);
      if (connectionId) {
        const driver = connectionManager.getDriver(connectionId);
        if (driver) {
          try { await driver.getDatabases(); } catch { // stale connection; tree will render from cache/error path
          }
        }
      }
      connectionTreeProvider.refresh();
    }),
  );

  // ── Connection folders ──

  /** Ask for a folder name, rejecting empty or already-taken ones. */
  async function promptGroupName(options: { title: string; value?: string; taken?: string[] }): Promise<string | undefined> {
    const taken = new Set((options.taken || []).map(name => name.toLowerCase()));
    const result = await vscode.window.showInputBox({
      title: options.title,
      prompt: 'Folder name',
      value: options.value,
      valueSelection: options.value ? [0, options.value.length] : undefined,
      validateInput: (input) => {
        const name = input.trim();
        if (!name) { return 'Folder name cannot be empty.'; }
        if (taken.has(name.toLowerCase())) { return `A folder named "${name}" already exists.`; }
        return undefined;
      },
    });
    return result?.trim() || undefined;
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.newConnectionGroup', async () => {
      const name = await promptGroupName({
        title: t('New Connection Folder'),
        taken: await connectionTreeProvider.listGroupNames(),
      });
      if (!name) { return; }
      await connectionTreeProvider.addGroup(name);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.renameConnectionGroup', async (item?: any) => {
      const from: string | undefined = item?.groupName;
      if (!from) {
        vscode.window.showErrorMessage(t('No folder selected.'));
        return;
      }

      const taken = (await connectionTreeProvider.listGroupNames()).filter(name => name !== from);
      const to = await promptGroupName({ title: (t('Rename Folder "{0}"', from)), value: from, taken });
      if (!to || to === from) { return; }

      const moved = await connectionTreeProvider.renameGroup(from, to);
      vscode.window.showInformationMessage(
        `Folder "${from}" renamed to "${to}"${moved > 0 ? ` (${moved} connection${moved > 1 ? 's' : ''} moved)` : ''}.`,
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.deleteConnectionGroup', async (item?: any) => {
      const name: string | undefined = item?.groupName;
      if (!name) { return; }

      const count: number = item?.children?.length ?? 0;
      const confirm = await vscode.window.showWarningMessage(
        count > 0
          ? `Delete folder "${name}"? Its ${count} connection${count > 1 ? 's are' : ' is'} kept and moved out of the folder.`
          : `Delete empty folder "${name}"?`,
        { modal: true },
        'Delete Folder',
      );
      if (confirm !== 'Delete Folder') { return; }

      const moved = await connectionTreeProvider.removeGroup(name);
      if (moved > 0) {
        vscode.window.showInformationMessage(t('Folder "{0}" deleted; {1} connection{2} moved out.', name, moved, moved > 1 ? 's' : ''));
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.moveConnectionToGroup', async (item?: any) => {
      const id: string | undefined = item?.config?.id;
      if (!id) { return; }

      const current: string | undefined = item?.config?.group;
      const groups = await connectionTreeProvider.listGroupNames();
      const newFolderLabel = '$(add) New Folder...';
      const noFolderLabel = '$(circle-slash) No Folder';

      const picks: vscode.QuickPickItem[] = [
        ...groups.map(name => ({ label: name, description: name === current ? 'current' : undefined })),
        ...(current ? [{ label: noFolderLabel }] : []),
        { label: newFolderLabel },
      ];

      const choice = await vscode.window.showQuickPick(picks, {
        title: t('Move Connection to Folder'),
        placeHolder: current ? t('Current folder: {0}', current) : t('Currently not in a folder'),
      });
      if (!choice) { return; }

      if (choice.label === newFolderLabel) {
        const name = await promptGroupName({ title: t('New Connection Folder'), taken: groups });
        if (!name) { return; }
        await connectionTreeProvider.moveConnectionsToGroup([id], name);
        return;
      }

      const target = choice.label === noFolderLabel ? undefined : choice.label;
      if (target === current) { return; }
      await connectionTreeProvider.moveConnectionsToGroup([id], target);
    }),
  );

  // ── Saved queries ──

  /**
   * Bind a saved query document to its connection. The connection id is part of
   * the file path, so the binding survives a window reload and does not depend on
   * which connection happens to be active.
   */
  async function bindSavedQueryContext(document: vscode.TextDocument): Promise<void> {
    if (document.languageId !== 'sql') { return; }

    const connectionId = savedQueryTreeProvider.connectionIdForUri(document.uri);
    if (!connectionId) { return; }

    const key = document.uri.toString();
    if (queryDocContexts[key]?.connectionId === connectionId) { return; }

    const config = (await connectionManager.getSavedConnections()).find(c => c.id === connectionId);
    const database = connectionManager.isConnected(connectionId)
      ? await getCurrentDatabaseName(connectionId)
      : (config?.database || '');

    queryDocContexts[key] = {
      connectionId,
      connectionName: config?.name || 'Connection',
      database,
    };
    await context.workspaceState.update('queryDocContexts', queryDocContexts);
    updateStatusBar();
    sqlCodeLensProvider?.refresh();
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(document => void bindSavedQueryContext(document)),
  );
  // Documents restored from the previous session are already open at activation.
  for (const document of vscode.workspace.textDocuments) {
    void bindSavedQueryContext(document);
  }

  /** Ask for a query name. `taken` is only passed for rename, where a clash
   *  would mean overwriting an existing query; creation bumps the name instead. */
  async function promptQueryName(options: { title: string; value?: string; taken?: string[] }): Promise<string | undefined> {
    const taken = new Set((options.taken || []).map(name => name.toLowerCase()));
    const result = await vscode.window.showInputBox({
      title: options.title,
      prompt: 'Query name',
      value: options.value,
      valueSelection: options.value ? [0, options.value.length] : undefined,
      validateInput: (input) => {
        const name = input.trim();
        if (!name) { return 'Query name cannot be empty.'; }
        if (taken.has(name.toLowerCase())) { return `A query named "${name}" already exists for this connection.`; }
        return undefined;
      },
    });
    return result?.trim() || undefined;
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.newSavedQuery', async (item?: any) => {
      let connectionId: string | undefined = item?.config?.id || item?.connectionId || item?.id;

      // Invoked from the Saved SQL title bar: pick the owning connection first.
      if (!connectionId) {
        const configs = await connectionManager.getSavedConnections();
        if (configs.length === 0) {
          vscode.window.showWarningMessage(t('Create a connection first.'));
          return;
        }
        const picked = await vscode.window.showQuickPick(
          configs.map(config => ({
            label: config.name || 'Untitled',
            description: connectionManager.isConnected(config.id) ? 'connected' : undefined,
            id: config.id,
          })),
          { title: t('New Saved Query'), placeHolder: t('Choose the connection this query belongs to') },
        );
        if (!picked) { return; }
        connectionId = picked.id;
      }

      if (!connectionId) { return; }
      const config = (await connectionManager.getSavedConnections()).find(c => c.id === connectionId);
      if (!config) { return; }

      const name = await promptQueryName({ title: t('New Saved Query'), value: 'query' });
      if (!name) { return; }

      const uri = await savedQueryTreeProvider.createQuery(connectionId, name, config.name || 'Connection');
      await bindSavedQueryContext(await vscode.workspace.openTextDocument(uri));
      await vscode.window.showTextDocument(uri);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.renameSavedQuery', async (item?: any) => {
      const uri: vscode.Uri | undefined = item?.uri;
      const connectionId: string | undefined = item?.connectionId;
      if (!uri || !connectionId) { return; }

      const current = (uri.path.split('/').pop() || '').replace(/\.sql$/i, '');
      const taken = (await savedQueryTreeProvider.existingNames(connectionId))
        .filter(name => name !== current);
      const name = await promptQueryName({ title: (t('Rename Query "{0}"', current)), value: current, taken });
      if (!name || name === current) { return; }

      const previousKey = uri.toString();
      const target = await savedQueryTreeProvider.renameQuery(uri, name);

      // The document URI changed, so the connection binding has to move with it.
      if (queryDocContexts[previousKey]) {
        queryDocContexts[target.toString()] = queryDocContexts[previousKey];
        delete queryDocContexts[previousKey];
        await context.workspaceState.update('queryDocContexts', queryDocContexts);
      }
      updateStatusBar();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.deleteSavedQuery', async (item?: any) => {
      const uri: vscode.Uri | undefined = item?.uri;
      if (!uri) { return; }

      const name = (uri.path.split('/').pop() || '').replace(/\.sql$/i, '');
      const confirm = await vscode.window.showWarningMessage(
        `Delete saved query "${name}"?`,
        { modal: true },
        'Delete',
      );
      if (confirm !== 'Delete') { return; }

      await savedQueryTreeProvider.deleteQuery(uri);
      delete queryDocContexts[uri.toString()];
      await context.workspaceState.update('queryDocContexts', queryDocContexts);
      vscode.window.showInformationMessage(t('Saved query "{0}" deleted.', name));
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.refreshSavedQueries', () => savedQueryTreeProvider.refresh()),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlens.refreshSchema', async () => {
      const selectedTable = schemaTreeView.selection
        .map((item: any) => item?.tableInfo ? {
          name: item.tableInfo.name as string,
          schema: item.tableInfo.schema as string | undefined,
          connectionId: item.connectionId as string,
        } : undefined)
        .find(Boolean);
      schemaTreeProvider.clearCache();
      schemaTreeProvider.refresh();
      schemaProvider.refresh();
      if (selectedTable) {
        setTimeout(() => {
          void schemaTreeProvider
            .findTableItem(selectedTable.name, selectedTable.connectionId, selectedTable.schema)
            .then(item => {
              if (item) {
                return schemaTreeView.reveal(item, { select: true, focus: false });
              }
              return undefined;
            });
        }, 150);
      }
    }),
  );

  // ── Status Bar ──

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'sqlens.switchDatabase';
  context.subscriptions.push(statusBar);

  connectionManager.onActiveConnectionChanged(async (id) => {
    // Switching (or losing) the active connection closes the previous tabs.
    closeInactiveConnectionPanelTabs(id);
    if (id) {
      const configs = await connectionManager.getSavedConnections();
      const config = configs.find(c => c.id === id);
      const driver = connectionManager.getDriver(id);
      if (config && driver) {
        try {
          const db = await driver.getCurrentDatabase();
          const meta = DATABASE_TYPE_META[config.type];
          statusBar.text = `$(database) ${config.name}: ${db}`;
          statusBar.tooltip = `${meta?.label || config.type} — Click to switch database`;
          statusBar.show();
        } catch {
          statusBar.text = `$(database) ${config.name}`;
          statusBar.show();
        }
      }
    } else {
      statusBar.hide();
    }
  });

  // ── Helper Functions ──

  function serializeQueryResult(result: QueryResult): QueryResult {
    const serializeRows = (rows: unknown[][]): unknown[][] => rows.map(row =>
      row.map(v => {
        if (v === null || v === undefined) return null;
        if (Buffer.isBuffer(v)) return v.toString('utf8');
        if (typeof v === 'bigint') return v.toString();
        if (typeof v === 'object') {
          try { return JSON.stringify(v); } catch { return String(v); }
        }
        return v;
      }),
    );

    return {
      ...result,
      rows: serializeRows(result.rows),
      // Extra result sets (T-SQL batches) get the same treatment.
      ...(result.resultSets
        ? { resultSets: result.resultSets.map(set => ({ columns: set.columns, rows: serializeRows(set.rows) })) }
        : {}),
    };
  }

  function csvEscape(value: unknown): string {
    if (value === null || value === undefined) return '';
    const text = String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function tsvEscape(value: unknown): string {
    if (value === null || value === undefined) return '';
    return String(value).replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
  }

  function openConnectionForm(config: ConnectionConfig) {
    const panelId = `connection-form-${config.id || 'new'}`;
    const title = config.name ? `Edit: ${config.name}` : 'New Connection';

    webviewManager.showPanel(panelId, title, 'connectionForm', async (message: WebviewMessage) => {
      switch (message.type) {
        case 'saveConnection': {
          try {
            await connectionManager.saveConnection(message.data);
            webviewManager.postMessage(panelId, { type: 'saveResult', data: { success: true, message: 'Connection saved.' } });
            webviewManager.closePanel(panelId);
            vscode.window.showInformationMessage(t('Connection saved.'));
          } catch (err) {
            webviewManager.postMessage(panelId, { type: 'saveResult', data: { success: false, message: `Failed: ${err}` } });
          }
          break;
        }
        case 'testConnection': {
          const result = await connectionManager.testConnection(message.data);
          if (result.success) { vscode.window.showInformationMessage(result.message); }
          else { vscode.window.showErrorMessage(result.message); }
          break;
        }
        case 'ready':
          webviewManager.postMessage(panelId, { type: 'connectionConfig', data: config });
          try {
            const sshHosts = parseSSHConfig();
            webviewManager.postMessage(panelId, { type: 'sshHosts', data: sshHosts });
          } catch (err) {
            Logger.getInstance().logError('Failed to send SSH hosts to connection form', err);
          }
          break;
      }
    });
  }

  /**
   * Pull table names out of a SELECT so drivers that do not report per-column
   * source metadata (SQLite) can still resolve declared column types.
   */
  function extractReferencedTables(sql: string): { name: string; schema?: string }[] {
    const tables: { name: string; schema?: string }[] = [];
    const seen = new Set<string>();
    const re = /\b(?:from|join)\s+([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(sql)) !== null) {
      const raw = match[1];
      const lower = raw.toLowerCase();
      if (seen.has(lower)) { continue; }
      seen.add(lower);
      const dot = raw.indexOf('.');
      if (dot > 0) {
        tables.push({ schema: raw.slice(0, dot), name: raw.slice(dot + 1) });
      } else {
        tables.push({ name: raw });
      }
    }
    return tables;
  }

  /**
   * Replace the drivers' generic result column types (e.g. `varchar`, `TEXT`)
   * with the schema-declared type (e.g. `varchar(64)`), so grid headers show
   * the real column type.
   */
  async function enrichResultColumnTypes(
    driver: DatabaseDriver,
    columns: ColumnHeader[],
    sql: string,
  ): Promise<ColumnHeader[]> {
    try {
      const cache = new Map<string, ColumnInfo[]>();
      const loadColumns = async (table: string, schema?: string): Promise<ColumnInfo[]> => {
        const key = `${schema || ''}.${table}`;
        let cached = cache.get(key);
        if (!cached) {
          try {
            cached = await driver.getColumns(table, schema);
          } catch {
            cached = [];
          }
          cache.set(key, cached);
        }
        return cached;
      };

      // PostgreSQL result fields only carry OIDs, so resolve them once via the
      // catalog to obtain the full declared type.
      const pgTypes = new Map<string, string>();
      if (driver.driverType === 'postgresql') {
        const oids = [...new Set(
          columns
            .filter(c => c.table && Number.isFinite(Number(c.table)))
            .map(c => Number(c.table)),
        )];
        if (oids.length > 0) {
          try {
            const res = await driver.query(
              `SELECT a.attrelid::text AS oid, a.attnum::text AS attnum, format_type(a.atttypid, a.atttypmod) AS type
               FROM pg_attribute a
               WHERE a.attrelid = ANY($1::oid[]) AND a.attnum > 0 AND NOT a.attisdropped`,
              [oids],
            );
            for (const row of res.rows as unknown as unknown[][]) {
              pgTypes.set(`${row[0]}:${row[1]}`, String(row[2]));
            }
          } catch { /* fall back to the generic type */ }
        }
      }

      const sqliteTables = driver.driverType === 'sqlite' ? extractReferencedTables(sql) : [];

      const enriched: ColumnHeader[] = [];
      for (const column of columns) {
        if (driver.driverType === 'postgresql') {
          const pgType = column.table && column.columnId !== undefined
            ? pgTypes.get(`${column.table}:${column.columnId}`)
            : undefined;
          enriched.push(pgType ? { ...column, type: pgType, rawType: pgType } : column);
          continue;
        }

        let candidates: ColumnInfo[] = [];
        if (column.table) {
          candidates = await loadColumns(column.table, column.schema);
        } else if (sqliteTables.length > 0) {
          for (const table of sqliteTables) {
            candidates = candidates.concat(await loadColumns(table.name, table.schema));
          }
        }

        const info = candidates.find(i => i.name.toLowerCase() === column.name.toLowerCase());
        if (!info) {
          enriched.push(column);
          continue;
        }
        enriched.push({
          ...column,
          type: info.type,
          rawType: info.type,
          normalizedType: info.normalizedType,
          maxLength: info.maxLength,
          precision: info.precision,
          scale: info.scale,
          comment: info.comment,
        });
      }
      return enriched;
    } catch {
      return columns;
    }
  }

  /** Derive a short tab title from the executed SQL (first meaningful line). */
  function queryTabTitle(sql: string): string {
    const line = sql
      .split('\n')
      .map(l => l.replace(/--[^\n]*/, '').trim())
      .find(l => l.length > 0);
    const text = (line || 'Query').replace(/\s+/g, ' ');
    return text.length > 28 ? `${text.slice(0, 28)}…` : text;
  }

  async function executeAndShowResults(sql: string) {
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: t('Running query...'), cancellable: true },
        async () => queryEngine.execute(sql),
      );
      const serializedResult = serializeQueryResult(result);

      // Give the result columns their real, schema-declared type.
      const activeConnectionId = connectionManager.activeConnectionId;
      const activeDriver = activeConnectionId ? connectionManager.getDriver(activeConnectionId) : undefined;
      if (activeDriver && serializedResult.columns.length > 0) {
        serializedResult.columns = await enrichResultColumnTypes(activeDriver, serializedResult.columns, sql);
      }

      if (serializedResult.columns.length > 0) {
        // Each execution gets its own tab: a unique instance id plus a live
        // grid handler, so several results coexist in the panel view.
        const instanceId = `query-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const pageSize = vscode.workspace.getConfiguration('sqlens').get<number>('defaultRowsPerPage', 1000);
        showResultsInDataGrid(
          'Query Results',
          serializedResult,
          undefined,
          undefined,
          activeConnectionId || undefined,
          undefined,
          pageSize,
          false,
          {
            inPanel: true,
            instanceId,
            tabKind: 'query',
            tabTitle: queryTabTitle(sql),
            querySql: sql,
            activate: true,
          },
        );

        // Additional result sets (T-SQL multi-SELECT / stored procedures)
        // open as their own read-only tabs.
        (serializedResult.resultSets || []).forEach((set, index) => {
          showResultsInDataGrid(
            `Result ${index + 2}`,
            {
              columns: set.columns,
              rows: set.rows,
              affectedRows: 0,
              executionTime: 0,
              truncated: false,
              messages: [],
            },
            undefined,
            undefined,
            activeConnectionId || undefined,
            undefined,
            pageSize,
            false,
            {
              inPanel: true,
              instanceId: `${instanceId}-set${index + 2}`,
              tabKind: 'query',
              tabTitle: `${queryTabTitle(sql)} (${index + 2})`,
              querySql: sql,
              activate: false,
            },
          );
        });
      } else {
        vscode.window.showInformationMessage(
          `Query executed: ${result.affectedRows} rows affected (${result.executionTime}ms)`
        );
      }
    } catch (err) {
      queryResultsViewProvider.postMessage({
        type: 'error',
        instanceId: QUERY_RESULTS_TAB_ID,
        tabKind: 'query',
        tabTitle: t('Query Results'),
        activate: true,
        data: { message: `Query error: ${err instanceof Error ? err.message : String(err)}` },
        querySql: sql,
      } as any);
      vscode.window.showErrorMessage(t('Query error: {0}', err instanceof Error ? err.message : err));
    }
  }

  // ── Redis grid helpers (no SQL — SCAN / entry commands instead) ──

  async function openRedisTable(
    driver: RedisDriver,
    connectionId: string,
    table: string,
    schema: string | undefined,
    dbName: string,
    pageSize: number,
    instanceId: string,
  ): Promise<void> {
    let columns: ColumnHeader[];
    let firstResult: QueryResult;
    let hasMore = false;
    let querySql = '';
    let tabTitle = table;
    if (isRedisGroup(table)) {
      columns = driver.getKeyListColumns().columns;
      const r = await driver.getKeyList(table, 0, pageSize);
      firstResult = r.result; hasMore = r.hasMore;
      querySql = `SCAN ${table}`;
      tabTitle = table;
    } else {
      const decoded = decodeRedisKeyTable(table);
      if (!decoded) { return; }
      columns = driver.getEntryColumns(decoded.type);
      const r = await driver.getEntryList(decoded.type, decoded.key, 0, pageSize);
      firstResult = r.result; hasMore = r.hasMore;
      querySql = `KEY ${decoded.key}`;
      tabTitle = decoded.key;
    }
    const enriched: QueryResult = { ...firstResult, columns };
    showResultsInDataGrid(tabTitle, enriched, table, schema, connectionId, dbName, pageSize, hasMore, {
      instanceId,
      tabKind: 'table',
      tabTitle,
      activate: true,
      querySql,
      loadingRows: false,
      inPanel: true,
    });
  }

  /**
   * Route grid messages (paging / save / copy) for Redis tables to the driver's
   * SCAN/entry APIs. Returns true when the message was handled as Redis.
   */
  async function handleRedisGridMessage(
    message: any,
    send: (m: any) => void,
    connId: string,
    tableName: string,
  ): Promise<boolean> {
    const driver = connectionManager.getDriver(connId) as RedisDriver | undefined;
    if (!driver) { return false; }
    const isKey = !isRedisGroup(tableName);
    const pageSize = vscode.workspace.getConfiguration('sqlens').get<number>('defaultRowsPerPage', 1000);
    try {
      if (message.type === 'fetchPage') {
        const page = message.data?.page ?? 0;
        if (isKey) {
          const d = decodeRedisKeyTable(tableName);
          if (!d) { return true; }
          const { result, hasMore } = await driver.getEntryList(d.type, d.key, page, pageSize);
          send({ type: 'pageData', page, data: result, columns: result.columns, hasMore, pageSize, querySql: `KEY ${d.key}` } as any);
        } else {
          const filter = message.data?.whereFilter as string | undefined;
          const { result, hasMore } = await driver.getKeyList(tableName, page, pageSize, filter);
          send({ type: 'pageData', page, data: result, columns: result.columns, hasMore, pageSize, querySql: `SCAN ${tableName}` } as any);
        }
        return true;
      }

      if (message.type === 'saveChanges') {
        const changedRows = message.data?.rows as any[] ?? [];
        const columns = isKey
          ? driver.getEntryColumns(decodeRedisKeyTable(tableName)!.type).map(c => c.name)
          : driver.getKeyListColumns().columns.map(c => c.name);
        await driver.applyRedisEdits(tableName, changedRows, columns);
        vscode.window.showInformationMessage(t('{0} changes saved.', changedRows.length));
        const r = isKey
          ? await driver.getEntryList(decodeRedisKeyTable(tableName)!.type, decodeRedisKeyTable(tableName)!.key, 0, pageSize)
          : await driver.getKeyList(tableName, 0, pageSize);
        send({ type: 'queryResult', data: r.result, columns: r.result.columns, tableName, schemaName: undefined, pageSize, hasMore: r.hasMore, querySql: tableName } as any);
        return true;
      }

      if (message.type === 'copyTableData') {
        const format: 'csv' | 'tsv' = message.data?.format === 'tsv' ? 'tsv' : 'csv';
        const separator = format === 'tsv' ? '\t' : ',';
        const escapeCell = format === 'tsv' ? tsvEscape : csvEscape;
        const data = isKey
          ? (await driver.getEntryList(decodeRedisKeyTable(tableName)!.type, decodeRedisKeyTable(tableName)!.key, 0, 5000)).result
          : (await driver.getKeyList(tableName, 0, 5000)).result;
        const header = data.columns.map(c => escapeCell(c.name)).join(separator);
        const body = data.rows.map((row: any[]) => row.map(r => escapeCell(String(r))).join(separator)).join('\n');
        await vscode.env.clipboard.writeText(`${header}\n${body}`);
        send({ type: 'copyResult', success: true, message: `Copied ${data.rows.length.toLocaleString()} row${data.rows.length === 1 ? '' : 's'} as ${format.toUpperCase()}` } as any);
        return true;
      }

      // countRows: SCAN has no exact total; leave it unknown to the grid.
      return true;
    } catch (err) {
      send({ type: 'error', data: { message: `Redis operation failed: ${err instanceof Error ? err.message : String(err)}` } } as any);
      vscode.window.showErrorMessage(t('Redis operation failed: {0}', err));
      return true;
    }
  }

  function showResultsInDataGrid(
    title: string,
    result: QueryResult,
    tableName?: string,
    schemaName?: string,
    connectionId?: string,
    database?: string,
    pageSizeOverride?: number,
    initialHasMore = false,
    options?: {
      pinned?: boolean;
      panelId?: string;
      querySql?: string;
      loadingRows?: boolean;
      inPanel?: boolean;
      instanceId?: string;
      tabKind?: 'table' | 'query';
      tabTitle?: string;
      activate?: boolean;
    }
  ) {
    const inPanel = options?.inPanel === true;
    const panelId = options?.panelId || (options?.pinned
      ? `data-grid-${connectionId || 'active'}-${database || 'default'}-${schemaName || 'default'}-${tableName || Date.now()}-${Date.now()}`
      : 'data-grid-preview');
    const connId = connectionId || connectionManager.activeConnectionId;
    const pageSizeForGrid = pageSizeOverride || vscode.workspace.getConfiguration('sqlens').get<number>('defaultRowsPerPage', 1000);
    const instanceId = options?.instanceId || panelId;
    const messagePayload = { type: 'queryResult', data: result, tableName, schemaName, pageSize: pageSizeForGrid, hasMore: initialHasMore, querySql: options?.querySql, loadingRows: !!options?.loadingRows } as any;

    // Every message carries the tab instance so the panel can route it to the
    // right grid and keep exactly one tab per table.
    const tabMeta = {
      instanceId,
      tabKind: options?.tabKind,
      tabTitle: options?.tabTitle,
    };

    // Route grid responses either to the panel view or to a dedicated editor panel.
    const send = (message: any) => {
      const payload = { ...message, ...tabMeta };
      if (inPanel) {
        // Drop responses for a tab the user already closed.
        if (!panelTabHandlers.has(instanceId)) { return; }
        queryResultsViewProvider.postMessage(payload);
      } else {
        webviewManager.postMessage(panelId, payload);
      }
    };

    const handleMessage = async (message: WebviewMessage) => {
      if (message.type === 'ready') {
        send(messagePayload);
      }

      // Route Redis grid operations away from the SQL machinery.
      if ((message.type === 'fetchPage' || message.type === 'saveChanges' || message.type === 'copyTableData') && connId && tableName) {
        const d = connectionManager.getDriver(connId);
        if (d && d.driverType === 'redis') {
          await handleRedisGridMessage(message, send, connId, tableName);
          return;
        }
      }

      if (message.type === 'rowSelected') {
        postQuickViewRowSelected(message.data);
      }

      if (message.type === 'countRows' && connId && tableName) {
        const driver = connectionManager.getDriver(connId);
        if (driver) {
          try {
            const escapedTable = schemaName
              ? `${driver.escapeIdentifier(schemaName)}.${driver.escapeIdentifier(tableName)}`
              : driver.escapeIdentifier(tableName);
            const whereFilter = (message as any).data?.whereFilter as string | undefined;
            const columnFilters = (message as any).data?.columnFilters as SqlColumnFilter[] | undefined;
            const columnFilterClauses = buildColumnFilterSql(driver, result.columns.map(c => c.name), columnFilters);
            let countSql = `SELECT COUNT(*) AS total FROM ${escapedTable}`;
            countSql = appendWhereClauses(countSql, whereFilter, columnFilterClauses);
            const countResult = await driver.query(countSql);
            const firstRow = countResult.rows[0] as any;
            const total = Number(firstRow?.total ?? firstRow?.TOTAL ?? firstRow?.[0] ?? 0);
            send({
              type: 'totalRowsCount',
              data: { totalRows: total },
              querySql: countSql,
            } as any);
          } catch (err) {
            vscode.window.showErrorMessage(t('Failed to count table rows: {0}', err));
          }
        }
      }

      if (message.type === 'getDDL' && connId && tableName) {
        const driver = connectionManager.getDriver(connId);
        if (driver) {
          try {
            const ddl = await getTableDDL(driver, tableName, schemaName);
            send({ type: 'ddlData', data: { ddl } });
          } catch (err) {
            send({
              type: 'error',
              data: { message: `Failed to load DDL: ${err instanceof Error ? err.message : String(err)}` },
            });
          }
        }
      }

      if (message.type === 'fetchPage' && connId && tableName) {
        const driver = connectionManager.getDriver(connId);
        if (driver) {
          // Drivers that page natively (Elasticsearch from/size, MongoDB
          // skip/limit, T-SQL OFFSET/FETCH, ClickHouse LIMIT/OFFSET) build
          // their own query; the SQL family keeps the generated SELECT below.
          const pageAware = driver as unknown as Partial<RowEditCapable>;
          if (typeof pageAware.pageQuery === 'function') {
            const page = message.data.page ?? 0;
            const pageSize = vscode.workspace.getConfiguration('sqlens').get<number>('defaultRowsPerPage', 1000);
            try {
              // pageQuery may refuse a deep jump synchronously (no cursor yet).
              const pagedSql = pageAware.pageQuery!(tableName, pageSize + 1, schemaName, page * pageSize);
              const result = serializeQueryResult(await driver.query(pagedSql));
              const hasMore = result.rows.length > pageSize;
              send({
                type: 'pageData',
                page,
                data: { ...result, rows: hasMore ? result.rows.slice(0, pageSize) : result.rows },
                columns: result.columns,
                hasMore,
                pageSize,
                querySql: pagedSql,
              } as any);
            } catch (err) {
              send({ type: 'error', data: { message: err instanceof Error ? err.message : String(err) } } as any);
            }
            return;
          }

          let sql: string | undefined;
          try {
            const page = message.data.page;
            const sortStates: { column: number; direction: 'asc' | 'desc' }[] = (message as any).data.sortStates || [];
            const whereFilter: string | undefined = (message as any).data.whereFilter;
            const columnFilters = (message as any).data.columnFilters as SqlColumnFilter[] | undefined;

            const escapedTable = schemaName
              ? `${driver.escapeIdentifier(schemaName)}.${driver.escapeIdentifier(tableName)}`
              : driver.escapeIdentifier(tableName);

            sql = `SELECT * FROM ${escapedTable}`;
            const columnFilterClauses = buildColumnFilterSql(driver, result.columns.map(c => c.name), columnFilters);
            sql = appendWhereClauses(sql, whereFilter, columnFilterClauses);
            if (sortStates.length > 0) {
              const orderParts = sortStates.map(s => {
                const colName = result.columns[s.column]?.name;
                if (!colName) return null;
                return `${driver.escapeIdentifier(colName)} ${s.direction === 'desc' ? 'DESC' : 'ASC'}`;
              }).filter(Boolean).join(', ');
              if (orderParts) sql += ` ORDER BY ${orderParts}`;
            }

            const pageSize = vscode.workspace.getConfiguration('sqlens').get<number>('defaultRowsPerPage', 1000);
            const offset = page * pageSize;
            // Use limit+1 trick to detect if next page exists
            sql += ` ${driver.paginationSQL(pageSize + 1, offset)}`;

            const pageResult = serializeQueryResult(await driver.query(sql));

            const hasMore = pageResult.rows.length > pageSize;
            const trimmedRows = hasMore ? pageResult.rows.slice(0, pageSize) : pageResult.rows;

            send({
              type: 'pageData',
              page,
              data: { ...pageResult, columns: result.columns, rows: trimmedRows },
              sortStates: sortStates,
              hasMore,
              pageSize,
              totalRows: hasMore ? undefined : (offset + trimmedRows.length),
              querySql: sql,
            } as any);
          } catch (err) {
            send({
              type: 'error',
              data: { message: `Failed to fetch page data: ${err instanceof Error ? err.message : String(err)}` },
              querySql: sql,
            } as any);
            vscode.window.showErrorMessage(t('Failed to fetch page data: {0}', err));
          }
        }
      }

      if ((message as any).type === 'copyTableData' && connId && tableName) {
        const driver = connectionManager.getDriver(connId);
        if (driver) {
          try {
            await vscode.window.withProgress(
              { location: vscode.ProgressLocation.Notification, title: (t('Copying {0} as {1}...', tableName, (message as any).data?.format === 'tsv' ? 'TSV' : 'CSV')), cancellable: false },
              async () => {
                const data = (message as any).data || {};
                const format: 'csv' | 'tsv' = data.format === 'tsv' ? 'tsv' : 'csv';
                const sortStates: { column: number; direction: 'asc' | 'desc' }[] = data.sortStates || [];
                const whereFilter: string | undefined = data.whereFilter;
                const columnFilters = data.columnFilters as SqlColumnFilter[] | undefined;
                const includeHeader = data.includeHeader !== false;
                const separator = format === 'tsv' ? '\t' : ',';
                const escapeCell = format === 'tsv' ? tsvEscape : csvEscape;
                const escapedTable = schemaName
                  ? `${driver.escapeIdentifier(schemaName)}.${driver.escapeIdentifier(tableName)}`
                  : driver.escapeIdentifier(tableName);

                let sql = `SELECT * FROM ${escapedTable}`;
                const columnFilterClauses = buildColumnFilterSql(driver, result.columns.map(c => c.name), columnFilters);
                sql = appendWhereClauses(sql, whereFilter, columnFilterClauses);
                if (sortStates.length > 0) {
                  const orderParts = sortStates.map(s => {
                    const colName = result.columns[s.column]?.name;
                    if (!colName) return null;
                    return `${driver.escapeIdentifier(colName)} ${s.direction === 'desc' ? 'DESC' : 'ASC'}`;
                  }).filter(Boolean).join(', ');
                  if (orderParts) sql += ` ORDER BY ${orderParts}`;
                }

                const copyResult = serializeQueryResult(await driver.query(sql));
                const header = result.columns.map(c => escapeCell(c.name)).join(separator);
                const body = copyResult.rows.map(row => row.map(escapeCell).join(separator)).join('\n');
                await vscode.env.clipboard.writeText(includeHeader ? `${header}\n${body}` : body);
                send({
                  type: 'copyResult',
                  success: true,
                  message: `Copied ${copyResult.rows.length.toLocaleString()} row${copyResult.rows.length === 1 ? '' : 's'} as ${format.toUpperCase()}`,
                } as any);
              }
            );
          } catch (err) {
            send({
              type: 'copyResult',
              success: false,
              message: `Copy failed: ${err instanceof Error ? err.message : String(err)}`,
            } as any);
          }
        }
      }

      // Export the current query result set (all rows already fetched by the
      // webview) to a file chosen by the user.
      if ((message as any).type === 'exportQueryResults') {
        await handleExportQueryResultsMessage(message, send);
      }

      if ((message as any).type === 'openNewTab') {
        vscode.commands.executeCommand('sqlens.newQuery', { connectionId: connId, database });
      }

      if (message.type === 'saveChanges' && connId && tableName) {
        const driver = connectionManager.getDriver(connId);
        if (!driver) { vscode.window.showErrorMessage(t('Not connected')); return; }

        try {
          const changedRows = message.data.rows as any[];
          const columns = result.columns.map(c => c.name);
          const pkCols = result.columns.filter(c => c.isPrimaryKey).map(c => c.name);

          // Document/columnar drivers implement editing themselves (SQL cannot
          // express ES updates, Mongo $set or ClickHouse mutations).
          const rowEditor = driver as unknown as Partial<RowEditCapable>;
          if (typeof rowEditor.applyRowEdits === 'function') {
            const applied = await rowEditor.applyRowEdits(tableName, changedRows, columns, pkCols, schemaName);
            if (applied === 0) { return; }
            vscode.window.showInformationMessage(t('{0} changes saved.', applied));

            const pageSizeDoc = vscode.workspace.getConfiguration('sqlens').get<number>('defaultRowsPerPage', 1000);
            const refreshSqlDoc = typeof rowEditor.pageQuery === 'function'
              ? rowEditor.pageQuery(tableName, pageSizeDoc + 1, schemaName)
              : null;
            if (refreshSqlDoc) {
              const refreshResultDoc = serializeQueryResult(await driver.query(refreshSqlDoc));
              const hasMoreDoc = refreshResultDoc.rows.length > pageSizeDoc;
              send({
                type: 'queryResult',
                data: {
                  ...refreshResultDoc,
                  columns: result.columns,
                  rows: hasMoreDoc ? refreshResultDoc.rows.slice(0, pageSizeDoc) : refreshResultDoc.rows,
                },
                tableName,
                schemaName,
                pageSize: pageSizeDoc,
                hasMore: hasMoreDoc,
                querySql: refreshSqlDoc,
              } as any);
            }
            return;
          }

          const escapedTable = schemaName
            ? `${driver.escapeIdentifier(schemaName)}.${driver.escapeIdentifier(tableName)}`
            : driver.escapeIdentifier(tableName);

          const statements: string[] = [];
          for (const row of changedRows) {
            if (row.status === 'modified') {
              const sets = (row.changedCols as number[]).map(ci =>
                `${driver.escapeIdentifier(columns[ci])} = ${driver.escapeValue(row.data[ci])}`
              ).join(', ');
              const where = (pkCols.length > 0 ? pkCols : columns).map(col => {
                const ci = columns.indexOf(col);
                const val = row.original[ci];
                return val === null ? `${driver.escapeIdentifier(col)} IS NULL` : `${driver.escapeIdentifier(col)} = ${driver.escapeValue(val)}`;
              }).join(' AND ');
              statements.push(`UPDATE ${escapedTable} SET ${sets} WHERE ${where}`);
            } else if (row.status === 'added') {
              const nonNull = columns.map((col, i) => ({ col, val: row.data[i] })).filter(x => x.val !== null);
              if (nonNull.length > 0) {
                const insertSql = `INSERT INTO ${escapedTable} (${nonNull.map(x => driver.escapeIdentifier(x.col)).join(', ')}) VALUES (${nonNull.map(x => driver.escapeValue(x.val)).join(', ')})`;
                // SQL Server needs IDENTITY_INSERT enabled to write an
                // identity column explicitly.
                const identityCols = result.columns.filter(c => c.isAutoIncrement).map(c => c.name);
                const writesIdentity = driver.driverType === 'mssql' && nonNull.some(x => identityCols.includes(x.col));
                if (writesIdentity) {
                  statements.push(`SET IDENTITY_INSERT ${escapedTable} ON`);
                  statements.push(insertSql);
                  statements.push(`SET IDENTITY_INSERT ${escapedTable} OFF`);
                } else {
                  statements.push(insertSql);
                }
              }
            } else if (row.status === 'deleted') {
              const where = (pkCols.length > 0 ? pkCols : columns).map(col => {
                const ci = columns.indexOf(col);
                const val = row.original[ci];
                return val === null ? `${driver.escapeIdentifier(col)} IS NULL` : `${driver.escapeIdentifier(col)} = ${driver.escapeValue(val)}`;
              }).join(' AND ');
              statements.push(`DELETE FROM ${escapedTable} WHERE ${where}`);
            }
          }

          if (statements.length === 0) { return; }

          // Execute all statements
          for (const stmt of statements) { await driver.query(stmt); }
          vscode.window.showInformationMessage(t('{0} changes saved.', statements.length));

          // Refresh the grid
          const pageSize = vscode.workspace.getConfiguration('sqlens').get<number>('defaultRowsPerPage', 1000);
          const refreshSql = `SELECT * FROM ${escapedTable} ${driver.paginationSQL(pageSize + 1, 0)}`;
          const refreshResult = serializeQueryResult(await driver.query(refreshSql));
          const hasMore = refreshResult.rows.length > pageSize;
          const rows = hasMore ? refreshResult.rows.slice(0, pageSize) : refreshResult.rows;
          send({
            type: 'queryResult',
            data: { ...refreshResult, columns: result.columns, rows },
            tableName,
            schemaName,
            pageSize,
            hasMore,
            querySql: refreshSql,
          } as any);
        } catch (err) {
          vscode.window.showErrorMessage(t('Save failed: {0}', err instanceof Error ? err.message : err));
        }
      }

      if (message.type === 'previewSQL') {
        await handlePreviewSQLMessage(message, connId, tableName, schemaName, result.columns, id => connectionManager.getDriver(id), send, options?.querySql);
      }

      if (message.type === 'openQuickView') {
        openQuickViewPanel(message.data.columns, message.data.rowData);
      }
    };

    if (inPanel) {
      // Host the grid as a tab inside the Sqlens panel view. Only the open
      // message activates the tab; later responses must not steal focus.
      panelTabHandlers.set(instanceId, handleMessage);
      if (connectionId) { panelTabConnections.set(instanceId, connectionId); }
      const openMessage = options?.activate ? { ...messagePayload, activate: true } : messagePayload;
      void vscode.commands.executeCommand('sqlens.queryResultsView.focus').then(() => {
        send(openMessage);
      });
      return;
    }

    const panelExists = webviewManager.hasPanel(panelId);
    webviewManager.showPanel(panelId, options?.pinned ? title : `Preview: ${title}`, 'dataGrid', handleMessage, vscode.ViewColumn.Active);
    if (panelExists) {
      webviewManager.postMessage(panelId, messagePayload);
    }
  }

  function openQuickViewPanel(columns: any[], rowData: any[]) {
    const title = 'Row Quick View';

    const sendData = () => {
      if (!panelTabHandlers.has(QUICK_VIEW_TAB_ID)) { return; }
      queryResultsViewProvider.postMessage({
        type: 'quickViewData',
        instanceId: QUICK_VIEW_TAB_ID,
        tabKind: 'quickView',
        tabTitle: title,
        data: { columns, rowData },
      } as any);
    };

    openPanelTab({
      instanceId: QUICK_VIEW_TAB_ID,
      kind: 'quickView',
      title,
      connectionId: connectionManager.activeConnectionId,
      remount: true,
      handler: (message: WebviewMessage) => {
        if (message.type === 'ready') {
          sendData();
        }
      },
    });
  }

  function getCurrentStatement(editor: vscode.TextEditor): string {
    const doc = editor.document;
    const cursorLine = editor.selection.active.line;
    let startLine = cursorLine;
    let endLine = cursorLine;

    while (startLine > 0) {
      const line = doc.lineAt(startLine - 1).text.trim();
      if (line === '' || line.endsWith(';')) { break; }
      startLine--;
    }
    while (endLine < doc.lineCount - 1) {
      const line = doc.lineAt(endLine).text.trim();
      if (line.endsWith(';')) { break; }
      endLine++;
    }

    const range = new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length);
    let text = doc.getText(range).trim();
    if (text.endsWith(';')) { text = text.slice(0, -1).trim(); }
    return text;
  }

  async function getTableDDL(driver: any, table: string, schema?: string): Promise<string> {
    const escapedTable = schema
      ? `${driver.escapeIdentifier(schema)}.${driver.escapeIdentifier(table)}`
      : driver.escapeIdentifier(table);

    if (driver.driverType === 'mysql') {
      const result = await driver.query(`SHOW CREATE TABLE ${escapedTable}`);
      return result.rows[0]?.[1] as string || '';
    }
    if (driver.driverType === 'postgresql') {
      const columns = await driver.getColumns(table, schema);
      return generateCreateTableDDL(table, columns, driver, schema);
    }
    if (driver.driverType === 'sqlite') {
      const result = await driver.query(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name=${driver.escapeValue(table)}`
      );
      return result.rows[0]?.[0] as string || '';
    }
    return '';
  }

  function generateCreateTableDDL(table: string, columns: any[], driver: any, schema?: string): string {
    const lines = columns.map((col: any) => {
      let line = `  ${driver.escapeIdentifier(col.name)} ${col.type}`;
      if (!col.nullable) { line += ' NOT NULL'; }
      if (col.defaultValue !== null && col.defaultValue !== undefined) { line += ` DEFAULT ${col.defaultValue}`; }
      return line;
    });
    const pkCols = columns.filter((c: any) => c.isPrimaryKey).map((c: any) => driver.escapeIdentifier(c.name));
    if (pkCols.length > 0) { lines.push(`  PRIMARY KEY (${pkCols.join(', ')})`); }
    const escapedTable = schema
      ? `${driver.escapeIdentifier(schema)}.${driver.escapeIdentifier(table)}`
      : driver.escapeIdentifier(table);
    return `CREATE TABLE ${escapedTable} (\n${lines.join(',\n')}\n)`;
  }

  // Register SQLite custom editor provider
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'sqlens.sqliteViewer',
      new SqliteCustomEditorProvider(openSQLiteFile)
    )
  );

  // Trigger .env auto-import on startup
  scanWorkspaceForDatabaseConfigs();

  // Watch for workspace folder changes to re-trigger scan
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      scanWorkspaceForDatabaseConfigs();
    })
  );
}

// ── SQLite Custom Editor Provider ──

class SqliteCustomEditorProvider implements vscode.CustomEditorProvider {
  constructor(private openSQLiteFn: (uri: vscode.Uri) => Promise<void>) {}

  readonly onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<vscode.CustomDocument>>().event;

  async saveCustomDocument(document: vscode.CustomDocument, cancellation: vscode.CancellationToken): Promise<void> {}
  async saveCustomDocumentAs(document: vscode.CustomDocument, destination: vscode.Uri, cancellation: vscode.CancellationToken): Promise<void> {}
  async revertCustomDocument(document: vscode.CustomDocument, cancellation: vscode.CancellationToken): Promise<void> {}
  async backupCustomDocument(document: vscode.CustomDocument, context: vscode.CustomDocumentBackupContext, cancellation: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
    return {
      id: '',
      delete: () => {}
    };
  }

  async openCustomDocument(
    uri: vscode.Uri,
    openContext: vscode.CustomDocumentOpenContext,
    token: vscode.CancellationToken
  ): Promise<vscode.CustomDocument> {
    return {
      uri,
      dispose: () => {}
    };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
    token: vscode.CancellationToken
  ): Promise<void> {
    webviewPanel.webview.options = { enableScripts: false };
    webviewPanel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 20px; }
    .box { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 14px; max-width: 520px; }
    h2 { font-size: 14px; margin: 0 0 8px; }
    p { color: var(--vscode-descriptionForeground); margin: 0; font-size: 12px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="box">
    <h2>Opening SQLite database in Sqlens...</h2>
    <p>This tab closes automatically once the database is ready.</p>
  </div>
</body>
</html>`;

    await this.openSQLiteFn(document.uri);
    // The database is now available in Sqlens, so this placeholder tab is no
    // longer useful. Close it so opening a .db file leaves no stray editor tab.
    webviewPanel.dispose();
  }
}

// ── SSH Config Parser ──

export interface SSHConfigHost {
  host: string;
  hostName?: string;
  user?: string;
  port?: number;
  identityFile?: string;
}

export function parseSSHConfig(customPath?: string): SSHConfigHost[] {
  const sshConfigPath = customPath || path.join(os.homedir(), '.ssh', 'config');
  if (!fs.existsSync(sshConfigPath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(sshConfigPath, 'utf8');
    const lines = content.split(/\r?\n/);
    const hosts: SSHConfigHost[] = [];
    let currentHost: SSHConfigHost | null = null;

    for (let line of lines) {
      line = line.trim();
      if (!line || line.startsWith('#')) {
        continue;
      }

      const match = line.match(/^(\S+)\s+(.+)$/);
      if (!match) {
        continue;
      }

      const key = match[1].toLowerCase();
      const value = match[2].trim().replace(/^"(.*)"$/, '$1');

      if (key === 'host') {
        if (value === '*') {
          continue;
        }
        const aliases = value.split(/\s+/);
        for (const alias of aliases) {
          currentHost = { host: alias };
          hosts.push(currentHost);
        }
      } else if (currentHost) {
        if (key === 'hostname') {
          currentHost.hostName = value;
        } else if (key === 'user') {
          currentHost.user = value;
        } else if (key === 'port') {
          currentHost.port = parseInt(value, 10);
        } else if (key === 'identityfile') {
          let keyPath = value;
          if (keyPath.startsWith('~/')) {
            keyPath = path.join(os.homedir(), keyPath.slice(2));
          }
          currentHost.identityFile = keyPath;
        }
      }
    }
    return hosts;
  } catch (err) {
    Logger.getInstance().logError('Failed to parse SSH config file', err);
    return [];
  }
}

// ── SQLite Opener Function ──

async function openSQLiteFile(uri: vscode.Uri) {
  const filePath = uri.fsPath;
  const fileName = path.basename(filePath);

  try {
    const savedConnections = await connectionManager.getSavedConnections();
    let conn = savedConnections.find(
      c => c.type === 'sqlite' && (c.filepath === filePath || c.database === filePath)
    );

    let id: string;
    if (conn) {
      id = conn.id;
    } else {
      const newConfig: ConnectionConfig = {
        id: uuidv4(),
        name: `${fileName} (SQLite)`,
        type: DatabaseType.SQLite,
        host: '',
        port: 0,
        username: '',
        password: '',
        database: filePath,
        filepath: filePath,
        ssl: { mode: SSLMode.Disabled },
        ssh: { enabled: false, host: '', port: 22, username: '', authMethod: 'password' },
        options: {},
        group: 'SQLite Files',
        tags: ['sqlite', 'local'],
        color: '',
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      id = await connectionManager.saveConnection(newConfig);
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: (t('Opening SQLite database {0}...', fileName)), cancellable: false },
      () => connectionManager.connect(id)
    );

    vscode.window.showInformationMessage(t('Connected to SQLite database: {0}', fileName));
    connectionTreeProvider.refresh();
    schemaTreeProvider.clearCache();
    schemaTreeProvider.refresh();
    schemaProvider.refresh();
  } catch (err) {
    vscode.window.showErrorMessage(t('Failed to open SQLite database: {0}', err instanceof Error ? err.message : err));
  }
}

// ── Workspace .env Scanner & DB Importer ──

export function parseDatabaseUrl(urlStr: string, env: Record<string, string>): Partial<ConnectionConfig> | null {
  urlStr = urlStr.replace(/\${([^}]+)}/g, (_, name) => env[name] || '');

  try {
    if (urlStr.startsWith('sqlite:') || urlStr.startsWith('file:')) {
      const filePath = urlStr.replace(/^(sqlite|file):(?:\/\/)?/, '');
      return {
        type: 'sqlite',
        database: filePath,
        filepath: filePath,
      } as any;
    }

    const parsed = new URL(urlStr);
    let type: string | null = null;
    let defaultPort = 0;

    const protocol = parsed.protocol.replace(':', '');
    if (protocol.startsWith('mysql')) {
      type = 'mysql';
      defaultPort = 3306;
    } else if (protocol.startsWith('postgres') || protocol === 'pgsql') {
      type = 'postgresql';
      defaultPort = 5432;
    } else if (protocol === 'sqlite' || protocol === 'sqlite3') {
      type = 'sqlite';
    }

    if (!type) {
      return null;
    }

    if (type === 'sqlite') {
      const filePath = parsed.pathname || parsed.hostname;
      return {
        type: 'sqlite',
        database: filePath,
        filepath: filePath,
      } as any;
    }

    const host = parsed.hostname;
    const port = parsed.port ? parseInt(parsed.port, 10) : defaultPort;
    const username = decodeURIComponent(parsed.username || '');
    const password = decodeURIComponent(parsed.password || '');
    const database = decodeURIComponent(parsed.pathname.replace(/^\//, '') || '');

    return {
      type,
      host,
      port,
      username,
      password,
      database,
    } as any;
  } catch (err) {
    return null;
  }
}

export async function detectDatabaseConfigsInFile(filePath: string, workspaceName: string): Promise<Partial<ConnectionConfig>[]> {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    const env: Record<string, string> = {};

    for (let line of lines) {
      line = line.trim();
      if (!line || line.startsWith('#')) {
        continue;
      }
      const parts = line.split('=');
      if (parts.length >= 2) {
        const key = parts[0].trim();
        let val = parts.slice(1).join('=').trim();
        val = val.replace(/^["'](.*)["']$/, '$1');
        env[key] = val;
      }
    }

    const configs: Partial<ConnectionConfig>[] = [];

    // 1. Check for DATABASE_URL or similar URL variables
    const urlVars = ['DATABASE_URL', 'DB_URL', 'SPRING_DATASOURCE_URL', 'JAWSDB_URL', 'CLEARDB_DATABASE_URL', 'DATABASE_PRIVATE_URL'];
    for (const key of Object.keys(env)) {
      if (urlVars.includes(key) || key.endsWith('_DATABASE_URL') || key.endsWith('_DB_URL')) {
        let urlStr = env[key];
        if (urlStr.startsWith('jdbc:')) {
          urlStr = urlStr.substring(5);
        }
        const parsed = parseDatabaseUrl(urlStr, env);
        if (parsed) {
          if (parsed.type === DatabaseType.SQLite) {
            const sqlitePath = parsed.filepath || parsed.database;
            if (sqlitePath && !path.isAbsolute(sqlitePath)) {
              const resolved = path.resolve(path.dirname(filePath), sqlitePath);
              parsed.database = resolved;
              parsed.filepath = resolved;
            }
          }
          if (!parsed.username && (env.DB_USERNAME || env.DB_USER || env.SPRING_DATASOURCE_USERNAME)) {
            parsed.username = env.DB_USERNAME || env.DB_USER || env.SPRING_DATASOURCE_USERNAME;
          }
          if (!parsed.password && (env.DB_PASSWORD || env.DB_PASS || env.SPRING_DATASOURCE_PASSWORD)) {
            parsed.password = env.DB_PASSWORD || env.DB_PASS || env.SPRING_DATASOURCE_PASSWORD;
          }
          configs.push(parsed);
        }
      }
    }

    // 2. Check for Laravel style DB_* variables
    if (env.DB_CONNECTION || env.DB_HOST || env.DB_DATABASE) {
      let type = env.DB_CONNECTION || 'mysql';
      if (type === 'pgsql') { type = 'postgresql'; }

      if (['mysql', 'mariadb', 'postgresql', 'sqlite'].includes(type)) {
        if (type === 'sqlite') {
          let fp = env.DB_DATABASE || env.DB_FILEPATH || 'database.sqlite';
          if (!path.isAbsolute(fp)) {
            fp = path.resolve(path.dirname(filePath), fp);
          }
          configs.push({
            type: DatabaseType.SQLite,
            database: fp,
            filepath: fp,
          });
        } else {
          configs.push({
            type: type as DatabaseType,
            host: env.DB_HOST || '127.0.0.1',
            port: parseInt(env.DB_PORT || '', 10) || (type === 'postgresql' ? 5432 : 3306),
            username: env.DB_USERNAME || env.DB_USER || 'root',
            password: env.DB_PASSWORD || env.DB_PASS || '',
            database: env.DB_DATABASE || env.DB_NAME || '',
          });
        }
      }
    }

    // 3. Check for Django database variables if present
    if (env.DB_ENGINE || env.DB_NAME) {
      let engine = env.DB_ENGINE || '';
      let type: string | null = null;
      if (engine.includes('mysql')) { type = 'mysql'; }
      else if (engine.includes('postgresql') || engine.includes('postgis')) { type = 'postgresql'; }
      else if (engine.includes('sqlite')) { type = 'sqlite'; }

      if (type) {
        if (type === 'sqlite') {
          let fp = env.DB_NAME || 'db.sqlite3';
          if (!path.isAbsolute(fp)) {
            fp = path.resolve(path.dirname(filePath), fp);
          }
          configs.push({
            type: DatabaseType.SQLite,
            database: fp,
            filepath: fp,
          });
        } else {
          configs.push({
            type: type as DatabaseType,
            host: env.DB_HOST || 'localhost',
            port: parseInt(env.DB_PORT || '', 10) || (type === 'postgresql' ? 5432 : 3306),
            username: env.DB_USER || 'root',
            password: env.DB_PASSWORD || '',
            database: env.DB_NAME || '',
          });
        }
      }
    }

    // Deduplicate configs found within this file
    const uniqueConfigs: Partial<ConnectionConfig>[] = [];
    for (const c of configs) {
      const exists = uniqueConfigs.some(
        uc => uc.type === c.type &&
              (uc.type === 'sqlite'
                ? uc.filepath === c.filepath
                : uc.host === c.host && uc.port === c.port && uc.database === c.database && uc.username === c.username)
      );
      if (!exists) {
        uniqueConfigs.push(c);
      }
    }

    return uniqueConfigs;
  } catch (err) {
    Logger.getInstance().logError(`Failed to detect configs in ${filePath}`, err);
    return [];
  }
}

async function scanWorkspaceForDatabaseConfigs() {
  if (!vscode.workspace.workspaceFolders) {
    return;
  }

  const savedConnections = await connectionManager.getSavedConnections();
  let importedCount = 0;
  const knownSqlitePaths = new Set(
    savedConnections
      .filter(c => c.type === DatabaseType.SQLite)
      .map(c => c.filepath || c.database || '')
      .filter(Boolean)
      .map(p => path.resolve(p))
  );
  /**
   * Names of existing (and already imported) connections, used to keep
   * auto-imported names short without colliding: the short name is used
   * unless it is taken, in which case the containing directory is appended.
   */
  const usedNames = new Set(savedConnections.map(c => c.name).filter(Boolean) as string[]);

  const uniqueName = (base: string, dirName?: string): string => {
    if (!usedNames.has(base)) {
      usedNames.add(base);
      return base;
    }
    const withDir = dirName ? `${base} (${dirName})` : base;
    if (!usedNames.has(withDir)) {
      usedNames.add(withDir);
      return withDir;
    }
    let n = 2;
    while (usedNames.has(`${withDir} ${n}`)) { n++; }
    const finalName = `${withDir} ${n}`;
    usedNames.add(finalName);
    return finalName;
  };

  for (const folder of vscode.workspace.workspaceFolders) {
    const rootPath = folder.uri.fsPath;
    const workspaceName = folder.name;

    try {
      const files = await glob('**/.env{,.local,.development,.production,.test}', {
        cwd: rootPath,
        absolute: true,
        ignore: ['**/node_modules/**', '**/vendor/**', '**/.git/**', '**/dist/**', '**/build/**'],
      });

      for (const filePath of files) {
        const detected = await detectDatabaseConfigsInFile(filePath, workspaceName);
        for (const config of detected) {
          // Check if this config already exists
          const exists = savedConnections.some(
            sc => sc.type === config.type &&
                  (config.type === 'sqlite'
                    ? sc.filepath === config.filepath
                    : sc.host === config.host && sc.port === config.port && sc.database === config.database && sc.username === config.username)
          );

          if (!exists) {
            const fileName = path.basename(filePath);
            const dirName = path.basename(path.dirname(filePath));
            const locationLabel = dirName === workspaceName ? fileName : `${dirName}/${fileName}`;

            const newConfig: ConnectionConfig = {
              id: uuidv4(),
              // Short name: the workspace is already shown by the
              // "Imported (<workspace>)" group, and the type by the icon.
              name: uniqueName(config.database ? path.basename(config.database) : 'db', dirName),
              type: config.type as DatabaseType,
              host: config.host || '',
              port: config.port || 0,
              username: config.username || '',
              password: config.password || '',
              database: config.database || '',
              filepath: config.filepath || '',
              ssl: { mode: SSLMode.Disabled },
              ssh: { enabled: false, host: '', port: 22, username: '', authMethod: 'password' },
              options: {
                ...(config.options || {}),
                sqlensAutoImported: true,
                sqlensWorkspaceRoot: rootPath,
                sqlensSourceFile: filePath,
              },
              group: `Imported (${workspaceName})`,
              tags: ['auto-imported', workspaceName],
              color: '',
              createdAt: Date.now(),
              updatedAt: Date.now()
            };

            await connectionManager.saveConnection(newConfig);
            const sqliteConfigPath = newConfig.filepath || newConfig.database;
            if (newConfig.type === DatabaseType.SQLite && sqliteConfigPath) {
              knownSqlitePaths.add(path.resolve(sqliteConfigPath));
            }
            importedCount++;
            Logger.getInstance().logInfo(`Auto-imported connection '${newConfig.name}' from ${locationLabel}`);
          }
        }
      }

      const sqliteFiles = await glob('**/*.{sqlite,sqlite3,db}', {
        cwd: rootPath,
        absolute: true,
        ignore: ['**/node_modules/**', '**/vendor/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.vscode-test/**'],
      });

      for (const sqlitePath of sqliteFiles) {
        const resolvedPath = path.resolve(sqlitePath);
        if (knownSqlitePaths.has(resolvedPath)) {
          continue;
        }

        const fileName = path.basename(sqlitePath);
        const fileDirName = path.basename(path.dirname(sqlitePath));
        const newConfig: ConnectionConfig = {
          id: uuidv4(),
          // Short name: group shows the workspace, icon shows the type.
          name: uniqueName(fileName, fileDirName),
          type: DatabaseType.SQLite,
          host: '',
          port: 0,
          username: '',
          password: '',
          database: resolvedPath,
          filepath: resolvedPath,
          ssl: { mode: SSLMode.Disabled },
          ssh: { enabled: false, host: '', port: 22, username: '', authMethod: 'password' },
          options: {
            sqlensAutoImported: true,
            sqlensWorkspaceRoot: rootPath,
            sqlensSourceFile: resolvedPath,
          },
          group: `Imported (${workspaceName})`,
          tags: ['auto-imported', workspaceName, 'sqlite-file'],
          color: '',
          createdAt: Date.now(),
          updatedAt: Date.now()
        };

        await connectionManager.saveConnection(newConfig);
        knownSqlitePaths.add(resolvedPath);
        importedCount++;
        Logger.getInstance().logInfo(`Auto-imported SQLite file '${newConfig.name}' from workspace scan`);
      }
    } catch (err) {
      Logger.getInstance().logError(`Failed to scan workspace folder ${rootPath} for DB configs`, err);
    }
  }

  if (importedCount > 0) {
    vscode.window.showInformationMessage(t('Sqlens: Auto-imported {0} database connection(s) for this workspace.', importedCount));
  }

  connectionTreeProvider.refresh();
}

  function getQueryContextTitle(document: vscode.TextDocument): string | undefined {
    if (document.languageId !== 'sql') return undefined;
    const mapped = queryDocContexts[document.uri.toString()];
    if (mapped) {
      return `$(database) ${mapped.connectionName} [${mapped.database || 'main'}]`;
    }
    const activeConnId = connectionManager.activeConnectionId;
    if (activeConnId) {
      const conn = connectionManager.activeConnection;
      return `$(database) ${conn?.config.name || 'Connected'} [${conn?.config.database || 'main'}]`;
    }
    return 'Select a connection';
  }

  async function updateStatusBar() {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === 'sql') {
      const uri = editor.document.uri.toString();
      const mapped = queryDocContexts[uri];

      let text = 'Sqlens: Select DB';
      if (mapped) {
        text = `Sqlens: ${mapped.connectionName} [${mapped.database || 'main'}]`;
      } else {
        const activeConnId = connectionManager.activeConnectionId;
        if (activeConnId) {
          const conn = connectionManager.activeConnection;
          const connName = conn?.config.name || 'Connected';
          const db = await getCurrentDatabaseName(activeConnId);
          text = `Sqlens: ${connName} [${db || 'main'}]`;

          queryDocContexts[uri] = {
            connectionId: activeConnId,
            connectionName: connName,
            database: db
          };
          await extensionContext.workspaceState.update('queryDocContexts', queryDocContexts);
        }
      }
      queryContextStatusBarItem.text = text;
      queryContextStatusBarItem.command = 'sqlens.changeQueryContext';
      queryContextStatusBarItem.show();
      sqlCodeLensProvider?.refresh();
    } else {
      queryContextStatusBarItem.hide();
    }
  }

  async function applyQueryContext(doc: vscode.TextDocument): Promise<void> {
    const uri = doc.uri.toString();
    const mapped = queryDocContexts[uri];
    if (mapped) {
      if (!connectionManager.isConnected(mapped.connectionId)) {
        try {
          await connectionManager.connect(mapped.connectionId);
        } catch (err) {
          throw new Error(`Sqlens: Connection "${mapped.connectionName}" is not active. Please connect first.`);
        }
      }
      if (connectionManager.activeConnectionId !== mapped.connectionId) {
        connectionManager.setActiveConnection(mapped.connectionId);
      }
      const driver = connectionManager.getDriver(mapped.connectionId);
      const currentDb = driver ? await getCurrentDatabaseName(mapped.connectionId) : '';
      if (driver && mapped.database && currentDb !== mapped.database) {
        try {
          await driver.switchDatabase(mapped.database);
        } catch (err) {
          // ignore SQLite unsupported errors
        }
      }
      updateStatusBar();
    } else {
      const activeConnId = connectionManager.activeConnectionId;
      if (activeConnId) {
        const conn = connectionManager.activeConnection;
        const connName = conn?.config.name || 'Connected';
        const db = await getCurrentDatabaseName(activeConnId);
        queryDocContexts[uri] = {
          connectionId: activeConnId,
          connectionName: connName,
          database: db
        };
        await extensionContext.workspaceState.update('queryDocContexts', queryDocContexts);
        updateStatusBar();
      }
    }
  }

export function deactivate() {
  void mcpService?.dispose();
  mcpActivity?.dispose();
  connectionManager?.dispose();
  webviewManager?.disposeAll();
  queryHistory?.dispose();
}

/**
 * Pretty-print driver text that is not SQL: an Elasticsearch request
 * (`METHOD /path` + JSON body) or a mongosh call (`db.coll.method({...})`).
 * Anything unparsable is returned unchanged.
 */
function formatJsonish(text: string): string {
  const lines = text.split('\n');
  const first = (lines[0] ?? '').trim();

  if (/^(GET|POST|PUT|DELETE|HEAD)\s+\/\S*/i.test(first)) {
    const body = lines.slice(1).join('\n').trim();
    if (!body) { return first; }
    try {
      return `${first}\n${JSON.stringify(JSON.parse(body), null, 2)}`;
    } catch {
      return text;
    }
  }

  const mongosh = text.trim().match(/^(db\.[\w$.-]+\.\w+)\(([\s\S]*)\)([\s\S]*)$/);
  if (mongosh) {
    const [, prefix, rawArgs, chain] = mongosh;
    try {
      // Keep the mongosh literals readable while pretty-printing the JSON.
      const normalized = rawArgs
        .replace(/ObjectId\(\s*'([^']*)'\s*\)/g, '"$1"')
        .replace(/ISODate\(\s*'([^']*)'\s*\)/g, '"$1"');
      return `${prefix}(${JSON.stringify(JSON.parse(normalized), null, 2)})${chain}`;
    } catch {
      return text;
    }
  }

  return text;
}
