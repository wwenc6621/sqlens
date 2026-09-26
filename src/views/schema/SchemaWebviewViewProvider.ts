import * as vscode from 'vscode';
import { ConnectionManager, RELATIONAL_DRIVERS } from '../../core/connection/ConnectionManager';
import { DatabaseType } from '../../core/types';
import { Logger } from '../../core/utils/Logger';
import { SchemaTreeProvider } from '../sidebar/SchemaTreeProvider';
import { SchemaCapabilities, SchemaInitPayload, SchemaNode } from './schemaNodes';

/**
 * Commands the Schema webview may run. The webview decides *which* item to show
 * in its context menu; this list is the host-side guard so a compromised or
 * buggy webview cannot invoke arbitrary commands.
 */
const ALLOWED_COMMANDS = new Set([
  'sqlens.openTable',
  'sqlens.openStructure',
  'sqlens.showDDL',
  'sqlens.copyCreateTable',
  'sqlens.generateTestData',
  'sqlens.renameTable',
  'sqlens.exportData',
  'sqlens.importData',
  'sqlens.truncateTable',
  'sqlens.dropTable',
  'sqlens.createTable',
]);

/**
 * Renders the Schema sidebar inside a webview.
 *
 * The native TreeView had no way to host an inline filter box or an in-place
 * rename, so the view was rewritten as a webview. The actual table/column
 * loading still lives in {@link SchemaTreeProvider}; this class only serializes
 * that data and wires up the messages.
 */
