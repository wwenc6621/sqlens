import * as net from 'net';
import { Client as SSHClient } from 'ssh2';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SSHConfig } from '../types';
import { Logger } from '../utils/Logger';

function expandTilde(filepath: string): string {
  if (filepath.startsWith('~/') || filepath === '~') {
    return path.join(os.homedir(), filepath.slice(1));
  }
  return filepath;
}

export interface TunnelInfo {
  localHost: string;
  localPort: number;
  close: () => void;
}

/**
 * Creates SSH tunnels for database connections.
 * Forwards a local port to the remote database host:port through the SSH server.
 */
export class SSHTunnelManager {
  private tunnels = new Map<string, TunnelInfo>();

  /**
   * Create an SSH tunnel that forwards localPort → remoteHost:remotePort
   * through the SSH server.
   * 
   * @returns TunnelInfo with the local host/port to connect to
   */
  async createTunnel(
    connectionId: string,
    sshConfig: SSHConfig,
    remoteHost: string,
    remotePort: number,
  ): Promise<TunnelInfo> {
    // Close existing tunnel for this connection
    this.closeTunnel(connectionId);

    return new Promise((resolve, reject) => {
      const sshClient = new SSHClient();
      let isResolved = false;

      const connectConfig: any = {
        host: sshConfig.host,
        port: sshConfig.port,
        username: sshConfig.username,
        readyTimeout: 15_000,
        keepaliveInterval: 10_000,
        keepaliveCountMax: 3,
      };

      // Auth method
      switch (sshConfig.authMethod) {
        case 'password':
          connectConfig.password = sshConfig.password;
          Logger.getInstance().logInfo(`SSH Tunnel: Authenticating with password for ${sshConfig.username}@${sshConfig.host}`);
          break;
        case 'privateKey': {
          const rawPath = sshConfig.privateKeyPath || '~/.ssh/id_rsa';
          const resolvedPath = expandTilde(rawPath);
          try {
            connectConfig.privateKey = fs.readFileSync(resolvedPath);
            if (sshConfig.passphrase) {
              connectConfig.passphrase = sshConfig.passphrase;
            }
            Logger.getInstance().logInfo(`SSH Tunnel: Authenticating with key ${rawPath} for ${sshConfig.username}@${sshConfig.host}`);
          } catch (err) {
            const errorMsg = `Failed to read SSH private key: ${rawPath} (${resolvedPath})`;
            Logger.getInstance().logError(errorMsg, err);
            reject(new Error(errorMsg));
            return;
          }
          break;
        }
        case 'agent':
          connectConfig.agent = process.env.SSH_AUTH_SOCK;
          Logger.getInstance().logInfo(`SSH Tunnel: Authenticating with SSH agent for ${sshConfig.username}@${sshConfig.host}`);
          break;
      }

      // Create a local TCP server to forward connections
      const server = net.createServer((socket) => {
        sshClient.forwardOut(
          socket.remoteAddress || '127.0.0.1',
          socket.remotePort || 0,
          remoteHost,
          remotePort,
          (err, stream) => {
            if (err) {
              Logger.getInstance().logError(`SSH Tunnel: Forwarding failed for ${remoteHost}:${remotePort}: ${err.message}`, err);
              socket.destroy();
              return;
            }
            socket.pipe(stream).pipe(socket);

            socket.on('error', () => stream.destroy());
            stream.on('error', () => socket.destroy());
          }
        );
      });

      server.on('error', (err) => {
        sshClient.end();
        if (!isResolved) {
          isResolved = true;
          reject(new Error(`SSH tunnel server error: ${err.message}`));
        } else {
          Logger.getInstance().logError(`SSH Tunnel local server error: ${err.message}`, err);
        }
      });

      sshClient.on('ready', () => {
        Logger.getInstance().logInfo(`SSH Tunnel connection established to ${sshConfig.username}@${sshConfig.host}`);
        // Find a free port and start listening only after SSH client is ready
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address() as net.AddressInfo;

          const tunnelInfo: TunnelInfo = {
            localHost: '127.0.0.1',
            localPort: addr.port,
            close: () => {
              server.close();
              sshClient.end();
              this.tunnels.delete(connectionId);
            },
          };

          this.tunnels.set(connectionId, tunnelInfo);
          isResolved = true;
          resolve(tunnelInfo);
        });
      });

      sshClient.on('error', (err) => {
        server.close();
        if (!isResolved) {
          isResolved = true;
          reject(new Error(`SSH connection error: ${err.message}`));
        } else {
          Logger.getInstance().logError(`SSH Tunnel connection error: ${err.message}`, err);
        }
      });

      sshClient.on('close', () => {
        server.close();
        this.tunnels.delete(connectionId);
      });

      sshClient.connect(connectConfig);
    });
  }

  closeTunnel(connectionId: string): void {
    const tunnel = this.tunnels.get(connectionId);
    if (tunnel) {
      tunnel.close();
    }
  }

  closeAll(): void {
    for (const [id] of this.tunnels) {
      this.closeTunnel(id);
    }
  }

  hasTunnel(connectionId: string): boolean {
    return this.tunnels.has(connectionId);
  }

  getTunnel(connectionId: string): TunnelInfo | undefined {
    return this.tunnels.get(connectionId);
  }
}
