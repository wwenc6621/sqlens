import React, { useState, useEffect, useCallback, useRef } from 'react';
import { postMessage as postRaw, onMessage } from '../../hooks/useVsCode';
import Icon from '../../components/Icon';
import { t } from '../../i18n';
import './StructureView.css';

interface DataTypeAutocompleteProps {
  value: string;
  onChange: (val: string) => void;
  driverType: string;
  onBlur?: () => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  autoFocus?: boolean;
  placeholder?: string;
}

const COMMON_TYPES: Record<string, string[]> = {
  mysql: [
    'INT', 'BIGINT', 'BIGINT UNSIGNED', 'VARCHAR(255)', 'TEXT', 'TINYINT', 'TINYINT UNSIGNED', 'SMALLINT', 'MEDIUMINT', 'DECIMAL(10,2)', 'FLOAT', 'DOUBLE',
    'DATE', 'TIME', 'DATETIME', 'TIMESTAMP', 'JSON', 'BLOB', 'CHAR(36)', 'BINARY', 'VARBINARY'
  ],
  postgresql: [
    'integer', 'bigint', 'character varying(255)', 'text', 'boolean', 'smallint', 'numeric(10,2)', 'real', 'double precision',
    'date', 'time without time zone', 'timestamp without time zone', 'jsonb', 'bytea', 'uuid', 'json', 'interval'
  ],
  sqlite: [
    'INTEGER', 'TEXT', 'REAL', 'NUMERIC', 'BLOB', 'INT', 'VARCHAR(255)', 'DATETIME', 'BOOLEAN'
  ]
};

