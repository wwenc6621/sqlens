/**
 * Parser for standard connection URIs, one per line:
 *   mysql://user:pass@host:3306/db?sslmode=required
 *
 * SSH tunneled connections use a sqlens extension convention:
 *   mysql://host/db?ssh=true&ssh_host=bastion&ssh_user=ops&ssh_port=2222
 */

import { SSLMode } from '../../types';
import { mapSslMode, normalizeBatch } from './normalizer';
import { schemeToType } from './uriUtils';
import { ImportFormat, ParsedConnection, Parser } from './types';

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//;

export class UriParser implements Parser {
  get format(): ImportFormat { return 'connection-uri'; }

  probe(text: string): number {
    const lines = this.candidateLines(text);
    if (lines.length === 0) { return 0; }
    const recognized = lines.filter(line => {
      const m = line.match(SCHEME_RE);
      return !!m && schemeToType(m[1]) !== undefined;
    }).length;
    const ratio = recognized / lines.length;
    // 1.0 for all lines recognized, 0 when fewer than half.
    return ratio >= 0.5 ? 0.5 + 0.5 * ratio : ratio * 0.4;
  }

  parse(text: string): ParsedConnection[] {
    const items: Parameters<typeof normalizeBatch>[0] = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#')) { continue; }
      const parsed = this.parseUri(line);
      if (!parsed) {
        continue; // non-URI lines are skipped; probe() decides whether this parser runs at all
      }
      items.push({ partial: parsed.partial, format: 'connection-uri', line: i + 1, raw: line, ...parsed.extra });
    }
    return normalizeBatch(items).connections;
  }

  /** Split into meaningful lines for probing (ignores blanks and comments). */
  private candidateLines(text: string): string[] {
    return text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  }

  private parseUri(raw: string): { partial: Record<string, unknown>; extra?: Record<string, unknown> } | undefined {
    const schemeMatch = raw.match(SCHEME_RE);
    if (!schemeMatch) { return undefined; }
    const type = schemeToType(schemeMatch[1]);
    if (!type) { return undefined; }
    const scheme = schemeMatch[1].toLowerCase();

    let rest = raw.slice(schemeMatch[0].length);

    // Query string.
    const queryIndex = rest.indexOf('?');
    let query = '';
    if (queryIndex >= 0) {
      query = rest.slice(queryIndex + 1);
      rest = rest.slice(0, queryIndex);
    }

    // userinfo@hostport/db — password may contain '/', so split on the LAST '/'.
    let userinfo = '';
    const at = rest.lastIndexOf('@');
    let hostPart = rest;
    if (at >= 0 && rest.slice(0, at).indexOf('/') === -1) {
      userinfo = rest.slice(0, at);
      hostPart = rest.slice(at + 1);
    }
    const slash = hostPart.indexOf('/');
    let database = '';
    if (slash >= 0) {
      database = decodeURIComponent(hostPart.slice(slash + 1));
      hostPart = hostPart.slice(0, slash);
    }

    // user:password
    let username = '';
    let password = '';
    if (userinfo) {
      const colon = userinfo.indexOf(':');
      if (colon >= 0) {
        username = decodeURIComponent(userinfo.slice(0, colon));
        password = decodeURIComponent(userinfo.slice(colon + 1));
      } else {
        username = decodeURIComponent(userinfo);
      }
    }

    // host:port (bracketed IPv6 keeps its colons)
    let host = '';
    let port: number | undefined;
    if (hostPart.startsWith('[')) {
      const close = hostPart.indexOf(']');
      host = hostPart.slice(1, close >= 0 ? close : undefined);
      const tail = close >= 0 ? hostPart.slice(close + 1) : '';
      if (tail.startsWith(':')) { port = Number(tail.slice(1)); }
    } else {
      const colon = hostPart.lastIndexOf(':');
      if (colon >= 0 && /^\d+$/.test(hostPart.slice(colon + 1))) {
        host = hostPart.slice(0, colon);
        port = Number(hostPart.slice(colon + 1));
      } else {
        host = hostPart;
      }
    }

    const options: Record<string, unknown> = {};
    const ssl: Record<string, unknown> = {};
    const ssh: Record<string, unknown> = {};
    const params = new URLSearchParams(query);

    for (const [key, value] of params as unknown as Iterable<[string, string]>) {
      const k = key.toLowerCase();
      switch (k) {
        case 'sslmode':
        case 'ssl_mode': {
          const mode = mapSslMode(value);
          if (mode) { ssl.mode = mode; }
          break;
        }
        case 'ssl_ca':
        case 'sslca':
          ssl.caPath = value;
          break;
        case 'ssl_cert':
        case 'sslcert':
          ssl.certPath = value;
          break;
        case 'ssl_key':
        case 'sslkey':
          ssl.keyPath = value;
          break;
        case 'ssh':
          if (value === 'true' || value === '1') { ssh.enabled = true; }
          break;
        case 'ssh_host':
          ssh.enabled = true;
          ssh.host = value;
          break;
        case 'ssh_port':
          ssh.port = Number(value) || 22;
          break;
        case 'ssh_user':
          ssh.username = value;
          break;
        case 'ssh_pass':
          ssh.password = value;
          break;
        case 'ssh_key':
          ssh.privateKeyPath = value;
          break;
        default:
          options[k] = value;
      }
    }

    if (scheme === 'rediss') { ssl.mode = ssl.mode ?? SSLMode.Required; }
    if (scheme === 'mongodb+srv') { options.srv = true; }

    if (String(type) === 'sqlite') {
      // sqlite:///absolute/path — the leading '/' of the path survives the
      // authority split, so re-derive from the raw text instead.
      const path = raw.slice(`${scheme}://`.length).split('?')[0];
      return { partial: { type, filepath: decodeURIComponent(path), name: path.split('/').pop() || 'SQLite' } };
    }

    const partial: Record<string, unknown> = {
      type,
      host,
      port,
      username,
      password: password || undefined,
      database: database || undefined,
    };
    if (Object.keys(ssl).length > 0) { partial.ssl = ssl; }
    if (Object.keys(ssh).length > 0) { partial.ssh = ssh; }
    if (Object.keys(options).length > 0) { partial.options = options; }

    return { partial };
  }
}
