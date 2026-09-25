import * as vscode from 'vscode';
import { ExtensionMessage, WebviewMessage } from '../../core/types';

export class QueryResultsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'sqlens.queryResultsView';
  private _view?: vscode.WebviewView;
  /**
   * Last full result message per grid tab. Replayed on "ready" so the open
   * tabs survive a webview (re)creation.
   */
  private _tabMessages = new Map<string, ExtensionMessage>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onMessageCallback: (message: WebviewMessage) => void
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview'),
        vscode.Uri.joinPath(this.context.extensionUri, 'resources/icons')
      ]
    };

    webviewView.webview.html = this.getWebviewHTML(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (message: WebviewMessage) => {
        if (message.type === 'ready') {
          for (const lastMessage of this._tabMessages.values()) {
            webviewView.webview.postMessage(lastMessage);
          }
        }
        this.onMessageCallback(message);
      },
      undefined,
      this.context.subscriptions
    );

    // Send initial theme
    this.sendThemeInfo();
  }

  public postMessage(message: ExtensionMessage) {
    const instanceId = (message as any).instanceId as string | undefined;
    const tabTitle = (message as any).tabTitle as string | undefined;
    // Tab payloads are cached so open tabs survive a webview recreation.
    //
    // `openPanel` is deliberately excluded: it is a control message, and it asks
    // the host to remount the tab (`remount: true`). Replaying it on "ready"
    // would remount the panel, whose fresh mount posts "ready" again, which
    // replays it once more — an endless remount loop where the tab strip
    // flickers and the panel never leaves its loading state.
    // (`openPanel` is posted by openPanelTab as a control payload, so it is not
    // part of the ExtensionMessage union.)
    const messageType = (message as any).type as string | undefined;
    if (instanceId && tabTitle && messageType !== 'openPanel') {
      this._tabMessages.set(instanceId, message);
    }
    if (this._view) {
      this._view.show(true); // reveal/focus the panel view
      this._view.webview.postMessage(message);
    }
  }

  /** Post without revealing the panel, for housekeeping messages. */
  public postSilently(message: ExtensionMessage) {
    if (this._view) {
      this._view.webview.postMessage(message);
    }
  }

  /** Drop the stored result of a tab that has been closed. */
  public removeTab(instanceId: string) {
    this._tabMessages.delete(instanceId);
  }

  /** Last payload posted for a tab (used to serve replayed tabs). */
  public getTabMessage(instanceId: string): ExtensionMessage | undefined {
    return this._tabMessages.get(instanceId);
  }

  private sendThemeInfo(): void {
    if (!this._view) return;
    const kind = vscode.window.activeColorTheme.kind;
    let themeKind: 'light' | 'dark' | 'highContrast' = 'dark';
    if (kind === vscode.ColorThemeKind.Light) { themeKind = 'light'; }
    else if (kind === vscode.ColorThemeKind.HighContrast || kind === vscode.ColorThemeKind.HighContrastLight) {
      themeKind = 'highContrast';
    }

    this._view.webview.postMessage({
      type: 'theme',
      data: { kind: themeKind },
    } as ExtensionMessage);
  }

  private getWebviewHTML(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'index.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'index.css')
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
  <title>Sqlens</title>
</head>
<body data-panel-type="dataGrid">
  <div id="root"></div>
  <script nonce="${nonce}">
    window.__PANEL_TYPE__ = "dataGrid";
    window.__LOCALE__ = ${JSON.stringify(vscode.env.language || 'en')};
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
