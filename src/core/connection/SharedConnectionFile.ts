import * as crypto from 'crypto';
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
 * Secrets (connection password, SSH password, key passphrase) are stored
 * AES-256-GCM encrypted. The random 256-bit key lives in a separate
 * `<dir>/.key` file (0600), shared by all IDEs on the machine. Values from
 * older plaintext files are migrated to encrypted form on first read.
 */

const SHARED_FILE_VERSION = 1;
const ENC_PREFIX = 'enc:v1:';

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

function getKeyFilePath(): string {
  return path.join(path.dirname(getSharedConnectionsFilePath()), '.key');
}

/** Load the shared 256-bit encryption key, creating it on first use. */
function loadOrCreateKey(): Buffer {
  const keyFile = getKeyFilePath();
  try {
    const hex = fs.readFileSync(keyFile, 'utf8').trim();
    if (/^[0-9a-fA-F]{64}$/.test(hex)) {
      return Buffer.from(hex, 'hex');
    }
  } catch { /* first run */ }

  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, `${key.toString('hex')}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(keyFile, 0o600); } catch { /* best effort */ }
  }
  return key;
}

function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', loadOrCreateKey(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ENC_PREFIX + [
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    data.toString('base64'),
  ].join(':');
}

function decryptSecret(value: string): string {
  if (!value.startsWith(ENC_PREFIX)) {
    // Legacy plaintext value — returned as-is and upgraded on next save.
    return value;
  }
  try {
    let rest = value.slice(ENC_PREFIX.length);
    if (rest.startsWith(':')) {
      // Compatibility with the short-lived 0.1.2 build that wrote an extra
      // empty segment after the prefix.
      rest = rest.slice(1);
    }
    const parts = rest.split(':');
    if (parts.length !== 3) { return ''; }
    const [ivB64, tagB64, dataB64] = parts;
    const decipher = crypto.createDecipheriv('aes-256-gcm', loadOrCreateKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key or tampered data: treat as no password rather than failing.
    return '';
  }
}

/** Secret-bearing fields on a connection config. */
function withSecrets(config: ConnectionConfig, transform: (value: string) => string): ConnectionConfig {
  const next: ConnectionConfig = { ...config, ssh: { ...config.ssh } };
  if (typeof next.password === 'string' && next.password) {
    next.password = transform(next.password);
  }
  if (typeof next.ssh.password === 'string' && next.ssh.password) {
    next.ssh.password = transform(next.ssh.password);
  }
  if (typeof next.ssh.passphrase === 'string' && next.ssh.passphrase && next.ssh.passphrase !== '<ask>') {
    next.ssh.passphrase = transform(next.ssh.passphrase);
  }
  return next;
}

/** True when any secret on the config is stored as legacy plaintext. */
function hasPlaintextSecrets(config: ConnectionConfig): boolean {
  const isPlain = (v?: string) => !!v && v !== '<ask>' && !v.startsWith(ENC_PREFIX);
  return isPlain(config.password) || isPlain(config.ssh.password) || isPlain(config.ssh.passphrase);
}

export function sharedConnectionsFileExists(): boolean {
  return fs.existsSync(getSharedConnectionsFilePath());
}

export function loadSharedConnections(): ConnectionConfig[] {
  const file = getSharedConnectionsFilePath();
  let loaded: ConnectionConfig[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<SharedConnectionsFile>;
    if (parsed && Array.isArray(parsed.connections)) {
      loaded = parsed.connections;
    }
  } catch {
    // Missing or unreadable file: start empty. A corrupt file is not silently
    // overwritten here — the next save() replaces it wholesale.
    return [];
  }

  // Decrypt secrets for use, and migrate legacy plaintext / malformed
  // encrypted values in place.
  const decrypted = loaded.map(c => withSecrets(c, decryptSecret));
  const needsUpgrade = loaded.some(hasPlaintextSecrets)
    || JSON.stringify(loaded).includes(`${ENC_PREFIX}:`);
  if (needsUpgrade) {
    saveSharedConnections(decrypted);
  }
  return decrypted;
}

export function saveSharedConnections(connections: ConnectionConfig[]): void {
  const file = getSharedConnectionsFilePath();
  const encrypted = connections.map(c => withSecrets(c, encryptSecret));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload: SharedConnectionsFile = { version: SHARED_FILE_VERSION, connections: encrypted };
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  if (process.platform !== 'win32') {
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  }
}
