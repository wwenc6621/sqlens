import * as vscode from 'vscode';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { ConnectionManager } from '../connection/ConnectionManager';
import { DatabaseType, ConnectionConfig, ColumnInfo } from '../types';
import type { DatabaseDriver } from '../drivers/DatabaseDriver';

import { t } from '../i18n';

export interface DumpOptions {
  type: 'full' | 'schema-only' | 'data-only';
  outputPath: string;
  databaseName?: string;
}

export interface ImportOptions {
  inputPath: string;
  databaseName?: string;
}

export class DatabaseDumpService {
  constructor(
    private context: vscode.ExtensionContext,
    private connectionManager: ConnectionManager
  ) {}

  async dump(connectionId: string, options: DumpOptions): Promise<void> {
    const conn = await this.connectionManager.getActiveConnection(connectionId);
    if (!conn) {
      throw new Error('Connection is not active');
    }

    const config = conn.config;

    if (config.type === DatabaseType.SQLite) {
      await this.dumpSQLite(connectionId, options);
    } else if (config.type === DatabaseType.MySQL || config.type === DatabaseType.MariaDB) {
      await this.dumpMySQL(connectionId, options);
    } else if (config.type === DatabaseType.PostgreSQL) {
      await this.dumpPostgreSQL(connectionId, options);
    } else {
      throw new Error(`Dump database is not supported for ${config.type}`);
    }
  }

  async import(connectionId: string, options: ImportOptions): Promise<void> {
    const conn = await this.connectionManager.getActiveConnection(connectionId);
    if (!conn) {
      throw new Error('Connection is not active');
    }

    const config = conn.config;

    if (config.type === DatabaseType.SQLite) {
      await this.importSQLite(connectionId, options);
    } else if (config.type === DatabaseType.MySQL || config.type === DatabaseType.MariaDB) {
      await this.importMySQL(connectionId, options);
    } else if (config.type === DatabaseType.PostgreSQL) {
      await this.importPostgreSQL(connectionId, options);
    } else {
      throw new Error(`Import database is not supported for ${config.type}`);
    }
  }