export class SchemaWebviewViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'sqlens.schema';

  private view?: vscode.WebviewView;
  /** True once the mounted webview has sent its first `ready`. */
  private ready = false;
  /** Table to highlight once the webview is ready to receive it. */
  private pendingReveal?: { name: string };
  private revealTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connectionManager: ConnectionManager,
    private readonly tree: SchemaTreeProvider,
  ) {
    // Any refresh performed elsewhere in the extension (drop / truncate /
    // rename / connection switch / query run) invalidates the tree data.
    // `SchemaTreeProvider` already listens to the connection manager, so this
    // single subscription covers every case; the webview keeps its expand state
    // and re-pulls only what it has open, resetting itself when the payload
    // reports a different connection.
    context.subscriptions.push(
      tree.onDidChangeTreeData(() => this.post({ type: 'schemaInvalidate' })),
    );
    Logger.getInstance().logInfo(`[schema] webview view provider constructed (${SchemaWebviewViewProvider.viewType})`);
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    Logger.getInstance().logInfo('[schema] resolveWebviewView() called by VS Code');
    this.view = webviewView;
    this.ready = false;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview'),
        vscode.Uri.joinPath(this.context.extensionUri, 'resources/icons'),
      ],
    };
    webviewView.webview.html = this.getWebviewHTML(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      message => void this.handleMessage(message),
      undefined,
      this.context.subscriptions,
    );
    webviewView.onDidDispose(() => {
      this.view = undefined;
      this.ready = false;
    });

    this.sendTheme();
  }

  /**
   * Briefly highlight a table in the tree (MCP action follow). Reveals the view
   * and lets the webview expand the path to the row.
   */
  async revealTable(tableName: string): Promise<void> {
    await vscode.commands.executeCommand('sqlens.schema.focus');
    this.pendingReveal = { name: tableName };
    this.flushReveal();
  }

  /** Ask the webview to focus its inline filter input. */
  focusFilter(): void {
    this.post({ type: 'schemaFocusFilter' });
  }

  /** Ask the webview to clear its filter. */
  clearFilter(): void {
    this.post({ type: 'schemaClearFilter' });
  }

  private flushReveal(): void {
    // A freshly revealed view has not mounted its listener yet; waiting for
    // `ready` avoids dropping the message.
    if (!this.pendingReveal || !this.view || !this.ready) { return; }
    const payload = this.pendingReveal;
    this.pendingReveal = undefined;
    // The webview mounts asynchronously after `focus`; a short delay keeps the
    // message from racing the first paint.
    if (this.revealTimer) { clearTimeout(this.revealTimer); }
    this.revealTimer = setTimeout(() => {
      this.revealTimer = undefined;
      this.post({ type: 'schemaReveal', data: payload });
    }, 60);
  }

  private async handleMessage(message: any): Promise<void> {
    switch (message?.type) {
      case 'ready':
        this.ready = true;
        Logger.getInstance().logInfo('[schema] webview mounted and sent "ready"');
        this.sendTheme();
        this.post({ type: 'schemaRoot', data: await this.buildInit() });
        this.flushReveal();
        return;

      // Sent by the webview after an invalidation: re-send the root (and the
      // capabilities, since the active connection may have changed).
      case 'schemaLoadRoot':
        this.post({ type: 'schemaRoot', data: await this.buildInit() });
        return;

      case 'schemaLoadChildren': {
        const requestId = message.data?.requestId;
        const node = message.data?.node as SchemaNode | undefined;
        if (!requestId || !node) { return; }
        let nodes: SchemaNode[] = [];
        try {
          nodes = await this.tree.getChildNodes(node);
        } catch {
          // A failing table must not blank the whole tree; the row simply stays
          // childless and can be retried.
          nodes = [];
        }
        this.post({ type: 'schemaChildren', data: { requestId, parentId: node.id, nodes } });
        return;
      }

      case 'schemaRefresh':
        this.tree.clearCache();
        this.tree.refresh();
        return;

      case 'schemaRunCommand': {
        const requestId = message.data?.requestId;
        const command = String(message.data?.command || '');
        if (!ALLOWED_COMMANDS.has(command)) { return; }
        let result: unknown = null;
        try {
          result = await vscode.commands.executeCommand(command, message.data?.item);
        } catch (err) {
          result = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        // Commands return `{ ok }` for the inline rename; everything else
        // reports through notifications, so `null` is a success here.
        this.post({ type: 'schemaCommandResult', data: { requestId, command, result } });
        return;
      }

      default:
        return;
    }
  }

  private async buildInit(): Promise<SchemaInitPayload> {
    const conn = this.connectionManager.activeConnection;
    const connectionId = this.connectionManager.activeConnectionId ?? '';

    let database = '';
    if (conn && connectionId) {
      const driver = this.connectionManager.getDriver(connectionId);
      if (driver) {
        database = await driver.getCurrentDatabase().catch(() => '');
      }
    }

    const driverType: string = conn?.config.type ?? '';
    const capabilities: SchemaCapabilities = {
      hasConnection: !!conn,
      connectionId,
      connectionName: conn?.config.name ?? '',
      database,
      driverType,
      relational: !!driverType && RELATIONAL_DRIVERS.includes(driverType as DatabaseType),
      redis: driverType === DatabaseType.Redis,
    };

    let nodes: SchemaNode[] = [];
    let error: string | undefined;
    if (capabilities.hasConnection) {
      try {
        nodes = await this.tree.getRootNodes();
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
    }

    return { capabilities, nodes, error };
  }

  private post(message: unknown): void {
    this.view?.webview.postMessage(message);
  }

  private sendTheme(): void {
    if (!this.view) { return; }
    const kind = vscode.window.activeColorTheme.kind;
    let themeKind: 'light' | 'dark' | 'highContrast' = 'dark';
    if (kind === vscode.ColorThemeKind.Light) { themeKind = 'light'; }
    else if (kind === vscode.ColorThemeKind.HighContrast || kind === vscode.ColorThemeKind.HighContrastLight) {
      themeKind = 'highContrast';
    }
    this.post({ type: 'theme', data: { kind: themeKind } });
  }

  private getWebviewHTML(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'index.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'index.css'),
    );
    const mediaBase = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'resources/icons'),
    );

    const nonce = this.getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    style-src ${webview.cspSource} 'unsafe-inline';
    script-src 'nonce-${nonce}';
    font-src ${webview.cspSource};
    img-src ${webview.cspSource} data: https:;
  ">
  <link rel="stylesheet" href="${styleUri}">
  <title>Schema</title>
</head>
<body data-panel-type="schema">
  <div id="root"></div>
  <script nonce="${nonce}">
    window.__PANEL_TYPE__ = "schema";
    window.__LOCALE__ = ${JSON.stringify(vscode.env.language || 'en')};
    window.__MEDIA_BASE__ = "${mediaBase.toString()}";
  </script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let nonce = '';
    for (let i = 0; i < 32; i++) {
      nonce += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return nonce;
  }
}
