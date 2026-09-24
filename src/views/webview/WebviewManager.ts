import * as vscode from 'vscode';
import * as path from 'path';
import { ExtensionMessage, WebviewMessage } from '../../core/types';

/**
 * Manages webview panel creation and messaging for the extension.
 * Each panel type (ConnectionForm, DataGrid, etc.) is a separate webview instance.
 */
export class WebviewManager {
  private panels = new Map<string, vscode.WebviewPanel>();
  private messageHandlers = new Map<string, (message: WebviewMessage) => void>();

  constructor(private context: vscode.ExtensionContext) {}

  /**
   * Show or create a webview panel.
   * If a panel with the same id already exists, it will be revealed.
   */
  showPanel(
    id: string,
    title: string,
    panelType: string,
    onMessage: (message: WebviewMessage) => void,
    viewColumn: vscode.ViewColumn = vscode.ViewColumn.Active,
  ): vscode.WebviewPanel {
    this.messageHandlers.set(id, onMessage);

    // Reuse existing panel
    const existing = this.panels.get(id);
    if (existing) {
      existing.title = title;
      existing.reveal(viewColumn);
      this.sendThemeInfo(existing);
      return existing;
    }

    const panel = vscode.window.createWebviewPanel(
      `sqlens.${panelType}`,
      title,
      viewColumn,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview'),
          vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        ],
      },
    );

    panel.iconPath = {
      light: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'database.svg'),
      dark: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'database.svg'),
    };

    // Set HTML content
    panel.webview.html = this.getWebviewHTML(panel.webview, panelType);

    // Handle messages from webview
    panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => this.messageHandlers.get(id)?.(message),
      undefined,
      this.context.subscriptions,
    );

    // Send theme info when the panel becomes visible
    panel.onDidChangeViewState(() => {
      if (panel.visible) {
        this.sendThemeInfo(panel);
      }
    });

    // Cleanup on dispose
    panel.onDidDispose(() => {
      this.panels.delete(id);
      this.messageHandlers.delete(id);
    });

    this.panels.set(id, panel);

    // Send initial theme info
    this.sendThemeInfo(panel);

    return panel;
  }

  hasPanel(id: string): boolean {
    return this.panels.has(id);
  }

  /** Send a message to a webview panel */
  postMessage(id: string, message: ExtensionMessage): void {
    const panel = this.panels.get(id);
    if (panel) {
      panel.webview.postMessage(message);
    }
  }

  /** Close a webview panel */
  closePanel(id: string): void {
    const panel = this.panels.get(id);
    if (panel) {
      panel.dispose();
      this.panels.delete(id);
      this.messageHandlers.delete(id);
    }
  }

  /** Close all panels */
  disposeAll(): void {
    for (const panel of this.panels.values()) {
      panel.dispose();
    }
    this.panels.clear();
    this.messageHandlers.clear();
  }

  private sendThemeInfo(panel: vscode.WebviewPanel): void {
    const kind = vscode.window.activeColorTheme.kind;
    let themeKind: 'light' | 'dark' | 'highContrast' = 'dark';
    if (kind === vscode.ColorThemeKind.Light) { themeKind = 'light'; }
    else if (kind === vscode.ColorThemeKind.HighContrast || kind === vscode.ColorThemeKind.HighContrastLight) {
      themeKind = 'highContrast';
    }

    panel.webview.postMessage({
      type: 'theme',
      data: { kind: themeKind },
    } as ExtensionMessage);
  }

  private getWebviewHTML(webview: vscode.Webview, panelType: string): string {
    // Try to load the built webview assets
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
<body data-panel-type="${panelType}">
  <div id="root"></div>
  <script nonce="${nonce}">
    window.__PANEL_TYPE__ = "${panelType}";
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
