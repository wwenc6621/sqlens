/**
 * Hook for communicating with the VSCode extension host.
 * Wraps the acquireVsCodeApi() for type-safe messaging.
 */

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | null = null;

function getApi(): VsCodeApi {
  if (!api) {
    api = acquireVsCodeApi();
  }
  return api;
}

export function postMessage(message: unknown): void {
  getApi().postMessage(message);
}

export function getState<T>(): T | undefined {
  return getApi().getState() as T | undefined;
}

export function setState<T>(state: T): void {
  getApi().setState(state);
}

/**
 * Subscribe to messages from the extension host.
 * Returns an unsubscribe function.
 */
export function onMessage(handler: (message: any) => void): () => void {
  const listener = (event: MessageEvent) => {
    handler(event.data);
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