  private async dumpSQLite(connectionId: string, options: DumpOptions): Promise<void> {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: t('Dumping SQLite database...'),
        cancellable: true,
      },
      async (progress, token) => {
        const statements: string[] = [];

        // 1. Get all tables
        const tablesRes = await this.connectionManager.query(
          connectionId,
          "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        );

        const tables = tablesRes.rows.map(row => ({
          name: row[0] as string,
          sql: row[1] as string,
        }));

        let count = 0;
        const total = tables.length || 1;

        for (const table of tables) {
          if (token.isCancellationRequested) {
            throw new Error('Dump cancelled');
          }

          progress.report({
            message: `Dumping table ${table.name} (${count + 1}/${total})`,
            increment: (1 / total) * 90,
          });

          // Schema
          if (options.type !== 'data-only' && table.sql) {
            statements.push(`DROP TABLE IF EXISTS \`${table.name}\`;`);
            statements.push(`${table.sql};`);
          }

          // Data
          if (options.type !== 'schema-only') {
            const dataRes = await this.connectionManager.query(
              connectionId,
              `SELECT * FROM \`${table.name}\``
            );

            const columns = dataRes.columns.map(c => c.name);
            if (dataRes.rows.length > 0) {
              for (const row of dataRes.rows) {
                const values = row.map(val => {
                  if (val === null || val === undefined) {
                    return 'NULL';
                  }
                  if (typeof val === 'string') {
                    return `'${val.replace(/'/g, "''")}'`;
                  }
                  if (typeof val === 'boolean') {
                    return val ? '1' : '0';
                  }
                  if (val instanceof Uint8Array || val instanceof Buffer) {
                    return `X'${Buffer.from(val).toString('hex')}'`;
                  }
                  return `'${String(val).replace(/'/g, "''")}'`;
                });
                statements.push(
                  `INSERT INTO \`${table.name}\` (\`${columns.join('`, `')}\`) VALUES (${values.join(', ')});`
                );
              }
            }
          }
          count++;
        }

        // Indices
        if (options.type !== 'data-only') {
          const indexRes = await this.connectionManager.query(
            connectionId,
            "SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL"
          );
          for (const row of indexRes.rows) {
            statements.push(`${row[0] as string};`);
          }
        }

        fs.writeFileSync(options.outputPath, statements.join('\n'), 'utf8');
        progress.report({ message: 'Saved dump file successfully!', increment: 10 });
      }
    );
  }

  private async dumpMySQL(connectionId: string, options: DumpOptions): Promise<void> {
    const conn = this.connectionManager.getActiveConnection(connectionId);
    if (!conn) {
      throw new Error('Connection is not active');
    }

    const config = this.getCliConfig(conn.config, conn.tunnel);
    const database = options.databaseName || await conn.driver.getCurrentDatabase().catch(() => '') || config.database;
    if (!database) {
      throw new Error('No database selected for dump');
    }

    const args = ['--host', config.host, '--port', String(config.port), '--user', config.username];
    if (options.type === 'schema-only') {
      args.push('--no-data');
    } else if (options.type === 'data-only') {
      args.push('--no-create-info');
    }
    args.push(database);

    try {
      await this.runExternalCommand('mysqldump', args, { MYSQL_PWD: config.password || '' }, options.outputPath);
    } catch (err) {
      await this.dumpUsingDriver(connectionId, options, err);
    }
  }

  private async dumpPostgreSQL(connectionId: string, options: DumpOptions): Promise<void> {
    const conn = this.connectionManager.getActiveConnection(connectionId);
    if (!conn) {
      throw new Error('Connection is not active');
    }

    const config = this.getCliConfig(conn.config, conn.tunnel);
    const database = options.databaseName || await conn.driver.getCurrentDatabase().catch(() => '') || config.database;
    if (!database) {
      throw new Error('No database selected for dump');
    }

    const args = ['-h', config.host, '-p', String(config.port), '-U', config.username];
    if (options.type === 'schema-only') {
      args.push('--schema-only');
    } else if (options.type === 'data-only') {
      args.push('--data-only');
    }
    args.push('-d', database, '-f', options.outputPath);

    try {
      await this.runExternalCommand('pg_dump', args, { PGPASSWORD: config.password || '' });
    } catch (err) {
      await this.dumpUsingDriver(connectionId, options, err);
    }
  }

  private async dumpUsingDriver(connectionId: string, options: DumpOptions, cliError?: unknown): Promise<void> {
    const conn = this.connectionManager.getActiveConnection(connectionId);
    if (!conn) {
      throw new Error('Connection is not active');
    }

    const previousDatabase = await conn.driver.getCurrentDatabase().catch(() => '');
    const targetDatabase = options.databaseName || previousDatabase || conn.config.database;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: t('Dumping database through active connection...'),
        cancellable: true,
      },
      async (progress, token) => {
        try {
          if (targetDatabase && previousDatabase !== targetDatabase) {
            progress.report({ message: `Switching to ${targetDatabase}` });
            await conn.driver.switchDatabase(targetDatabase);
          }

          const statements: string[] = [];
          statements.push('-- Sqlens SQL dump');
          if (targetDatabase) {
            statements.push(`-- Database: ${targetDatabase}`);
          }
          if (cliError) {
            statements.push(`-- Native dump tool failed; driver fallback was used.`);
          }
          statements.push('');

          const schemas = conn.config.type === DatabaseType.PostgreSQL
            ? await conn.driver.getSchemas().then(items => items.map(item => item.name)).catch(() => [undefined])
            : [targetDatabase || undefined];

          for (const schema of schemas) {
            if (token.isCancellationRequested) {
              throw new Error('Dump cancelled');
            }

            const tables = (await conn.driver.getTables(schema)).filter(table => table.type === 'table' || table.type === 'view');
            for (const table of tables) {
              if (token.isCancellationRequested) {
                throw new Error('Dump cancelled');
              }

              progress.report({ message: `Dumping ${table.schema ? `${table.schema}.` : ''}${table.name}` });

              if (options.type !== 'data-only') {
                const ddl = await this.getTableDDL(conn.driver, table.name, table.schema || schema);
                if (ddl) {
                  statements.push(ddl.endsWith(';') ? ddl : `${ddl};`);
                  statements.push('');
                }
              }

              if (options.type !== 'schema-only' && table.type === 'table') {
                const tableName = this.qualifiedIdentifier(conn.driver, table.name, table.schema || schema);
                const result = await conn.driver.query(`SELECT * FROM ${tableName}`);
                const columns = result.columns.map(column => column.name);
                for (const row of result.rows) {
                  const values = row.map(value => this.formatValue(conn.driver, value));
                  statements.push(
                    `INSERT INTO ${tableName} (${columns.map(column => conn.driver.escapeIdentifier(column)).join(', ')}) VALUES (${values.join(', ')});`
                  );
                }
                if (result.rows.length > 0) {
                  statements.push('');
                }
              }
            }
          }

          fs.writeFileSync(options.outputPath, statements.join('\n'), 'utf8');
        } finally {
          if (targetDatabase && previousDatabase && previousDatabase !== targetDatabase) {
            await conn.driver.switchDatabase(previousDatabase).catch(() => {});
          }
        }
      }
    );
  }

  private async getTableDDL(driver: DatabaseDriver, table: string, schema?: string): Promise<string> {
    if (driver.driverType === 'mysql') {
      const result = await driver.query(`SHOW CREATE TABLE ${this.qualifiedIdentifier(driver, table, schema)}`);
      return (result.rows[0]?.[1] as string) || '';
    }

    if (driver.driverType === 'postgresql') {
      const columns = await driver.getColumns(table, schema);
      const primaryKeys = await driver.getPrimaryKey(table, schema).catch(() => []);
      return this.generateCreateTableDDL(driver, table, columns, primaryKeys, schema);
    }

    return '';
  }

  private generateCreateTableDDL(
    driver: DatabaseDriver,
    table: string,
    columns: ColumnInfo[],
    primaryKeys: string[],
    schema?: string,
  ): string {
    const definitions = columns.map(column => {
      let sql = `  ${driver.escapeIdentifier(column.name)} ${column.type}`;
      if (column.defaultValue !== null && column.defaultValue !== undefined && column.defaultValue !== '') {
        sql += ` DEFAULT ${column.defaultValue}`;
      }
      if (!column.nullable) {
        sql += ' NOT NULL';
      }
      return sql;
    });

    if (primaryKeys.length > 0) {
      definitions.push(`  PRIMARY KEY (${primaryKeys.map(key => driver.escapeIdentifier(key)).join(', ')})`);
    }

    return `CREATE TABLE ${this.qualifiedIdentifier(driver, table, schema)} (\n${definitions.join(',\n')}\n);`;
  }

  private qualifiedIdentifier(driver: DatabaseDriver, table: string, schema?: string): string {
    return schema
      ? `${driver.escapeIdentifier(schema)}.${driver.escapeIdentifier(table)}`
      : driver.escapeIdentifier(table);
  }

  private formatValue(driver: DatabaseDriver, value: unknown): string {
    if (value === null || value === undefined) {
      return 'NULL';
    }
    if (value instanceof Uint8Array || value instanceof Buffer) {
      const hex = Buffer.from(value).toString('hex');
      return driver.driverType === 'postgresql' ? `'\\\\x${hex}'` : `X'${hex}'`;
    }
    return driver.escapeValue(value);
  }

  private getCliConfig(config: ConnectionConfig, tunnel?: { localHost: string; localPort: number }): ConnectionConfig {
    if (!tunnel) {
      return config;
    }
    return {
      ...config,
      host: tunnel.localHost,
      port: tunnel.localPort,
    };
  }

  private runExternalCommand(
    command: string,
    args: string[],
    envPatch: NodeJS.ProcessEnv,
    outputPath?: string,
    inputPath?: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        env: { ...process.env, ...envPatch },
        shell: false,
      });

      let stderr = '';
      child.stderr.on('data', chunk => {
        stderr += chunk.toString();
      });

      let output: fs.WriteStream | undefined;
      let input: fs.ReadStream | undefined;

      if (outputPath) {
        output = fs.createWriteStream(outputPath, { encoding: 'utf8' });
        child.stdout.pipe(output);
      } else {
        child.stdout.resume();
      }

      if (inputPath) {
        input = fs.createReadStream(inputPath);
        input.pipe(child.stdin);
      }

      child.on('error', err => {
        output?.destroy();
        input?.destroy();
        reject(err);
      });

      child.on('close', code => {
        output?.end();
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`${command} failed: ${stderr.trim() || `exit code ${code}`}`));
      });
    });
  }

  private async importSQLite(connectionId: string, options: ImportOptions): Promise<void> {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: t('Importing SQL into SQLite...'),
        cancellable: true,
      },
      async (progress, token) => {
        const sqlContent = fs.readFileSync(options.inputPath, 'utf8');
        const statements = this.splitSqlStatements(sqlContent);
        const total = statements.length;

        // Wrap in transaction for speed and safety
        await this.connectionManager.query(connectionId, 'BEGIN TRANSACTION');

        try {
          let count = 0;
          for (const stmt of statements) {
            if (token.isCancellationRequested) {
              throw new Error('Import cancelled');
            }

            if (count % 100 === 0) {
              progress.report({
                message: `Executing statement ${count}/${total}`,
                increment: (100 / total) * 90,
              });
            }

            await this.connectionManager.query(connectionId, stmt);
            count++;
          }
          await this.connectionManager.query(connectionId, 'COMMIT');
        } catch (err) {
          await this.connectionManager.query(connectionId, 'ROLLBACK').catch(() => {});
          throw err;
        }
      }
    );
  }

  private async importMySQL(connectionId: string, options: ImportOptions): Promise<void> {
    const conn = this.connectionManager.getActiveConnection(connectionId);
    if (!conn) {
      throw new Error('Connection is not active');
    }

    const config = this.getCliConfig(conn.config, conn.tunnel);
    const database = options.databaseName || await conn.driver.getCurrentDatabase().catch(() => '') || config.database;
    if (!database) {
      throw new Error('No database selected for import');
    }

    const args = ['-h', config.host, '-P', String(config.port), '-u', config.username, database];
    await this.runExternalCommand('mysql', args, { MYSQL_PWD: config.password || '' }, undefined, options.inputPath);
  }

  private async importPostgreSQL(connectionId: string, options: ImportOptions): Promise<void> {
    const conn = this.connectionManager.getActiveConnection(connectionId);
    if (!conn) {
      throw new Error('Connection is not active');
    }

    const config = this.getCliConfig(conn.config, conn.tunnel);
    const database = options.databaseName || await conn.driver.getCurrentDatabase().catch(() => '') || config.database;
    if (!database) {
      throw new Error('No database selected for import');
    }

    const args = ['-h', config.host, '-p', String(config.port), '-U', config.username, '-d', database, '-f', options.inputPath];
    await this.runExternalCommand('psql', args, { PGPASSWORD: config.password || '' });
  }

  private splitSqlStatements(sql: string): string[] {
    const statements: string[] = [];
    let current = '';
    let inString = false;
    let stringChar = '';
    let inComment = false;

    for (let i = 0; i < sql.length; i++) {
      const char = sql[i];
      const next = sql[i + 1];

      if (inComment) {
        if (char === '\n') {
          inComment = false;
        }
        continue;
      }

      if (!inString && char === '-' && next === '-') {
        inComment = true;
        i++;
        continue;
      }

      if (char === "'" || char === '"' || char === '`') {
        if (!inString) {
          inString = true;
          stringChar = char;
        } else if (stringChar === char) {
          if (sql[i - 1] !== '\\') {
            inString = false;
          }
        }
      }

      current += char;

      if (char === ';' && !inString) {
        const stmt = current.trim();
        if (stmt) {
          statements.push(stmt);
        }
        current = '';
      }
    }

    const remainder = current.trim();
    if (remainder) {
      statements.push(remainder);
    }

    return statements;
  }
}
