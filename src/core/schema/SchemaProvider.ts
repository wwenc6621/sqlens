import { ConnectionManager } from '../connection/ConnectionManager';
import { TableInfo, ColumnInfo } from '../types';

interface SchemaCache {
  tables: TableInfo[];
  columns: Map<string, ColumnInfo[]>;
  lastRefresh: number;
}

/**
 * Caches database schema metadata for autocomplete and hover providers.
 * Refreshes automatically when the active connection or database changes.
 */
export class SchemaProvider {
  private cache = new Map<string, SchemaCache>();
  private refreshing = new Set<string>();

  /** Cache TTL in milliseconds (5 minutes) */
  private readonly CACHE_TTL = 5 * 60 * 1000;

  constructor(private connectionManager: ConnectionManager) {
    connectionManager.onActiveConnectionChanged(() => {
      this.refreshActiveConnection();
    });
  }

  /** Get tables for the active connection */
  async getTables(): Promise<TableInfo[]> {
    const id = this.connectionManager.activeConnectionId;
    if (!id) { return []; }

    await this.ensureCache(id);
    return this.cache.get(id)?.tables || [];
  }

  /** Get columns for a specific table */
  async getColumns(tableName: string): Promise<ColumnInfo[]> {
    const id = this.connectionManager.activeConnectionId;
    if (!id) { return []; }

    const cached = this.cache.get(id);
    if (cached?.columns.has(tableName)) {
      return cached.columns.get(tableName)!;
    }

    // Fetch columns on demand
    const driver = this.connectionManager.getDriver(id);
    if (!driver) { return []; }

    try {
      const columns = await driver.getColumns(tableName);
      if (cached) {
        cached.columns.set(tableName, columns);
      }
      return columns;
    } catch {
      return [];
    }
  }

  /** Get all cached column names across all tables (for global autocomplete) */
  async getAllColumns(): Promise<Map<string, ColumnInfo[]>> {
    const id = this.connectionManager.activeConnectionId;
    if (!id) { return new Map(); }

    const cached = this.cache.get(id);
    return cached?.columns || new Map();
  }

  /** Force refresh the cache for the active connection */
  async refresh(): Promise<void> {
    const id = this.connectionManager.activeConnectionId;
    if (!id) { return; }

    this.cache.delete(id);
    await this.ensureCache(id);
  }

  /** Clear all caches */
  clearAll(): void {
    this.cache.clear();
  }

  private async refreshActiveConnection(): Promise<void> {
    const id = this.connectionManager.activeConnectionId;
    if (id) {
      await this.ensureCache(id);
    }
  }

  private async ensureCache(connectionId: string): Promise<void> {
    const existing = this.cache.get(connectionId);
    const now = Date.now();

    // Return if cache is fresh
    if (existing && (now - existing.lastRefresh) < this.CACHE_TTL) {
      return;
    }

    // Prevent concurrent refreshes
    if (this.refreshing.has(connectionId)) { return; }
    this.refreshing.add(connectionId);

    try {
      const driver = this.connectionManager.getDriver(connectionId);
      if (!driver || !driver.isConnected) { return; }

      const tables = await driver.getTables();

      const columns = new Map<string, ColumnInfo[]>();
      // Pre-fetch columns for first 50 tables (avoid overloading on large schemas)
      const tablesToFetch = tables.slice(0, 50);
      await Promise.allSettled(
        tablesToFetch.map(async (table) => {
          try {
            const cols = await driver.getColumns(table.name, table.schema);
            columns.set(table.name, cols);
          } catch {
            // Skip tables that fail to load columns
          }
        })
      );

      this.cache.set(connectionId, {
        tables,
        columns,
        lastRefresh: now,
      });
    } finally {
      this.refreshing.delete(connectionId);
    }
  }
}
