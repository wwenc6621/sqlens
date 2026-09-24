import * as vscode from 'vscode';
import { SchemaProvider } from '../../core/schema/SchemaProvider';
import { NormalizedColumnType } from '../../core/types';

/**
 * SQL keywords organized by category for context-aware suggestions.
 */
const SQL_KEYWORDS = {
  dml: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT'],
  clauses: [
    'FROM', 'WHERE', 'JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN',
    'FULL JOIN', 'CROSS JOIN', 'ON', 'AND', 'OR', 'NOT', 'IN', 'EXISTS',
    'BETWEEN', 'LIKE', 'IS NULL', 'IS NOT NULL', 'ORDER BY', 'GROUP BY',
    'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'UNION ALL', 'INTERSECT',
    'EXCEPT', 'AS', 'DISTINCT', 'ALL', 'ANY', 'SOME',
  ],
  functions: [
    'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'NULLIF',
    'IFNULL', 'NVL', 'CAST', 'CONVERT', 'CONCAT', 'SUBSTRING',
    'LENGTH', 'TRIM', 'LTRIM', 'RTRIM', 'UPPER', 'LOWER', 'REPLACE',
    'NOW', 'CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME',
    'DATE_FORMAT', 'DATEDIFF', 'DATE_ADD', 'DATE_SUB',
    'ROUND', 'CEIL', 'FLOOR', 'ABS', 'MOD', 'POWER', 'SQRT',
    'IF', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
    'GROUP_CONCAT', 'STRING_AGG', 'ARRAY_AGG',
    'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'LAG', 'LEAD',
    'FIRST_VALUE', 'LAST_VALUE', 'NTH_VALUE', 'NTILE',
    'OVER', 'PARTITION BY',
  ],
  ddl: [
    'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'TRUNCATE TABLE',
    'CREATE INDEX', 'DROP INDEX', 'CREATE VIEW', 'DROP VIEW',
    'CREATE DATABASE', 'DROP DATABASE', 'CREATE SCHEMA',
    'ADD COLUMN', 'DROP COLUMN', 'MODIFY COLUMN', 'RENAME COLUMN',
    'PRIMARY KEY', 'FOREIGN KEY', 'REFERENCES', 'UNIQUE', 'INDEX',
    'NOT NULL', 'DEFAULT', 'AUTO_INCREMENT', 'SERIAL',
    'CASCADE', 'SET NULL', 'SET DEFAULT', 'RESTRICT', 'NO ACTION',
  ],
  types: [
    'INT', 'INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT',
    'VARCHAR', 'CHAR', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT',
    'DECIMAL', 'NUMERIC', 'FLOAT', 'DOUBLE', 'REAL',
    'DATE', 'TIME', 'DATETIME', 'TIMESTAMP', 'TIMESTAMPTZ',
    'BOOLEAN', 'BOOL', 'BIT',
    'BLOB', 'BINARY', 'VARBINARY', 'BYTEA',
    'JSON', 'JSONB', 'XML',
    'UUID', 'ENUM', 'SET', 'ARRAY',
  ],
  other: [
    'SET', 'INTO', 'VALUES', 'RETURNING', 'WITH', 'RECURSIVE',
    'EXPLAIN', 'ANALYZE', 'VACUUM', 'REINDEX', 'PRAGMA',
    'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE',
    'GRANT', 'REVOKE', 'SHOW', 'DESCRIBE', 'USE',
    'ASC', 'DESC', 'NULLS FIRST', 'NULLS LAST',
    'TRUE', 'FALSE', 'NULL',
  ],
};

/**
 * Detects the SQL context at a given position to provide context-aware completions.
 */