function DataTypeAutocomplete({ value, onChange, driverType, onBlur, onKeyDown, autoFocus, placeholder }: DataTypeAutocompleteProps) {
  const [isOpen, setIsOpen] = useState(false);
  const types = COMMON_TYPES[driverType] || COMMON_TYPES.mysql;
  const filteredTypes = types.filter(t => t.toLowerCase().includes(value.toLowerCase()));

  return (
    <div className="autocomplete-container">
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        onFocus={() => setIsOpen(true)}
        onBlur={() => { setTimeout(() => setIsOpen(false), 200); onBlur?.(); }}
        onKeyDown={onKeyDown}
        autoFocus={autoFocus}
        placeholder={placeholder || 'e.g. VARCHAR(255)'}
      />
      {isOpen && filteredTypes.length > 0 && (
        <ul className="autocomplete-suggestions">
          {filteredTypes.map(t => (
            <li key={t} onMouseDown={() => { onChange(t); onBlur?.(); }}>
              {t}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface ColumnInfo {
  name: string;
  type: string;
  normalizedType: string;
  nullable: boolean;
  defaultValue: unknown;
  isPrimaryKey: boolean;
  isAutoIncrement: boolean;
  comment?: string;
}

interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  type: string;
  comment?: string;
}

interface ForeignKeyInfo {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedSchema?: string;
  referencedColumns: string[];
  onDelete: string;
  onUpdate: string;
}

interface TableInfo {
  name: string;
  schema?: string;
  type: string;
}

interface StructureData {
  tableName: string;
  schemaName?: string;
  tableComment?: string;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  ddl: string;
}

/** Editable draft row shown inline in the Columns table. */
interface DraftColumn {
  key: string;
  isNew: boolean;
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string;
  comment: string;
  isPrimaryKey: boolean;
  orig: ColumnInfo | null;
}

type TabType = 'columns' | 'indexes' | 'foreignKeys' | 'options' | 'ddl';

/** Cell that becomes an <input> on double-click; Enter/blur commits, Esc cancels. */
function EditableCell({ value, placeholder, onCommit, renderEditor, autoEdit }: {
  value: string;
  placeholder?: string;
  onCommit: (next: string) => void;
  renderEditor?: (props: { value: string; onChange: (v: string) => void; onBlur: () => void; onKeyDown: (e: React.KeyboardEvent) => void; autoFocus?: boolean }) => React.ReactNode;
  autoEdit?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const draftRef = useRef(value);
  draftRef.current = draft;

  useEffect(() => {
    if (!editing) { setDraft(value); }
  }, [value, editing]);

  const startEdit = () => { setDraft(value); draftRef.current = value; setEditing(true); };
  const commit = () => {
    setEditing(false);
    if (draftRef.current !== value) { onCommit(draftRef.current); }
  };

  if (editing || autoEdit) {
    const editorProps = {
      value: draft,
      onChange: setDraft,
      onBlur: commit,
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') { commit(); }
        if (e.key === 'Escape') { setDraft(value); setEditing(false); }
      },
    };
    return (
      <span className="edit-cell">
        {renderEditor
          ? renderEditor({ ...editorProps, autoFocus: true })
          : (
            <input
              type="text"
              className="cell-input"
              value={draft}
              placeholder={placeholder}
              autoFocus={autoEdit ? true : undefined}
              onChange={e => editorProps.onChange(e.target.value)}
              onBlur={editorProps.onBlur}
              onKeyDown={editorProps.onKeyDown}
            />
          )}
      </span>
    );
  }

  return (
    <span
      className="edit-cell static"
      onDoubleClick={startEdit}
      title={t('Double-click to edit')}
    >
      {value || <span className="null-text">{placeholder || 'NULL'}</span>}
    </span>
  );
}

const MYSQL_CHARSETS = [
  { label: 'DEFAULT', collations: [] },
  { label: 'utf8mb4', collations: ['utf8mb4_0900_ai_ci', 'utf8mb4_unicode_ci', 'utf8mb4_general_ci'] },
  { label: 'utf8', collations: ['utf8_general_ci', 'utf8_unicode_ci'] },
  { label: 'latin1', collations: ['latin1_swedish_ci', 'latin1_general_ci'] },
];

function sanitizeIdentifierPart(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
}

export default function StructureView({ instanceId = 'default' }: { instanceId?: string }) {
  const post = useCallback((message: any) => postRaw({ ...message, instanceId }), [instanceId]);

  const [data, setData] = useState<StructureData | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>('columns');

  // Inline-editable column draft; rebuilt whenever fresh structure arrives.
  const [draftColumns, setDraftColumns] = useState<DraftColumn[]>([]);
  const [draftTableComment, setDraftTableComment] = useState('');
  const [generatedSQL, setGeneratedSQL] = useState('');

  // Add Index / Add FK forms
  const [newIdxName, setNewIdxName] = useState('');
  const [newIdxCols, setNewIdxCols] = useState<string[]>([]);
  const [newIdxUnique, setNewIdxUnique] = useState(false);
  const [newIdxType, setNewIdxType] = useState('BTREE');

  const [tables, setTables] = useState<TableInfo[]>([]);
  const [editingFk, setEditingFk] = useState<number | null>(null);
  const [fkName, setFkName] = useState('');
  const [fkColumns, setFkColumns] = useState<string[]>([]);
  const [fkRefTable, setFkRefTable] = useState('');
  const [fkRefColumns, setFkRefColumns] = useState('');
  const [fkOnUpdate, setFkOnUpdate] = useState('NO ACTION');
  const [fkOnDelete, setFkOnDelete] = useState('NO ACTION');

  const [driverType, setDriverType] = useState<string>('mysql');
  const [renaming, setRenaming] = useState(false);
  const [newTableName, setNewTableName] = useState('');
  const [renameTo, setRenameTo] = useState<string | null>(null);
  const [tableCharset, setTableCharset] = useState('DEFAULT');
  const [tableCollation, setTableCollation] = useState('');

  useEffect(() => {
    post({ type: 'ready' });
    post({ type: 'getDriverType' });
    post({ type: 'getTableList' });
    const unsub = onMessage((msg: any) => {
      if (msg?.instanceId !== instanceId) { return; }
      if (msg.type === 'structureData') {
        const d: StructureData = msg.data;
        setData(d);
        setDraftColumns(d.columns.map((c, i) => ({
          key: `${c.name}-${i}`,
          isNew: false,
          name: c.name,
          type: c.type,
          nullable: c.nullable,
          defaultValue: c.defaultValue === null || c.defaultValue === undefined ? '' : String(c.defaultValue),
          comment: c.comment || '',
          isPrimaryKey: c.isPrimaryKey,
          orig: c,
        })));
        setDraftTableComment(d.tableComment || '');
        setGeneratedSQL('');
      } else if (msg.type === 'reloadStructure') {
        post({ type: 'ready' });
      } else if (msg.type === 'driverType') {
        setDriverType(msg.data.type);
      } else if (msg.type === 'tableList') {
        setTables(msg.data.tables || []);
      }
    });
    return unsub;
  }, [instanceId, post]);

  const handleApplySQL = useCallback(() => {
    if (!generatedSQL.trim()) return;
    post({ type: 'executeDDL', data: { sql: generatedSQL, renameTo } });
    setRenameTo(null);
  }, [generatedSQL, renameTo]);

  const appendGeneratedSQL = useCallback((sql: string) => {
    const next = sql.trim();
    if (!next) return;
    setGeneratedSQL(prev => {
      const current = prev.trim();
      if (!current || current.startsWith('-- Edit column details')) {
        return next;
      }
      return `${current}\n\n${next}`;
    });
  }, []);

  // Helper to escape identifiers
  const escapeId = (name: string) => {
    if (driverType === 'mysql') {
      return `\`${name.replace(/`/g, '``')}\``;
    }
    return `"${name.replace(/"/g, '""')}"`;
  };

  const getEscapedTable = () => {
    if (!data) return '';
    return data.schemaName ? `${escapeId(data.schemaName)}.${escapeId(data.tableName)}` : escapeId(data.tableName);
  };

  // ── Inline column draft helpers ──

  const updateDraftColumn = (key: string, fields: Partial<DraftColumn>) => {
    setDraftColumns(prev => prev.map(c => (c.key === key ? { ...c, ...fields } : c)));
  };

  /** Toggle the primary-key flag on a draft column. PK columns must be NOT NULL. */
  const handleTogglePK = (key: string, checked: boolean) => {
    setDraftColumns(prev => prev.map(c => (
      c.key === key ? { ...c, isPrimaryKey: checked, nullable: checked ? false : c.nullable } : c
    )));
  };

  const handleAddColumn = () => {
    if (!data) { return; }
    setDraftColumns(prev => ([
      ...prev,
      {
        key: `new-${Date.now()}`,
        isNew: true,
        name: `new_column_${prev.length + 1}`,
        type: driverType === 'postgresql' ? 'character varying(255)' : 'VARCHAR(255)',
        nullable: true,
        defaultValue: '',
        comment: '',
        isPrimaryKey: false,
        orig: null,
      },
    ]));
  };

  const handleMoveDraftColumn = (idx: number, direction: 'up' | 'down') => {
    setDraftColumns(prev => {
      const target = direction === 'up' ? idx - 1 : idx + 1;
      if (target < 0 || target >= prev.length) { return prev; }
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  };

  const handleDropColumn = (draft: DraftColumn) => {
    if (draft.isNew) {
      setDraftColumns(prev => prev.filter(c => c.key !== draft.key));
      return;
    }
    const sql = `ALTER TABLE ${getEscapedTable()} DROP COLUMN ${escapeId(draft.name)};`;
    setDraftColumns(prev => prev.filter(c => c.key !== draft.key));
    appendGeneratedSQL(sql);
  };

  /** MySQL-style single-statement column definition, including comment. */
  const buildMysqlColumnDef = (col: DraftColumn, afterName?: string | null) => {
    const parts = [
      `${escapeId(col.name)} ${col.type}`,
      col.nullable ? 'NULL' : 'NOT NULL',
    ];
    if (col.defaultValue.trim()) { parts.push(`DEFAULT ${col.defaultValue}`); }
    if (col.comment.trim()) { parts.push(`COMMENT '${col.comment.replace(/'/g, "''")}'`); }
    if (afterName) { parts.push(`AFTER ${escapeId(afterName)}`); }
    return parts.join(' ');
  };

  /** Diff the inline draft against the loaded structure; returns SQL or null when unchanged. */
  const buildStructureSQL = (): string | null => {
    if (!data) { return null; }
    const statements: string[] = [];
    const table = getEscapedTable();
    const escapeComment = (text: string) => `'${text.replace(/'/g, "''")}'`;

    draftColumns.forEach((draft, idx) => {
      const afterName = idx > 0 ? draftColumns[idx - 1].name : null;

      if (draft.isNew) {
        if (!draft.name.trim() || !draft.type.trim()) { return; }
        if (driverType === 'mysql') {
          statements.push(`ALTER TABLE ${table} ADD COLUMN ${buildMysqlColumnDef(draft, afterName)};`);
        } else if (driverType === 'sqlite') {
          statements.push(`ALTER TABLE ${table} ADD COLUMN ${escapeId(draft.name)} ${draft.type}${draft.nullable ? '' : ' NOT NULL'}${draft.defaultValue.trim() ? ` DEFAULT ${draft.defaultValue}` : ''};`);
        } else {
          statements.push(`ALTER TABLE ${table} ADD COLUMN ${escapeId(draft.name)} ${draft.type}${draft.nullable ? '' : ' NOT NULL'}${draft.defaultValue.trim() ? ` DEFAULT ${draft.defaultValue}` : ''};`);
          if (draft.comment.trim()) {
            statements.push(`COMMENT ON COLUMN ${table}.${escapeId(draft.name)} IS ${escapeComment(draft.comment)};`);
          }
          if (afterName) {
            statements.push(`-- PostgreSQL/SQLite do not support column ordering: "${draft.name}" was requested after "${afterName}".`);
          }
        }
        return;
      }

      const orig = draft.orig!;
      const origDefault = orig.defaultValue === null || orig.defaultValue === undefined ? '' : String(orig.defaultValue);
      const nameChanged = orig.name !== draft.name;
      const typeChanged = orig.type !== draft.type;
      const nullabilityChanged = orig.nullable !== draft.nullable;
      const defaultChanged = origDefault !== draft.defaultValue;
      const commentChanged = (orig.comment || '') !== draft.comment;
      const defChanged = typeChanged || nullabilityChanged || defaultChanged || commentChanged;

      if (!nameChanged && !defChanged) { return; }

      if (driverType === 'mysql') {
        // CHANGE/MODIFY carries the full definition (incl. comment) and AFTER position.
        if (nameChanged) {
          statements.push(`ALTER TABLE ${table} CHANGE COLUMN ${escapeId(orig.name)} ${buildMysqlColumnDef(draft, afterName)};`);
        } else if (defChanged) {
          statements.push(`ALTER TABLE ${table} MODIFY COLUMN ${buildMysqlColumnDef(draft, afterName)};`);
        }
      } else if (driverType === 'sqlite') {
        if (nameChanged) {
          statements.push(`ALTER TABLE ${table} RENAME COLUMN ${escapeId(orig.name)} TO ${escapeId(draft.name)};`);
        }
        if (defChanged) {
          statements.push(`-- SQLite cannot alter column definition for ${escapeId(draft.name)}. Rebuild the table to apply type/null/default/comment changes.`);
        }
      } else {
        if (nameChanged) {
          statements.push(`ALTER TABLE ${table} RENAME COLUMN ${escapeId(orig.name)} TO ${escapeId(draft.name)};`);
        }
        if (typeChanged) {
          statements.push(`ALTER TABLE ${table} ALTER COLUMN ${escapeId(draft.name)} TYPE ${draft.type};`);
        }
        if (nullabilityChanged) {
          statements.push(`ALTER TABLE ${table} ALTER COLUMN ${escapeId(draft.name)} ${draft.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'};`);
        }
        if (defaultChanged) {
          statements.push(draft.defaultValue.trim()
            ? `ALTER TABLE ${table} ALTER COLUMN ${escapeId(draft.name)} SET DEFAULT ${draft.defaultValue};`
            : `ALTER TABLE ${table} ALTER COLUMN ${escapeId(draft.name)} DROP DEFAULT;`);
        }
        if (commentChanged) {
          statements.push(`COMMENT ON COLUMN ${table}.${escapeId(draft.name)} IS ${escapeComment(draft.comment)};`);
        }
        if (defChanged && afterName) {
          statements.push(`-- PostgreSQL does not support column ordering: "${draft.name}" was requested after "${afterName}".`);
        }
      }
    });

    // ── Primary key changes ──
    // Compare the loaded PK columns against the draft selection (using the
    // latest draft names, so renaming a PK column is handled by the same
    // DROP/ADD cycle).
    const origPk = data.columns.filter(c => c.isPrimaryKey).map(c => c.name);
    const draftPk = draftColumns
      .filter(c => c.isPrimaryKey && c.name.trim())
      .map(c => c.name);
    const pkChanged = JSON.stringify(origPk) !== JSON.stringify(draftPk);
    if (pkChanged) {
      if (driverType === 'mysql') {
        if (origPk.length > 0 && draftPk.length === 0) {
          statements.push(`ALTER TABLE ${table} DROP PRIMARY KEY;`);
        } else if (origPk.length > 0) {
          statements.push(`ALTER TABLE ${table} DROP PRIMARY KEY, ADD PRIMARY KEY (${draftPk.map(escapeId).join(', ')});`);
        } else if (draftPk.length > 0) {
          statements.push(`ALTER TABLE ${table} ADD PRIMARY KEY (${draftPk.map(escapeId).join(', ')});`);
        }
      } else if (driverType === 'postgresql') {
        // PostgreSQL primary keys are constraints, conventionally <table>_pkey.
        if (origPk.length > 0) {
          statements.push(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${escapeId(`${data.tableName}_pkey`)};`);
        }
        if (draftPk.length > 0) {
          statements.push(`ALTER TABLE ${table} ADD PRIMARY KEY (${draftPk.map(escapeId).join(', ')});`);
        }
      } else {
        statements.push(`-- SQLite cannot change the primary key with ALTER TABLE. Rebuild the table to apply primary key changes.`);
      }
    }

    // Table comment
    const origTableComment = data.tableComment || '';
    if (draftTableComment !== origTableComment) {
      if (driverType === 'mysql') {
        statements.push(`ALTER TABLE ${table} COMMENT = ${escapeComment(draftTableComment)};`);
      } else if (driverType === 'postgresql') {
        statements.push(`COMMENT ON TABLE ${table} IS ${escapeComment(draftTableComment)};`);
      } else {
        statements.push('-- SQLite does not support table comments.');
      }
    }

    if (statements.length === 0) { return null; }
    return statements.join('\n');
  };

  const generateStructureSQL = () => {
    const sql = buildStructureSQL();
    if (!sql) {
      alert('No changes detected.');
      return;
    }
    setGeneratedSQL(sql);
  };

  const executeStructureSQL = () => {
    const sql = buildStructureSQL();
    if (!sql) {
      alert('No changes detected.');
      return;
    }
    setGeneratedSQL(sql);
    post({ type: 'executeDDL', data: { sql, renameTo: null } });
  };

  // Index Actions
  const handleAddIndex = () => {
    if (!data || !newIdxName || newIdxCols.length === 0) return;
    const typePart = newIdxType && newIdxType !== 'BTREE' ? ` USING ${newIdxType}` : '';
    const sql = `CREATE ${newIdxUnique ? 'UNIQUE ' : ''}INDEX ${escapeId(newIdxName)} ON ${getEscapedTable()}${typePart} (${newIdxCols.map(escapeId).join(', ')});`;
    appendGeneratedSQL(sql);
  };

  const handleDropIndex = (idxName: string) => {
    // Standard SQL (supports PostgreSQL/SQLite). MySQL uses: DROP INDEX name ON table
    const sql = driverType === 'mysql'
      ? `DROP INDEX ${escapeId(idxName)} ON ${getEscapedTable()};`
      : `DROP INDEX ${escapeId(idxName)};`;
    appendGeneratedSQL(sql);
  };

  const resetFkForm = () => {
    setEditingFk(null);
    setFkName('');
    setFkColumns([]);
    setFkRefTable('');
    setFkRefColumns('');
    setFkOnUpdate('NO ACTION');
    setFkOnDelete('NO ACTION');
  };

  const handleAddFk = () => {
    resetFkForm();
    setEditingFk(-1);
  };

  const handleEditFk = (idx: number) => {
    const fk = data?.foreignKeys[idx];
    if (!fk) return;
    setEditingFk(idx);
    setFkName(fk.name);
    setFkColumns(fk.columns);
    setFkRefTable(fk.referencedSchema ? `${fk.referencedSchema}.${fk.referencedTable}` : fk.referencedTable);
    setFkRefColumns(fk.referencedColumns.join(', '));
    setFkOnUpdate(fk.onUpdate || 'NO ACTION');
    setFkOnDelete(fk.onDelete || 'NO ACTION');
  };

  const generateDropFkSQL = (fk: ForeignKeyInfo) => {
    if (driverType === 'mysql') {
      return `ALTER TABLE ${getEscapedTable()} DROP FOREIGN KEY ${escapeId(fk.name)};`;
    }
    return `ALTER TABLE ${getEscapedTable()} DROP CONSTRAINT ${escapeId(fk.name)};`;
  };

  const generateForeignKeyName = () => {
    if (!data) return 'fk_table_col_ref_id';
    const localTable = sanitizeIdentifierPart(data.tableName || 'table') || 'table';
    const localCols = fkColumns.map(sanitizeIdentifierPart).filter(Boolean).join('_') || 'col';
    const refTable = sanitizeIdentifierPart(fkRefTable.split('.').pop() || 'ref') || 'ref';
    const refCols = fkRefColumns.split(',').map(sanitizeIdentifierPart).filter(Boolean).join('_') || 'id';
    return `fk_${localTable}_${localCols}_${refTable}_${refCols}`.slice(0, 64);
  };

  const generateFkAlter = () => {
    if (!data || editingFk === null || fkColumns.length === 0 || !fkRefTable || !fkRefColumns.trim()) return;
    const constraintName = fkName.trim() || generateForeignKeyName();
    const refParts = fkRefTable.split('.').map(part => part.trim()).filter(Boolean);
    const refIdentifier = refParts.length === 2
      ? `${escapeId(refParts[0])}.${escapeId(refParts[1])}`
      : escapeId(refParts[0] || fkRefTable);
    const refCols = fkRefColumns.split(',').map(col => col.trim()).filter(Boolean);
    const addSql = `ALTER TABLE ${getEscapedTable()} ADD CONSTRAINT ${escapeId(constraintName)} FOREIGN KEY (${fkColumns.map(escapeId).join(', ')}) REFERENCES ${refIdentifier} (${refCols.map(escapeId).join(', ')}) ON UPDATE ${fkOnUpdate} ON DELETE ${fkOnDelete};`;

    if (editingFk >= 0 && data.foreignKeys[editingFk]) {
      appendGeneratedSQL(`${generateDropFkSQL(data.foreignKeys[editingFk])}\n${addSql}`);
    } else {
      appendGeneratedSQL(addSql);
    }
  };

  const generateCharsetAlter = () => {
    if (!data || driverType !== 'mysql' || tableCharset === 'DEFAULT') return;
    const collationSql = tableCollation ? ` COLLATE ${tableCollation}` : '';
    appendGeneratedSQL(`ALTER TABLE ${getEscapedTable()} DEFAULT CHARACTER SET ${tableCharset}${collationSql};`);
  };

  if (!data) {
    return (
      <div className="structure-loading">
        <div className="spinner"></div>
        <h3>{t('Loading structure...')}</h3>
      </div>
    );
  }

  return (
    <div className="structure-view">
      {/* Header */}
      <header className="structure-header">
        <div className="title-area">
          <span className="icon"><Icon name="wrench" size={18} /></span>
          <div className="info">
            <h2>{data.tableName}</h2>
            <span className="sub-info">
              {data.schemaName ? `Schema: ${data.schemaName}` : 'Default Schema'}
              {driverType === 'sqlite' ? '' : (
                <input
                  type="text"
                  className="table-comment-input"
                  placeholder="Table comment — click to edit"
                  value={draftTableComment}
                  onChange={e => setDraftTableComment(e.target.value)}
                  title={driverType === 'mysql' || driverType === 'postgresql' ? 'Edit the table comment, apply with Generate SQL' : 'Table comments are not supported for SQLite'}
                  disabled={driverType === 'sqlite'}
                />
              )}
            </span>
          </div>
        </div>
        <div className="structure-header-actions">
          <button className="btn-secondary rename-btn" onClick={() => { setNewTableName(data.tableName); setRenaming(true); }}><Icon name="pencil" size={13} /> {t('Rename Table')} </button>
          <button className="btn-secondary" onClick={generateStructureSQL}><Icon name="terminal" size={13} /> {t('Generate SQL')} </button>
          <button className="btn-primary" onClick={executeStructureSQL}><Icon name="play" size={13} /> {t('Execute')} </button>
        </div>
      </header>

      {/* Tabs */}
      <nav className="structure-tabs">
        <button className={activeTab === 'columns' ? 'active' : ''} onClick={() => setActiveTab('columns')}>{t('Columns')} ({data.columns.length})</button>
        <button className={activeTab === 'indexes' ? 'active' : ''} onClick={() => setActiveTab('indexes')}>{t('Indexes')} ({data.indexes.length})</button>
        <button className={activeTab === 'foreignKeys' ? 'active' : ''} onClick={() => setActiveTab('foreignKeys')}>{t('Foreign Keys')} ({data.foreignKeys.length})</button>
        <button className={activeTab === 'options' ? 'active' : ''} onClick={() => setActiveTab('options')}>{t('Options')}</button>
        <button className={activeTab === 'ddl' ? 'active' : ''} onClick={() => setActiveTab('ddl')}>DDL</button>
      </nav>

      {/* Tab Contents */}
      <div className="structure-content">
        {activeTab === 'columns' && (
          <div className="columns-tab">
            <p className="description">{t('Double-click Name / Type / Default / Comment to edit inline. Nullable toggles directly. Apply changes with Generate SQL / Execute above.')}</p>
            <div className="table-wrapper">
              <table className="structure-table">
                <thead>
                  <tr>
                    <th style={{ width: '44px' }}>{t('PK')}</th>
                    <th>{t('Name')}</th>
                    <th style={{ width: '220px' }}>{t('Type')}</th>
                    <th style={{ width: '80px' }}>{t('Nullable')}</th>
                    <th>{t('Default')}</th>
                    <th>{t('Comment')}</th>
                    <th style={{ width: '130px' }}>{t('Actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {draftColumns.map((draft, idx) => (
                    <tr key={draft.key} className={draft.isPrimaryKey ? 'pk-row' : (draft.isNew ? 'new-row' : '')}>
                      <td>
                        <input
                          type="checkbox"
                          checked={draft.isPrimaryKey}
                          onChange={e => handleTogglePK(draft.key, e.target.checked)}
                          title={t('Primary Key')}
                        />
                      </td>
                      <td className="bold">
                        <EditableCell
                          value={draft.name}
                          autoEdit={draft.isNew && !draft.name}
                          placeholder="column_name"
                          onCommit={v => updateDraftColumn(draft.key, { name: v })}
                        />
                      </td>
                      <td>
                        <EditableCell
                          value={draft.type}
                          placeholder="type"
                          onCommit={v => updateDraftColumn(draft.key, { type: v })}
                          renderEditor={({ value: v, onChange, onBlur, onKeyDown, autoFocus: fa }) => (
                            <DataTypeAutocomplete
                              value={v}
                              onChange={onChange}
                              onBlur={onBlur}
                              onKeyDown={onKeyDown}
                              autoFocus={fa}
                              driverType={driverType}
                            />
                          )}
                        />
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          checked={draft.nullable}
                          disabled={draft.isPrimaryKey}
                          onChange={e => updateDraftColumn(draft.key, { nullable: e.target.checked })}
                          title={draft.isPrimaryKey ? t('Primary key columns are not nullable') : t('Toggle nullable')}
                        />
                      </td>
                      <td>
                        <EditableCell
                          value={draft.defaultValue}
                          placeholder={t('NULL')}
                          onCommit={v => updateDraftColumn(draft.key, { defaultValue: v })}
                        />
                      </td>
                      <td className="comment-cell">
                        <EditableCell
                          value={draft.comment}
                          placeholder="—"
                          onCommit={v => updateDraftColumn(draft.key, { comment: v })}
                        />
                      </td>
                      <td>
                        <button className="btn-icon" onClick={() => handleMoveDraftColumn(idx, 'up')} disabled={idx === 0} title={t('Move up')}><Icon name="chevronUp" size={13} /></button>
                        <button className="btn-icon" onClick={() => handleMoveDraftColumn(idx, 'down')} disabled={idx === draftColumns.length - 1} title={t('Move down')}><Icon name="chevronDown" size={13} /></button>
                        <button className="btn-icon btn-danger" onClick={() => handleDropColumn(draft)} title={draft.isNew ? 'Remove row' : 'Drop column'}><Icon name="close" size={13} /></button>
                      </td>
                    </tr>
                  ))}
                  {draftColumns.length === 0 && (
                    <tr><td colSpan={7} style={{ textAlign: 'center', opacity: 0.5, padding: 20 }}>{t('No columns.')}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <button className="btn-primary add-col-btn" onClick={handleAddColumn}><Icon name="plus" size={14} /> {t('Add Column')} </button>
          </div>
        )}

        {activeTab === 'indexes' && (
          <div className="indexes-tab">
            <div className="table-wrapper">
              <table className="structure-table">
                <thead>
                  <tr>
                    <th>{t('Index Name')}</th>
                    <th>{t('Columns')}</th>
                    <th>{t('Unique')}</th>
                    <th>{t('Type')}</th>
                    <th>{t('Comment')}</th>
                    <th>{t('Actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.indexes.map((idx, index) => (
                    <tr key={index}>
                      <td className="bold">{idx.name}</td>
                      <td>{idx.columns.join(', ')}</td>
                      <td>{idx.unique ? <Icon name="check" size={13} /> : <Icon name="close" size={13} />}</td>
                      <td><span className="type-badge">{idx.type}</span></td>
                      <td>{idx.comment || ''}</td>
                      <td>
                        <button className="btn-icon btn-danger" onClick={() => handleDropIndex(idx.name)}><Icon name="close" size={13} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Visual Add Index Form */}
            <div className="visual-form">
              <h3><Icon name="plus" size={14} /> {t('Add Index')} </h3>
              <div className="form-row">
                <input type="text" placeholder={t('Index name')} value={newIdxName} onChange={e => setNewIdxName(e.target.value)} />
                <select value={newIdxType} onChange={e => setNewIdxType(e.target.value)}>
                  <option value="BTREE">BTREE</option>
                  <option value="HASH">HASH</option>
                  <option value="GIN">GIN</option>
                  <option value="GIST">GIST</option>
                </select>
                <label className="checkbox-label">
                  <input type="checkbox" checked={newIdxUnique} onChange={e => setNewIdxUnique(e.target.checked)} /> {t('Unique')} </label>
              </div>
              <div className="form-columns-list">
                <h4>Index Columns:</h4>
                {data.columns.map(c => (
                  <label key={c.name} className="checkbox-label">
                    <input type="checkbox" checked={newIdxCols.includes(c.name)}
                      onChange={e => {
                        if (e.target.checked) setNewIdxCols(prev => [...prev, c.name]);
                        else setNewIdxCols(prev => prev.filter(x => x !== c.name));
                      }} />
                    {c.name}
                  </label>
                ))}
              </div>
              <button className="btn-primary" onClick={handleAddIndex} disabled={!newIdxName || newIdxCols.length === 0}>{t('Generate CREATE INDEX DDL')}</button>
            </div>
          </div>
        )}

        {activeTab === 'foreignKeys' && (
          <div className="fks-tab">
            <div className="table-wrapper">
              <table className="structure-table">
                <thead>
                  <tr>
                    <th>{t('Constraint Name')}</th>
                    <th>{t('Columns')}</th>
                    <th>{t('Referenced Table')}</th>
                    <th>{t('Referenced Columns')}</th>
                    <th>{t('On Update')}</th>
                    <th>{t('On Delete')}</th>
                    <th>{t('Actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.foreignKeys.map((fk, idx) => (
                    <tr key={idx}>
                      <td className="bold">{fk.name}</td>
                      <td>{fk.columns.join(', ')}</td>
                      <td>{fk.referencedSchema ? `${fk.referencedSchema}.${fk.referencedTable}` : fk.referencedTable}</td>
                      <td>{fk.referencedColumns.join(', ')}</td>
                      <td><span className="type-badge">{fk.onUpdate}</span></td>
                      <td><span className="type-badge">{fk.onDelete}</span></td>
                      <td>
                        <button className="btn-icon" onClick={() => handleEditFk(idx)} title={t('Edit foreign key')}><Icon name="pencil" size={13} /></button>
                        <button className="btn-icon btn-danger" onClick={() => appendGeneratedSQL(generateDropFkSQL(fk))} title={t('Drop foreign key')}><Icon name="close" size={13} /></button>
                      </td>
                    </tr>
                  ))}
                  {data.foreignKeys.length === 0 && (
                    <tr>
                      <td colSpan={7} style={{ textAlign: 'center', opacity: 0.5, padding: 20 }}>{t('No foreign keys defined.')}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <button className="btn-primary add-col-btn" onClick={handleAddFk}><Icon name="plus" size={14} /> {t('Add Foreign Key')} </button>
          </div>
        )}

        {activeTab === 'options' && (
          <div className="options-tab">
            {driverType === 'mysql' ? (
              <div className="visual-form">
                <h3>{t('Table Charset')}</h3>
                <div className="form-row">
                  <div className="form-group">
                    <label>{t('Character Set')}</label>
                    <select value={tableCharset} onChange={e => {
                      setTableCharset(e.target.value);
                      setTableCollation('');
                    }}>
                      {MYSQL_CHARSETS.map(charset => (
                        <option key={charset.label} value={charset.label}>{charset.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label>{t('Collation')}</label>
                    <select value={tableCollation} onChange={e => setTableCollation(e.target.value)} disabled={tableCharset === 'DEFAULT'}>
                      <option value="">DEFAULT</option>
                      {(MYSQL_CHARSETS.find(charset => charset.label === tableCharset)?.collations || []).map(collation => (
                        <option key={collation} value={collation}>{collation}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <button className="btn-primary" onClick={generateCharsetAlter} disabled={tableCharset === 'DEFAULT'}>{t('Generate Charset SQL')}</button>
              </div>
            ) : (
              <div className="visual-form">
                <h3>{t('Table Options')}</h3>
                <p className="description">Changing table charset is only supported for MySQL/MariaDB tables.</p>
              </div>
            )}
          </div>
        )}

        {activeTab === 'ddl' && (
          <div className="ddl-tab">
            <div className="ddl-header">
              <h3>{t('CREATE TABLE DDL')}</h3>
              <button className="btn-secondary" onClick={() => { navigator.clipboard.writeText(data.ddl); alert('DDL Copied!'); }}><Icon name="copy" size={13} /> {t('Copy DDL')} </button>
            </div>
            <pre className="ddl-code">
              <code>{data.ddl}</code>
            </pre>
          </div>
        )}
      </div>

      {/* Foreign Key Editor */}
      {editingFk !== null && (
        <div className="alter-overlay">
          <div className="alter-modal">
            <h3>{editingFk === -1 ? 'Add Foreign Key' : 'Edit Foreign Key'}</h3>
            <div className="form-group">
              <label>{t('Constraint Name')}</label>
              <input type="text" value={fkName} onChange={e => setFkName(e.target.value)} placeholder={t('Leave blank to auto-generate')} />
            </div>
            <div className="form-columns-list">
              <h4>Local Columns:</h4>
              {data.columns.map(c => (
                <label key={c.name} className="checkbox-label">
                  <input type="checkbox" checked={fkColumns.includes(c.name)}
                    onChange={e => {
                      if (e.target.checked) setFkColumns(prev => [...prev, c.name]);
                      else setFkColumns(prev => prev.filter(x => x !== c.name));
                    }} />
                  {c.name}
                </label>
              ))}
            </div>
            <div className="form-group">
              <label>{t('Referenced Table')}</label>
              <input list="structure-reference-tables" type="text" value={fkRefTable} onChange={e => setFkRefTable(e.target.value)} placeholder="schema.table or table" />
              <datalist id="structure-reference-tables">
                {tables.filter(t => t.type === 'table').map(t => (
                  <option key={`${t.schema || ''}.${t.name}`} value={t.schema ? `${t.schema}.${t.name}` : t.name} />
                ))}
              </datalist>
            </div>
            <div className="form-group">
              <label>{t('Referenced Columns')}</label>
              <input type="text" value={fkRefColumns} onChange={e => setFkRefColumns(e.target.value)} placeholder="id, other_id" />
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>{t('On Update')}</label>
                <select value={fkOnUpdate} onChange={e => setFkOnUpdate(e.target.value)}>
                  <option value="NO ACTION">NO ACTION</option>
                  <option value="CASCADE">CASCADE</option>
                  <option value="RESTRICT">RESTRICT</option>
                  <option value="SET NULL">SET NULL</option>
                  <option value="SET DEFAULT">SET DEFAULT</option>
                </select>
              </div>
              <div className="form-group">
                <label>{t('On Delete')}</label>
                <select value={fkOnDelete} onChange={e => setFkOnDelete(e.target.value)}>
                  <option value="NO ACTION">NO ACTION</option>
                  <option value="CASCADE">CASCADE</option>
                  <option value="RESTRICT">RESTRICT</option>
                  <option value="SET NULL">SET NULL</option>
                  <option value="SET DEFAULT">SET DEFAULT</option>
                </select>
              </div>
            </div>
            <div className="actions">
              <button className="btn-secondary" onClick={resetFkForm}>{t('Cancel')}</button>
              <button className="btn-primary" onClick={generateFkAlter} disabled={fkColumns.length === 0 || !fkRefTable || !fkRefColumns.trim()}>{t('Generate Foreign Key SQL')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Generated SQL preview and executor */}
      {generatedSQL && (
        <div className="sql-preview-panel">
          <div className="preview-header">
            <h4>{t('Generated ALTER TABLE DDL Preview')}</h4>
            <button className="close-btn" onClick={() => setGeneratedSQL('')}><Icon name="close" size={13} /></button>
          </div>
          <p className="description">Review the generated statements. You can edit them before applying.</p>
          <textarea className="sql-textarea" value={generatedSQL} onChange={e => setGeneratedSQL(e.target.value)} rows={6} />
          <div className="preview-actions">
            <button className="btn-secondary" onClick={() => setGeneratedSQL('')}>{t('Discard')}</button>
            <button className="btn-primary btn-save" onClick={handleApplySQL}><Icon name="play" size={13} /> {t('Execute ALTER SQL')} </button>
          </div>
        </div>
      )}

      {/* Rename Table Modal */}
      {renaming && (
        <div className="alter-overlay">
          <div className="alter-modal">
            <h3>{t('Rename Table')}</h3>
            <div className="form-group">
              <label>{t('New Table Name')}</label>
              <input type="text" value={newTableName} onChange={e => setNewTableName(e.target.value)} />
            </div>
            <div className="actions">
              <button className="btn-secondary" onClick={() => setRenaming(false)}>{t('Cancel')}</button>
              <button className="btn-primary" onClick={() => {
                if (newTableName && newTableName !== data?.tableName) {
                  setRenameTo(newTableName);
                  const sql = `ALTER TABLE ${getEscapedTable()} RENAME TO ${escapeId(newTableName)};`;
                  appendGeneratedSQL(sql);
                }
                setRenaming(false);
              }} disabled={!newTableName || newTableName === data?.tableName}>{t('Generate Rename SQL')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
