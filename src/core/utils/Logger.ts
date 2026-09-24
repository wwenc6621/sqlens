import * as vscode from 'vscode';

export interface LogEntry {
  timestamp: Date;
  type: 'info' | 'error' | 'sql';
  message: string;
  details?: string;
  executionTime?: number;
}

export class Logger {
  private static instance: Logger;
  private outputChannel: vscode.OutputChannel;
  private logs: LogEntry[] = [];
  private _onDidAddLog = new vscode.EventEmitter<LogEntry>();
  readonly onDidAddLog = this._onDidAddLog.event;

  private constructor() {
    this.outputChannel = vscode.window.createOutputChannel('Sqlens Log');
  }

  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  logInfo(message: string): void {
    const entry: LogEntry = {
      timestamp: new Date(),
      type: 'info',
      message,
    };
    this.addEntry(entry);
  }

  logError(message: string, error?: unknown): void {
    const details = error instanceof Error ? error.stack || error.message : String(error);
    const entry: LogEntry = {
      timestamp: new Date(),
      type: 'error',
      message,
      details,
    };
    this.addEntry(entry);
  }

  logSQL(sql: string, executionTime?: number, error?: string): void {
    const entry: LogEntry = {
      timestamp: new Date(),
      type: 'sql',
      message: sql,
      executionTime,
      details: error,
    };
    this.addEntry(entry);
  }

  getLogs(): LogEntry[] {
    return this.logs;
  }

  clear(): void {
    this.logs = [];
    this.outputChannel.clear();
    this._onDidAddLog.fire({ timestamp: new Date(), type: 'info', message: 'Logs cleared.' });
  }

  showOutput(): void {
    this.outputChannel.show();
  }

  private addEntry(entry: LogEntry): void {
    this.logs.unshift(entry);
    if (this.logs.length > 1000) {
      this.logs.pop();
    }

    const timeStr = entry.timestamp.toLocaleTimeString();
    let logLine = `[${timeStr}] [${entry.type.toUpperCase()}] ${entry.message}`;
    if (entry.executionTime !== undefined) {
      logLine += ` (${entry.executionTime}ms)`;
    }
    if (entry.details) {
      logLine += `\nDetails/Error: ${entry.details}`;
    }

    this.outputChannel.appendLine(logLine);
    this._onDidAddLog.fire(entry);
  }
}