function detectContext(document: vscode.TextDocument, position: vscode.Position): {
  context: 'select' | 'from' | 'where' | 'join' | 'insert' | 'update' | 'set' | 'general';
  tableAlias?: string;
  afterDot: boolean;
  prefix: string;
} {
  const textBefore = document.getText(new vscode.Range(
    new vscode.Position(Math.max(0, position.line - 20), 0),
    position,
  )).toUpperCase();

  const lineText = document.lineAt(position.line).text;
  const charBefore = lineText.substring(0, position.character);

  // Check if we're after a dot (table.column)
  const dotMatch = charBefore.match(/(\w+)\.\s*(\w*)$/);
  const afterDot = !!dotMatch;
  const tableAlias = dotMatch ? dotMatch[1] : undefined;
  const prefix = dotMatch ? (dotMatch[2] || '') : (charBefore.match(/(\w*)$/)?.[1] || '');

  // Find the most recent clause keyword
  const clauses = ['SELECT', 'FROM', 'WHERE', 'JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN',
    'ON', 'INSERT INTO', 'UPDATE', 'SET', 'GROUP BY', 'ORDER BY', 'HAVING'];

  let lastClause = 'general';
  let lastIndex = -1;

  for (const clause of clauses) {
    const idx = textBefore.lastIndexOf(clause);
    if (idx > lastIndex) {
      lastIndex = idx;
      lastClause = clause;
    }
  }

  let context: 'select' | 'from' | 'where' | 'join' | 'insert' | 'update' | 'set' | 'general';

  switch (lastClause) {
    case 'SELECT':
    case 'GROUP BY':
    case 'ORDER BY':
      context = 'select';
      break;
    case 'FROM':
      context = 'from';
      break;
    case 'WHERE':
    case 'ON':
    case 'HAVING':
      context = 'where';
      break;
    case 'JOIN':
    case 'INNER JOIN':
    case 'LEFT JOIN':
    case 'RIGHT JOIN':
      context = 'join';
      break;
    case 'INSERT INTO':
      context = 'insert';
      break;
    case 'UPDATE':
      context = 'update';
      break;
    case 'SET':
      context = 'set';
      break;
    default:
      context = 'general';
  }

  return { context, tableAlias, afterDot, prefix };
}

/**
 * VSCode CompletionItemProvider for SQL files.
 * Provides context-aware suggestions for tables, columns, and SQL keywords.
 */
export class SQLCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private schemaProvider: SchemaProvider) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.CompletionItem[]> {
    const { context, tableAlias, afterDot, prefix } = detectContext(document, position);
    const items: vscode.CompletionItem[] = [];

    // If after a dot (e.g., "users."), suggest columns for that table
    if (afterDot && tableAlias) {
      const resolvedTable = await this.resolveTableName(tableAlias, document);
      if (resolvedTable) {
        const columns = await this.schemaProvider.getColumns(resolvedTable);
        for (const col of columns) {
          items.push(this.createColumnItem(col.name, col, resolvedTable));
        }
      }
      return items;
    }

    // Context-specific suggestions
    switch (context) {
      case 'select':
        // Suggest columns, then functions, then keywords
        await this.addColumnSuggestions(items, 0);
        this.addKeywords(items, SQL_KEYWORDS.functions, vscode.CompletionItemKind.Function, 1);
        await this.addTableSuggestions(items, 2);
        this.addKeywords(items, SQL_KEYWORDS.clauses, vscode.CompletionItemKind.Keyword, 3);
        break;

      case 'from':
      case 'join':
      case 'update':
      case 'insert':
        // Suggest tables first
        await this.addTableSuggestions(items, 0);
        this.addKeywords(items, SQL_KEYWORDS.clauses, vscode.CompletionItemKind.Keyword, 1);
        break;

      case 'where':
      case 'set':
        // Suggest columns first, then operators
        await this.addColumnSuggestions(items, 0);
        this.addKeywords(items, SQL_KEYWORDS.functions, vscode.CompletionItemKind.Function, 1);
        this.addKeywords(items, SQL_KEYWORDS.clauses, vscode.CompletionItemKind.Keyword, 2);
        break;

      default:
        // General: suggest everything
        this.addKeywords(items, SQL_KEYWORDS.dml, vscode.CompletionItemKind.Keyword, 0);
        this.addKeywords(items, SQL_KEYWORDS.ddl, vscode.CompletionItemKind.Keyword, 0);
        await this.addTableSuggestions(items, 1);
        this.addKeywords(items, SQL_KEYWORDS.clauses, vscode.CompletionItemKind.Keyword, 2);
        this.addKeywords(items, SQL_KEYWORDS.functions, vscode.CompletionItemKind.Function, 3);
        this.addKeywords(items, SQL_KEYWORDS.other, vscode.CompletionItemKind.Keyword, 4);
        break;
    }

