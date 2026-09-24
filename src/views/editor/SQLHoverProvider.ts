import * as vscode from 'vscode';
import { SchemaProvider } from '../../core/schema/SchemaProvider';

/**
 * Provides hover information for table names and column names in SQL files.
 * Shows column type, constraints, and table metadata on hover.
 */
export class SQLHoverProvider implements vscode.HoverProvider {
  constructor(private schemaProvider: SchemaProvider) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Hover | undefined> {
    const wordRange = document.getWordRangeAtPosition(position, /[\w.]+/);
    if (!wordRange) { return undefined; }

    const word = document.getText(wordRange);

    // Check for table.column pattern
    if (word.includes('.')) {
      const [tablePart, columnPart] = word.split('.');
      return this.getColumnHover(tablePart, columnPart);
    }

    // Check if it's a table name
    const tables = await this.schemaProvider.getTables();
    const table = tables.find(t => t.name.toLowerCase() === word.toLowerCase());
    if (table) {
      return this.getTableHover(table);
    }

    // Check if it's a column name (search all cached tables)
    const allColumns = await this.schemaProvider.getAllColumns();
    for (const [tableName, columns] of allColumns) {
      const col = columns.find(c => c.name.toLowerCase() === word.toLowerCase());
      if (col) {
        return this.getColumnHover(tableName, word);
      }
    }

    return undefined;
  }

  private async getTableHover(table: any): Promise<vscode.Hover> {
    const md = new vscode.MarkdownString();
    md.supportThemeIcons = true;
    md.appendMarkdown(`### $(table) ${table.name}\n\n`);

    if (table.type !== 'table') {
      md.appendMarkdown(`**Type:** ${table.type}\n\n`);
    }
    if (table.engine) {
      md.appendMarkdown(`**Engine:** ${table.engine}\n\n`);
    }
    if (table.rowCount !== undefined) {
      md.appendMarkdown(`**Rows:** ~${table.rowCount.toLocaleString()}\n\n`);
    }
    if (table.dataSize) {
      md.appendMarkdown(`**Size:** ${this.formatBytes(table.dataSize)}\n\n`);
    }
    if (table.comment) {
      md.appendMarkdown(`---\n\n${table.comment}\n\n`);
    }

    // Show columns preview
    const columns = await this.schemaProvider.getColumns(table.name);
    if (columns.length > 0) {
      md.appendMarkdown('---\n\n');
      md.appendMarkdown('| Column | Type | Constraints |\n');
      md.appendMarkdown('|--------|------|-------------|\n');
      for (const col of columns.slice(0, 15)) {
        const constraints = [];
        if (col.isPrimaryKey) { constraints.push('$(key) PK'); }
        if (!col.nullable) { constraints.push('NOT NULL'); }
        if (col.isAutoIncrement) { constraints.push('AUTO_INC'); }
        if (col.isUnique) { constraints.push('UNIQUE'); }
        md.appendMarkdown(`| ${col.name} | \`${col.type}\` | ${constraints.join(', ')} |\n`);
      }
      if (columns.length > 15) {
        md.appendMarkdown(`\n*...and ${columns.length - 15} more columns*\n`);
      }
    }

    return new vscode.Hover(md);
  }

  private async getColumnHover(tableName: string, columnName: string): Promise<vscode.Hover | undefined> {
    const columns = await this.schemaProvider.getColumns(tableName);
    const col = columns.find(c => c.name.toLowerCase() === columnName.toLowerCase());

    if (!col) { return undefined; }

    const md = new vscode.MarkdownString();
    md.supportThemeIcons = true;
    md.appendMarkdown(`### ${tableName}.**${col.name}**\n\n`);
    md.appendMarkdown(`**Type:** \`${col.type}\`\n\n`);

    const constraints = [];
    if (col.isPrimaryKey) { constraints.push('$(key) Primary Key'); }
    if (!col.nullable) { constraints.push('NOT NULL'); }
    if (col.isAutoIncrement) { constraints.push('AUTO_INCREMENT'); }
    if (col.isUnique) { constraints.push('UNIQUE'); }
    if (col.defaultValue !== null && col.defaultValue !== undefined) {
      constraints.push(`DEFAULT: \`${col.defaultValue}\``);
    }

    if (constraints.length > 0) {
      md.appendMarkdown(`**Constraints:** ${constraints.join(' • ')}\n\n`);
    }

    if (col.maxLength) {
      md.appendMarkdown(`**Max Length:** ${col.maxLength}\n\n`);
    }

    if (col.foreignKey) {
      md.appendMarkdown(`**FK →** ${col.foreignKey.table}.${col.foreignKey.column}\n\n`);
    }

    if (col.comment) {
      md.appendMarkdown(`---\n\n${col.comment}\n`);
    }

    return new vscode.Hover(md);
  }

  private formatBytes(bytes: number): string {
    if (bytes >= 1_073_741_824) { return `${(bytes / 1_073_741_824).toFixed(1)} GB`; }
    if (bytes >= 1_048_576) { return `${(bytes / 1_048_576).toFixed(1)} MB`; }
    if (bytes >= 1_024) { return `${(bytes / 1_024).toFixed(1)} KB`; }
    return `${bytes} B`;
  }
}
