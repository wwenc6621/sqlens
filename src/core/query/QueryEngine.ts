import * as vscode from 'vscode';
import { ConnectionManager } from '../connection/ConnectionManager';
import { QueryResult } from '../types';
import { QueryHistory } from './QueryHistory';
import { t } from '../i18n';
import { classifyRedisCommand, splitRedisCommands } from '../redisCommands';

/**
 * Manages query execution with timeout, cancellation, progress, and history tracking.
 */
export class QueryEngine {
  private runningQuery: AbortController | null = null;

  constructor(
    private connectionManager: ConnectionManager,
    private queryHistory: QueryHistory,
  ) {}

  get isRunning(): boolean {
    return this.runningQuery !== null;
  }

  private isWriteQuery(sql: string, connectionId?: string): boolean {
    const cleanSql = sql.trim().toLowerCase();
    // Redis has no SQL keywords; classify by command tables instead.
    if (connectionId) {
      const driver = this.connectionManager.getDriver(connectionId);
      if (driver?.driverType === 'redis') {
        return splitRedisCommands(sql).some(line => {
          const cat = classifyRedisCommand(line);
          return cat === 'write' || cat === 'danger';
        });
      }
    }
    const writeKeywords = /\b(insert|update|delete|drop|truncate|alter|create|replace)\b/i;
    return writeKeywords.test(cleanSql);
  }

  /**
   * Execute a SQL query on the active connection.
   * Shows progress notification and records to history.
   */
  async execute(
    sql: string,
    connectionId?: string,
  ): Promise<QueryResult> {
    const connId = connectionId || this.connectionManager.activeConnectionId;
    if (!connId) {
      throw new Error('No active connection');
    }

    const driver = this.connectionManager.getDriver(connId);
    if (!driver || !driver.isConnected) {
      throw new Error('Not connected to database');
    }

    const configObj = vscode.workspace.getConfiguration('sqlens');
    const safeMode = configObj.get<boolean>('safeMode', true);

    if (safeMode && this.isWriteQuery(sql, connId)) {
      const confirm = await vscode.window.showWarningMessage(
        t('Safe Mode Alert: You are about to execute a write/modify query. Are you sure you want to proceed?'),
        { modal: true },
        t('Execute Query'),
      );
      if (confirm !== 'Execute Query') {
        throw new Error('Query cancelled by user (Safe Mode)');
      }
    }

    const timeoutSec = configObj.get<number>('queryTimeout', 30);

    // Get connection info for history
    const configs = await this.connectionManager.getSavedConnections();
    const config = configs.find(c => c.id === connId);
    const connectionName = config?.name || 'Unknown';
    let database = '';
    try {
      database = await driver.getCurrentDatabase();
    } catch {
      database = config?.database || '';
    }

    const abortController = new AbortController();
    this.runningQuery = abortController;

    let timeoutId: NodeJS.Timeout | undefined;

    try {
      vscode.commands.executeCommand('setContext', 'sqlens.queryRunning', true);

      const startTime = performance.now();
      
      let queryPromise = driver.query(sql);

      if (timeoutSec > 0) {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            driver.cancelQuery().catch(() => {});
            reject(new Error(`Query execution timed out after ${timeoutSec} seconds.`));
          }, timeoutSec * 1000);
        });
        queryPromise = Promise.race([queryPromise, timeoutPromise]);
      }

      const result = await queryPromise;
      const executionTime = Math.round(performance.now() - startTime);

      // Override execution time from driver with our own measurement
      result.executionTime = executionTime;

      // Record to history
      this.queryHistory.add({
        sql,
        connectionId: connId,
        connectionName,
        database,
        executionTime,
        rowCount: result.rows.length || result.affectedRows,
        success: true,
      });

      return result;

    } catch (err) {
      // Record failed query to history
      this.queryHistory.add({
        sql,
        connectionId: connId,
        connectionName,
        database,
        executionTime: 0,
        rowCount: 0,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });

      throw err;

    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      this.runningQuery = null;
      vscode.commands.executeCommand('setContext', 'sqlens.queryRunning', false);
    }
  }

  /**
   * Execute multiple SQL statements and return all results.
   */
  async executeMultiple(sql: string, connectionId?: string): Promise<QueryResult[]> {
    const connId = connectionId || this.connectionManager.activeConnectionId;
    if (!connId) {
      throw new Error('No active connection');
    }

    const driver = this.connectionManager.getDriver(connId);
    if (!driver || !driver.isConnected) {
      throw new Error('Not connected to database');
    }

    const configObj = vscode.workspace.getConfiguration('sqlens');
    const safeMode = configObj.get<boolean>('safeMode', true);

    if (safeMode && this.isWriteQuery(sql, connId)) {
      const confirm = await vscode.window.showWarningMessage(
        t('Safe Mode Alert: You are about to execute a script containing write/modify queries. Are you sure you want to proceed?'),
        { modal: true },
        t('Execute Script'),
      );
      if (confirm !== 'Execute Script') {
        throw new Error('Query script cancelled by user (Safe Mode)');
      }
    }

    const timeoutSec = configObj.get<number>('queryTimeout', 30);
    let timeoutId: NodeJS.Timeout | undefined;

    try {
      vscode.commands.executeCommand('setContext', 'sqlens.queryRunning', true);
      
      let queryPromise = driver.queryMultiple(sql);

      if (timeoutSec > 0) {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            driver.cancelQuery().catch(() => {});
            reject(new Error(`Query execution timed out after ${timeoutSec} seconds.`));
          }, timeoutSec * 1000);
        });
        queryPromise = Promise.race([queryPromise, timeoutPromise]);
      }

      const results = await queryPromise;
      return results;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      vscode.commands.executeCommand('setContext', 'sqlens.queryRunning', false);
    }
  }

  /**
   * Cancel the currently running query.
   */
  async cancel(): Promise<void> {
    if (!this.runningQuery) { return; }

    const connId = this.connectionManager.activeConnectionId;
    if (connId) {
      const driver = this.connectionManager.getDriver(connId);
      if (driver) {
        await driver.cancelQuery();
      }
    }

    this.runningQuery.abort();
    this.runningQuery = null;
    vscode.commands.executeCommand('setContext', 'sqlens.queryRunning', false);
  }
}