    return items;
  }

  private async addTableSuggestions(items: vscode.CompletionItem[], sortGroup: number): Promise<void> {
    const tables = await this.schemaProvider.getTables();
    for (const table of tables) {
      const item = new vscode.CompletionItem(table.name, vscode.CompletionItemKind.Class);
      item.detail = table.type === 'view' ? 'View' : 'Table';
      if (table.rowCount !== undefined) {
        item.detail += ` (~${table.rowCount} rows)`;
      }
      if (table.comment) {
        item.documentation = table.comment;
      }
      item.sortText = `${sortGroup}_${table.name}`;
      items.push(item);
    }
  }

  private async addColumnSuggestions(items: vscode.CompletionItem[], sortGroup: number): Promise<void> {
    const allColumns = await this.schemaProvider.getAllColumns();
    const seen = new Set<string>();

    for (const [tableName, columns] of allColumns) {
      for (const col of columns) {
        if (seen.has(col.name)) { continue; }
        seen.add(col.name);
        items.push(this.createColumnItem(col.name, col, tableName, sortGroup));
      }
    }
  }

  private createColumnItem(
    name: string,
    col: any,
    tableName: string,
    sortGroup: number = 0,
  ): vscode.CompletionItem {
    const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Field);

    const parts = [col.type];
    if (col.isPrimaryKey) { parts.push('PK'); }
    if (!col.nullable) { parts.push('NOT NULL'); }
    if (col.isAutoIncrement) { parts.push('AUTO_INC'); }
    item.detail = parts.join(' • ');

    item.documentation = new vscode.MarkdownString(
      `**${tableName}**.**${name}**\n\nType: \`${col.type}\`${col.comment ? `\n\n${col.comment}` : ''}`
    );

    item.sortText = `${sortGroup}_${name}`;
    return item;
  }

  private addKeywords(
    items: vscode.CompletionItem[],
    keywords: string[],
    kind: vscode.CompletionItemKind,
    sortGroup: number,
  ): void {
    const config = vscode.workspace.getConfiguration('sqlens');
    const autoUppercase = config.get<boolean>('autoUppercaseKeywords', false);

    for (const kw of keywords) {
      const label = autoUppercase ? kw : kw.toLowerCase();
      const item = new vscode.CompletionItem(label, kind);
      item.detail = 'SQL';
      item.sortText = `${sortGroup}_${kw}`;

      // Add snippet for functions
      if (kind === vscode.CompletionItemKind.Function && !kw.includes(' ')) {
        item.insertText = new vscode.SnippetString(`${label}($1)$0`);
      }

      items.push(item);
    }
  }

  /**
   * Resolve a table alias to the actual table name.
   * Scans the document for "FROM tableName alias" or "JOIN tableName alias" patterns.
   */
  private async resolveTableName(alias: string, document: vscode.TextDocument): Promise<string | undefined> {
    const text = document.getText().toUpperCase();
    const aliasUpper = alias.toUpperCase();

    // Try direct match (alias is the table name itself)
    const tables = await this.schemaProvider.getTables();
    const directMatch = tables.find(t => t.name.toUpperCase() === aliasUpper);
    if (directMatch) { return directMatch.name; }

    // Search for "FROM/JOIN tableName AS alias" or "FROM/JOIN tableName alias"
    const patterns = [
      new RegExp(`(?:FROM|JOIN)\\s+(\\w+)\\s+(?:AS\\s+)?${aliasUpper}\\b`, 'i'),
    ];

    const fullText = document.getText();
    for (const pattern of patterns) {
      const match = fullText.match(pattern);
      if (match) { return match[1]; }
    }

    return undefined;
  }
}
