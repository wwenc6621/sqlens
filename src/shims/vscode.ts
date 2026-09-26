/**
 * Minimal `vscode` stub used when bundling modules for the offline unit tests
 * (`node --test`). Only the surface touched at import time is provided —
 * anything else throws so a test that accidentally reaches the real API fails
 * loudly instead of silently returning undefined.
 */
const notAvailable = (name: string) => () => {
  throw new Error(`vscode.${name} is not available in unit tests`);
};

export const window: Record<string, unknown> = {
  createOutputChannel: () => ({ appendLine() {}, append() {}, clear() {}, dispose() {} }),
  showInformationMessage: notAvailable('window.showInformationMessage'),
  showErrorMessage: notAvailable('window.showErrorMessage'),
  showWarningMessage: notAvailable('window.showWarningMessage'),
};

export const workspace: Record<string, unknown> = {
  getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
};

export const commands: Record<string, unknown> = {
  executeCommand: async () => undefined,
  registerCommand: () => ({ dispose() {} }),
};

export const Uri = {
  file: (fsPath: string) => ({ fsPath, path: fsPath, toString: () => fsPath }),
  joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
    fsPath: [base.fsPath, ...parts].join('/'),
    toString() { return this.fsPath; },
  }),
};

export class EventEmitter<T = unknown> {
  event = () => ({ dispose() {} });
  fire(_value?: T) { /* no-op */ }
  dispose() { /* no-op */ }
}

export const env: Record<string, unknown> = { language: 'en' };
