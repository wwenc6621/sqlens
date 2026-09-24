import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConnectionConfig } from '../types';

/**
 * Cross-IDE shared connection storage.
 *
 * Connections are persisted to a single JSON file that is independent of any
 * VS Code user-data directory, so all VS Code forks on the machine (VS Code,
 * Trae, ...) see the same connection list:
 * - macOS / Linux: ~/.config/sqlens/connections.json
 * - Windows:       %APPDATA%\sqlens\connections.json
 *
 * The file may contain connection passwords (opt-in, see the
 * `sqlens.sharedConnections.storePasswords` setting); the file is written
 * with mode 0600 on POSIX systems to restrict access to the current user.
 */

const SHARED_FILE_VERSION = 1;

interface SharedConnectionsFile {
  version: number;
  connections: ConnectionConfig[];
}

export function getSharedConnectionsFilePath(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'sqlens', 'connections.json');
  }
  return path.join(os.homedir(), '.config', 'sqlens', 'connections.json');
}

export function sharedConnectionsFileExists(): boolean {
  return fs.existsSync(getSharedConnectionsFilePath());
}

export function loadSharedConnections(): ConnectionConfig[] {
  const file = getSharedConnectionsFilePath();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<SharedConnectionsFile>;
    if (parsed && Array.isArray(parsed.connections)) {
      return parsed.connections;
    }
  } catch {
    // Missing or unreadable file: start empty. A corrupt file is not silently
    // overwritten here — the next save() replaces it wholesale.
  }
  return [];
}

export function saveSharedConnections(connections: ConnectionConfig[]): void {
  const file = getSharedConnectionsFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload: SharedConnectionsFile = { version: SHARED_FILE_VERSION, connections };
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  if (process.platform !== 'win32') {
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  }
}
