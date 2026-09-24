import * as fs from 'fs';
import * as vscode from 'vscode';
import { DatabaseDriver } from '../drivers/DatabaseDriver';

export class ImportExportService {
  /**
   * Export table or query results to a file.
   */
  static async exportData(
    driver: DatabaseDriver,
    sql: string,
    format: 'csv' | 'json' | 'sql',
    targetPath: string,
    tableName?: string
  ): Promise<void> {
    const result = await driver.query(sql);
    const headers = result.columns.map(c => c.name);
    let content = '';

    if (format === 'csv') {
      // Write headers
      content += headers.map(h => this.escapeCSVField(h)).join(',') + '\n';
      
      // Write rows
      for (const row of result.rows) {
        content += row.map(cell => this.escapeCSVField(cell)).join(',') + '\n';
      }
    } else if (format === 'json') {
      const records = result.rows.map(row => {
        const obj: Record<string, unknown> = {};
        headers.forEach((h, idx) => {
          obj[h] = row[idx];
        });
        return obj;
      });
      content = JSON.stringify(records, null, 2);
    } else if (format === 'sql') {
      const tName = tableName || 'exported_table';
      const escapedTable = driver.escapeIdentifier(tName);
      
      const statements: string[] = [];
      for (const row of result.rows) {
        const colList = headers.map(h => driver.escapeIdentifier(h)).join(', ');
        const valList = row.map(val => driver.escapeValue(val)).join(', ');
        statements.push(`INSERT INTO ${escapedTable} (${colList}) VALUES (${valList});`);
      }
      content = statements.join('\n');
    }

    fs.writeFileSync(targetPath, content, 'utf8');
  }

  /**
   * Import data from CSV or JSON into a specific table.
   */
  static async importData(
    driver: DatabaseDriver,
    targetTable: string,
    targetSchema: string | undefined,
    format: 'csv' | 'json',
    filePath: string
  ): Promise<{ inserted: number; errors: string[] }> {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    let rows: Record<string, unknown>[] = [];

    if (format === 'json') {
      const parsed = JSON.parse(fileContent);
      if (!Array.isArray(parsed)) {
        throw new Error('JSON file must be an array of objects.');
      }
      rows = parsed;
    } else if (format === 'csv') {
      const parsedCSV = this.parseCSV(fileContent);
      if (parsedCSV.length < 2) {
        throw new Error('CSV file must contain a header row and at least one data row.');
      }

      const headers = parsedCSV[0].map(h => h.trim());
      for (let i = 1; i < parsedCSV.length; i++) {
        const values = parsedCSV[i];
        if (values.length === 0 || (values.length === 1 && values[0] === '')) continue;
        
        const rowObj: Record<string, unknown> = {};
        headers.forEach((h, idx) => {
          rowObj[h] = values[idx] !== undefined ? values[idx] : null;
        });
        rows.push(rowObj);
      }
    }

    if (rows.length === 0) {
      return { inserted: 0, errors: [] };
    }

    // Chunk and insert rows
    const chunkSize = 100;
    let insertedCount = 0;
    const errors: string[] = [];
    const escapedTable = targetSchema
      ? `${driver.escapeIdentifier(targetSchema)}.${driver.escapeIdentifier(targetTable)}`
      : driver.escapeIdentifier(targetTable);

    // Get the headers/columns list from the first row keys
    const headers = Object.keys(rows[0]);
    const columnsPart = headers.map(h => driver.escapeIdentifier(h)).join(', ');

    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      
      if (driver.driverType === 'sqlite') {
        // SQLite: Run individually or in transaction for safety
        try {
          await driver.query('BEGIN TRANSACTION');
          for (const row of chunk) {
            const valuesPart = headers.map(h => driver.escapeValue(row[h])).join(', ');
            const sql = `INSERT INTO ${escapedTable} (${columnsPart}) VALUES (${valuesPart})`;
            await driver.query(sql);
            insertedCount++;
          }
          await driver.query('COMMIT');
        } catch (err) {
          try { await driver.query('ROLLBACK'); } catch {}
          errors.push(`Chunk starting at row ${i + 1} failed: ${err instanceof Error ? err.message : err}`);
        }
      } else {
        // MySQL / PG: Multi-row insert values
        try {
          const valuesChunks: string[] = [];
          for (const row of chunk) {
            const valuesPart = headers.map(h => driver.escapeValue(row[h])).join(', ');
            valuesChunks.push(`(${valuesPart})`);
          }
          const sql = `INSERT INTO ${escapedTable} (${columnsPart}) VALUES ${valuesChunks.join(', ')}`;
          await driver.query(sql);
          insertedCount += chunk.length;
        } catch (err) {
          errors.push(`Chunk starting at row ${i + 1} failed: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    return {
      inserted: insertedCount,
      errors
    };
  }

  private static escapeCSVField(val: unknown): string {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  private static parseCSV(text: string): string[][] {
    const lines: string[][] = [];
    let row: string[] = [];
    let inQuotes = false;
    let entry = '';

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const nextChar = text[i + 1];

      if (char === '"') {
        if (inQuotes && nextChar === '"') {
          entry += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        row.push(entry);
        entry = '';
      } else if ((char === '\r' || char === '\n') && !inQuotes) {
        if (char === '\r' && nextChar === '\n') {
          i++;
        }
        row.push(entry);
        lines.push(row);
        row = [];
        entry = '';
      } else {
        entry += char;
      }
    }

    if (entry || row.length > 0) {
      row.push(entry);
      lines.push(row);
    }

    return lines;
  }
}
