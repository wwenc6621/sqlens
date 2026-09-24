import { DatabaseDriver } from './DatabaseDriver';
import { MySQLDriver } from './MySQLDriver';
import { PostgreSQLDriver } from './PostgreSQLDriver';
import { SQLiteDriver } from './SQLiteDriver';
import { DatabaseType } from '../types';

/**
 * Factory for creating database driver instances based on DatabaseType.
 * Each connection gets its own driver instance.
 */
export class DriverFactory {
  private static readonly driverMap: Record<string, new () => DatabaseDriver> = {
    [DatabaseType.MySQL]: MySQLDriver,
    [DatabaseType.MariaDB]: MySQLDriver,
    [DatabaseType.PostgreSQL]: PostgreSQLDriver,
    [DatabaseType.SQLite]: SQLiteDriver,
  };

  static createDriver(type: DatabaseType): DatabaseDriver {
    const DriverClass = this.driverMap[type];
    if (!DriverClass) {
      throw new Error(`Unsupported database type: ${type}. Supported: ${Object.keys(this.driverMap).join(', ')}`);
    }
    return new DriverClass();
  }

  static isSupported(type: DatabaseType): boolean {
    return type in this.driverMap;
  }

  static getSupportedTypes(): DatabaseType[] {
    return Object.keys(this.driverMap) as DatabaseType[];
  }
}
