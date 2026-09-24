import React, { useState, useEffect, useCallback } from 'react';
import { postMessage as postRaw, onMessage } from '../../hooks/useVsCode';
import Icon from '../../components/Icon';
import { t } from '../../i18n';
import './CreateTable.css';

interface ColumnField {
  name: string;
  type: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  isAutoIncrement: boolean;
  defaultValue: string;
  comment: string;
}

interface IndexField {
  name: string;
  columns: string[];
  unique: boolean;
}

interface ForeignKeyField {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string;
  onUpdate: string;
  onDelete: string;
}

interface TableInfo {
  name: string;
  schema?: string;
  type: string;
}

interface DataTypeAutocompleteProps {
  value: string;
  onChange: (val: string) => void;
  driverType: string;
}

const COMMON_TYPES: Record<string, string[]> = {
  mysql: [
    'INT', 'BIGINT', 'VARCHAR(255)', 'TEXT', 'TINYINT', 'SMALLINT', 'MEDIUMINT', 'DECIMAL(10,2)', 'FLOAT', 'DOUBLE',
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

const MYSQL_CHARSETS = [
  { label: 'DEFAULT', collations: [] },
  { label: 'utf8mb4', collations: ['utf8mb4_0900_ai_ci', 'utf8mb4_unicode_ci', 'utf8mb4_general_ci'] },
  { label: 'utf8', collations: ['utf8_general_ci', 'utf8_unicode_ci'] },
  { label: 'latin1', collations: ['latin1_swedish_ci', 'latin1_general_ci'] },
];

function sanitizeIdentifierPart(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
}

function DataTypeAutocomplete({ value, onChange, driverType }: DataTypeAutocompleteProps) {
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
        onBlur={() => setTimeout(() => setIsOpen(false), 200)}
        placeholder={t('Type...')}
        className="cell-input"
      />
      {isOpen && filteredTypes.length > 0 && (
        <ul className="autocomplete-suggestions">
          {filteredTypes.map(t => (
            <li key={t} onMouseDown={() => onChange(t)}>
              {t}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function CreateTable({ instanceId = 'default' }: { instanceId?: string }) {
  const post = useCallback((message: any) => postRaw({ ...message, instanceId }), [instanceId]);

  const [driverType, setDriverType] = useState<string>('mysql');
  const [tableName, setTableName] = useState('');
  const [schemaName, setSchemaName] = useState('');
  const [tableComment, setTableComment] = useState('');
  const [columns, setColumns] = useState<ColumnField[]>([
    { name: 'id', type: 'INT', nullable: false, isPrimaryKey: true, isAutoIncrement: true, defaultValue: '', comment: '' }
  ]);
  const [indexes, setIndexes] = useState<IndexField[]>([]);
  const [foreignKeys, setForeignKeys] = useState<ForeignKeyField[]>([]);
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [tableCharset, setTableCharset] = useState('DEFAULT');
  const [tableCollation, setTableCollation] = useState('');
  const [generatedSQL, setGeneratedSQL] = useState('');

  useEffect(() => {
    post({ type: 'ready' });
    post({ type: 'getDriverType' });
    post({ type: 'getTableList' });

    const unsub = onMessage((msg: any) => {
      if (msg?.instanceId !== instanceId) { return; }
      if (msg.type === 'driverType') {
        setDriverType(msg.data.type);
        if (msg.data.type === 'postgresql') {
          setColumns([
            { name: 'id', type: 'integer', nullable: false, isPrimaryKey: true, isAutoIncrement: true, defaultValue: '', comment: '' }
          ]);
        } else if (msg.data.type === 'sqlite') {
          setColumns([
            { name: 'id', type: 'INTEGER', nullable: false, isPrimaryKey: true, isAutoIncrement: true, defaultValue: '', comment: '' }
          ]);
        }
      } else if (msg.type === 'tableList') {
        setTables(msg.data.tables || []);
      }
    });
    return unsub;
  }, [instanceId, post]);

  const handleAddColumn = () => {
    const isPg = driverType === 'postgresql';
    const isLite = driverType === 'sqlite';
    const defaultType = isPg ? 'character varying(255)' : (isLite ? 'TEXT' : 'VARCHAR(255)');

    setColumns(prev => [
      ...prev,
      { name: `col_${prev.length + 1}`, type: defaultType, nullable: true, isPrimaryKey: false, isAutoIncrement: false, defaultValue: '', comment: '' }
    ]);
  };

  const handleRemoveColumn = (idx: number) => {
    setColumns(prev => prev.filter((_, i) => i !== idx));
  };

  const handleUpdateColumn = (idx: number, fields: Partial<ColumnField>) => {
    setColumns(prev => prev.map((col, i) => i === idx ? { ...col, ...fields } : col));
  };

  const handleMoveColumn = (idx: number, direction: 'up' | 'down') => {
    if (direction === 'up' && idx === 0) return;
    if (direction === 'down' && idx === columns.length - 1) return;
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;

    setColumns(prev => {
      const newCols = [...prev];
      const temp = newCols[idx];
      newCols[idx] = newCols[targetIdx];
      newCols[targetIdx] = temp;
      return newCols;
    });
  };

  const handleAddIndex = () => {
    setIndexes(prev => [
      ...prev,
      { name: `idx_${tableName || 'table'}_${prev.length + 1}`, columns: [], unique: false }
    ]);
  };

  const handleUpdateIndex = (idx: number, fields: Partial<IndexField>) => {
    setIndexes(prev => prev.map((index, i) => i === idx ? { ...index, ...fields } : index));
  };

  const handleRemoveIndex = (idx: number) => {
    setIndexes(prev => prev.filter((_, i) => i !== idx));
  };

  const handleAddForeignKey = () => {
    setForeignKeys(prev => [
      ...prev,
      {
        name: '',
        columns: [],
        referencedTable: '',
        referencedColumns: 'id',
        onUpdate: 'NO ACTION',
        onDelete: 'NO ACTION',
      }
    ]);
  };

  const handleUpdateForeignKey = (idx: number, fields: Partial<ForeignKeyField>) => {
    setForeignKeys(prev => prev.map((fk, i) => i === idx ? { ...fk, ...fields } : fk));
  };

  const handleRemoveForeignKey = (idx: number) => {
    setForeignKeys(prev => prev.filter((_, i) => i !== idx));
  };

  const escapeId = (name: string) => {
    if (driverType === 'mysql') {
      return `\`${name.replace(/`/g, '``')}\``;
    }
    return `"${name.replace(/"/g, '""')}"`;
  };

  const generateForeignKeyName = (fk: ForeignKeyField) => {
    const localTable = sanitizeIdentifierPart(tableName || 'table') || 'table';
    const localCols = fk.columns.map(sanitizeIdentifierPart).filter(Boolean).join('_') || 'col';
    const refTable = sanitizeIdentifierPart(fk.referencedTable.split('.').pop() || 'ref') || 'ref';
    const refCols = fk.referencedColumns.split(',').map(sanitizeIdentifierPart).filter(Boolean).join('_') || 'id';
    return `fk_${localTable}_${localCols}_${refTable}_${refCols}`.slice(0, 64);
  };

  const generateSQL = () => {
    if (!tableName.trim()) {
      alert(t('Please enter a table name'));
      return;
    }

    const escapeComment = (text: string) => `'${text.replace(/'/g, "''")}'`;
    const commentStatements: string[] = [];

    const colDefinitions = columns.map(col => {
      let def = `${escapeId(col.name)} ${col.type}`;

      if (col.isPrimaryKey && col.isAutoIncrement) {
        if (driverType === 'sqlite') {
          return `${escapeId(col.name)} INTEGER PRIMARY KEY AUTOINCREMENT`;
        }
        if (driverType === 'mysql') {
          def += ' NOT NULL AUTO_INCREMENT';
        }
        if (driverType === 'postgresql') {
          if (col.type.toLowerCase() === 'integer') {
            def = `${escapeId(col.name)} SERIAL`;
          } else if (col.type.toLowerCase() === 'bigint') {
            def = `${escapeId(col.name)} BIGSERIAL`;
          } else if (col.type.toLowerCase() === 'smallint') {
            def = `${escapeId(col.name)} SMALLSERIAL`;
          }
        }
      }

      if (!col.isPrimaryKey || driverType !== 'sqlite') {
        if (!col.nullable) {
          def += ' NOT NULL';
        } else {
          def += ' NULL';
        }
      }

      if (col.defaultValue.trim()) {
        def += ` DEFAULT ${col.defaultValue}`;
      }

      if (col.comment.trim()) {
        if (driverType === 'mysql') {
          def += ` COMMENT ${escapeComment(col.comment)}`;
        } else if (driverType === 'postgresql') {
          commentStatements.push(`COMMENT ON COLUMN ${escapeId(tableName)}.${escapeId(col.name)} IS ${escapeComment(col.comment)};`);
        }
        // SQLite has no column comments.
      }

      return def;
    });

    const pks = columns.filter(c => c.isPrimaryKey);
    const hasInlinePk = driverType === 'sqlite' && pks.some(c => c.isAutoIncrement);

    if (pks.length > 0 && !hasInlinePk) {
      colDefinitions.push(`PRIMARY KEY (${pks.map(c => escapeId(c.name)).join(', ')})`);
    }

    foreignKeys
      .filter(fk => fk.columns.length > 0 && fk.referencedTable && fk.referencedColumns.trim())
      .forEach(fk => {
        const constraintName = fk.name.trim() || generateForeignKeyName(fk);
        const refParts = fk.referencedTable.split('.').map(part => part.trim()).filter(Boolean);
        const refIdentifier = refParts.length === 2
          ? `${escapeId(refParts[0])}.${escapeId(refParts[1])}`
          : escapeId(refParts[0] || fk.referencedTable);
        const refColumns = fk.referencedColumns.split(',').map(col => col.trim()).filter(Boolean);
        colDefinitions.push(
          `CONSTRAINT ${escapeId(constraintName)} FOREIGN KEY (${fk.columns.map(escapeId).join(', ')}) REFERENCES ${refIdentifier} (${refColumns.map(escapeId).join(', ')}) ON UPDATE ${fk.onUpdate} ON DELETE ${fk.onDelete}`
        );
      });

    const tableIdentifier = schemaName.trim()
      ? `${escapeId(schemaName)}.${escapeId(tableName)}`
      : escapeId(tableName);

    const indexStatements = indexes
      .filter(index => index.name && index.columns.length > 0)
      .map(index => `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${escapeId(index.name)} ON ${tableIdentifier} (${index.columns.map(escapeId).join(', ')});`);

    const charsetSql = driverType === 'mysql' && tableCharset !== 'DEFAULT'
      ? ` DEFAULT CHARACTER SET ${tableCharset}${tableCollation ? ` COLLATE ${tableCollation}` : ''}`
      : '';

    const tableCommentSql = tableComment.trim()
      ? (driverType === 'mysql'
        ? ` COMMENT=${escapeComment(tableComment)}`
        : driverType === 'postgresql'
          ? `\n\nCOMMENT ON TABLE ${tableIdentifier} IS ${escapeComment(tableComment)};`
          : '')
      : '';

    const sql = [
      `CREATE TABLE ${tableIdentifier} (\n  ${colDefinitions.join(',\n  ')}\n)${charsetSql}${driverType === 'mysql' ? tableCommentSql : ''};`,
      ...(driverType === 'mysql' ? [] : [tableCommentSql.trim()]).filter(Boolean),
      ...commentStatements,
      ...indexStatements
    ].join('\n\n');
    setGeneratedSQL(sql);
  };

  const handleExecute = () => {
    if (!generatedSQL.trim()) return;
    post({
      type: 'executeCreateTable',
      data: {
        sql: generatedSQL,
        tableName,
        schemaName
      }
    });
  };

  return (
    <div className="create-table-view">
      <header className="create-table-header">
        <div className="title-area">
          <span className="icon"><Icon name="plus" size={18} /></span>
          <div className="info">
            <h2>{t('Create New Table')}</h2>
            <span className="sub-info">{t('Configure structure visually')}</span>
          </div>
        </div>
      </header>

      <div className="create-table-content">
        <div className="config-form">
          <div className="form-group-horizontal">
            {driverType !== 'sqlite' && (
              <div className="form-item">
                <label>{t('Schema')}</label>
                <input
                  type="text"
                  placeholder="e.g. public"
                  value={schemaName}
                  onChange={e => setSchemaName(e.target.value)}
                  className="form-input"
                />
              </div>
            )}
            <div className="form-item main-name">
              <label>{t('Table Name')} *</label>
              <input
                type="text"
                placeholder="e.g. users"
                value={tableName}
                onChange={e => setTableName(e.target.value)}
                className="form-input"
                required
              />
            </div>
            <div className="form-item main-name">
              <label>{t('Table Comment')}</label>
              <input
                type="text"
                placeholder="e.g. 用户表"
                value={tableComment}
                onChange={e => setTableComment(e.target.value)}
                className="form-input"
              />
            </div>
          </div>
          {driverType === 'mysql' && (
            <div className="form-group-horizontal table-options-row">
              <div className="form-item">
                <label>{t('Table Charset')}</label>
                <select className="form-input" value={tableCharset} onChange={e => {
                  setTableCharset(e.target.value);
                  setTableCollation('');
                }}>
                  {MYSQL_CHARSETS.map(charset => (
                    <option key={charset.label} value={charset.label}>{charset.label}</option>
                  ))}
                </select>
              </div>
              <div className="form-item">
                <label>{t('Table Collation')}</label>
                <select className="form-input" value={tableCollation} onChange={e => setTableCollation(e.target.value)} disabled={tableCharset === 'DEFAULT'}>
                  <option value="">DEFAULT</option>
                  {(MYSQL_CHARSETS.find(charset => charset.label === tableCharset)?.collations || []).map(collation => (
                    <option key={collation} value={collation}>{collation}</option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>

        <div className="columns-section">
          <h3>{t('Columns')}</h3>
          <div className="table-wrapper">
            <table className="create-columns-table">
              <thead>
                <tr>
                  <th style={{ width: '50px' }}>{t('PK')}</th>
                  <th style={{ width: '80px' }}>{t('AI')}</th>
                  <th>{t('Name')}</th>
                  <th style={{ width: '200px' }}>{t('Type')}</th>
                  <th style={{ width: '80px' }}>{t('Nullable')}</th>
                  <th>{t('Default Value')}</th>
                  <th>{t('Comment')}</th>
                  <th style={{ width: '120px' }}>{t('Actions')}</th>
                </tr>
              </thead>
              <tbody>
                {columns.map((col, idx) => (
                  <tr key={idx}>
                    <td style={{ textAlign: 'center' }}>
                      <input
                        type="checkbox"
                        checked={col.isPrimaryKey}
                        onChange={e => handleUpdateColumn(idx, { isPrimaryKey: e.target.checked })}
                      />
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <input
                        type="checkbox"
                        checked={col.isAutoIncrement}
                        onChange={e => handleUpdateColumn(idx, { isAutoIncrement: e.target.checked })}
                        disabled={
                          driverType === 'postgresql' &&
                          !['integer', 'bigint', 'smallint'].includes(col.type.toLowerCase())
                        }
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        value={col.name}
                        onChange={e => handleUpdateColumn(idx, { name: e.target.value })}
                        placeholder="column_name"
                        className="cell-input"
                      />
                    </td>
                    <td>
                      <DataTypeAutocomplete
                        value={col.type}
                        onChange={val => handleUpdateColumn(idx, { type: val })}
                        driverType={driverType}
                      />
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <input
                        type="checkbox"
                        checked={col.nullable}
                        onChange={e => handleUpdateColumn(idx, { nullable: e.target.checked })}
                        disabled={col.isPrimaryKey}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        value={col.defaultValue}
                        onChange={e => handleUpdateColumn(idx, { defaultValue: e.target.value })}
                        placeholder="e.g. NULL, 'value', 0"
                        className="cell-input"
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        value={col.comment}
                        onChange={e => handleUpdateColumn(idx, { comment: e.target.value })}
                        placeholder="column comment"
                        className="cell-input"
                      />
                    </td>
                    <td>
                      <button className="btn-icon" onClick={() => handleMoveColumn(idx, 'up')} disabled={idx === 0}><Icon name="chevronUp" size={13} /></button>
                      <button className="btn-icon" onClick={() => handleMoveColumn(idx, 'down')} disabled={idx === columns.length - 1}><Icon name="chevronDown" size={13} /></button>
                      <button className="btn-icon btn-danger" onClick={() => handleRemoveColumn(idx)} disabled={columns.length <= 1}><Icon name="close" size={13} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button className="btn-secondary" onClick={handleAddColumn}><Icon name="plus" size={14} /> {t('Add Column')} </button>
        </div>

        <div className="definition-section">
          <div className="section-header">
            <h3>{t('Indexes')}</h3>
            <button className="btn-secondary" onClick={handleAddIndex}><Icon name="plus" size={14} /> {t('Add Index')} </button>
          </div>
          {indexes.map((index, idx) => (
            <div className="definition-card" key={idx}>
              <div className="form-group-horizontal">
                <div className="form-item">
                  <label>{t('Name')}</label>
                  <input className="form-input" value={index.name} onChange={e => handleUpdateIndex(idx, { name: e.target.value })} />
                </div>
                <label className="checkbox-inline">
                  <input type="checkbox" checked={index.unique} onChange={e => handleUpdateIndex(idx, { unique: e.target.checked })} /> {t('Unique')} </label>
                <button className="btn-icon btn-danger" onClick={() => handleRemoveIndex(idx)}><Icon name="close" size={13} /></button>
              </div>
              <div className="choice-list">
                {columns.map(col => (
                  <label key={col.name || col.type} className="checkbox-inline">
                    <input
                      type="checkbox"
                      checked={index.columns.includes(col.name)}
                      disabled={!col.name}
                      onChange={e => {
                        const nextColumns = e.target.checked
                          ? [...index.columns, col.name]
                          : index.columns.filter(name => name !== col.name);
                        handleUpdateIndex(idx, { columns: nextColumns });
                      }}
                    />
                    {col.name || '(unnamed)'}
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="definition-section">
          <div className="section-header">
            <h3>{t('Foreign Keys')}</h3>
            <button className="btn-secondary" onClick={handleAddForeignKey}><Icon name="plus" size={14} /> {t('Add Foreign Key')} </button>
          </div>
          {foreignKeys.map((fk, idx) => (
            <div className="definition-card" key={idx}>
              <div className="form-group-horizontal">
                <div className="form-item">
                  <label>{t('Name')}</label>
                  <input className="form-input" value={fk.name} onChange={e => handleUpdateForeignKey(idx, { name: e.target.value })} placeholder={t('Leave blank to auto-generate')} />
                </div>
                <div className="form-item">
                  <label>{t('Referenced Table')}</label>
                  <input
                    className="form-input"
                    list="create-table-reference-tables"
                    value={fk.referencedTable}
                    onChange={e => handleUpdateForeignKey(idx, { referencedTable: e.target.value })}
                    placeholder="schema.table or table"
                  />
                </div>
                <div className="form-item">
                  <label>{t('Referenced Columns')}</label>
                  <input className="form-input" value={fk.referencedColumns} onChange={e => handleUpdateForeignKey(idx, { referencedColumns: e.target.value })} placeholder="id" />
                </div>
                <button className="btn-icon btn-danger" onClick={() => handleRemoveForeignKey(idx)}><Icon name="close" size={13} /></button>
              </div>
              <datalist id="create-table-reference-tables">
                {tables.filter(t => t.type === 'table').map(t => (
                  <option key={`${t.schema || ''}.${t.name}`} value={t.schema ? `${t.schema}.${t.name}` : t.name} />
                ))}
              </datalist>
              <div className="choice-list">
                {columns.map(col => (
                  <label key={col.name || col.type} className="checkbox-inline">
                    <input
                      type="checkbox"
                      checked={fk.columns.includes(col.name)}
                      disabled={!col.name}
                      onChange={e => {
                        const nextColumns = e.target.checked
                          ? [...fk.columns, col.name]
                          : fk.columns.filter(name => name !== col.name);
                        handleUpdateForeignKey(idx, { columns: nextColumns });
                      }}
                    />
                    {col.name || '(unnamed)'}
                  </label>
                ))}
              </div>
              <div className="form-group-horizontal">
                <div className="form-item">
                  <label>{t('On Update')}</label>
                  <select className="form-input" value={fk.onUpdate} onChange={e => handleUpdateForeignKey(idx, { onUpdate: e.target.value })}>
                    <option value="NO ACTION">NO ACTION</option>
                    <option value="CASCADE">CASCADE</option>
                    <option value="RESTRICT">RESTRICT</option>
                    <option value="SET NULL">SET NULL</option>
                    <option value="SET DEFAULT">SET DEFAULT</option>
                  </select>
                </div>
                <div className="form-item">
                  <label>{t('On Delete')}</label>
                  <select className="form-input" value={fk.onDelete} onChange={e => handleUpdateForeignKey(idx, { onDelete: e.target.value })}>
                    <option value="NO ACTION">NO ACTION</option>
                    <option value="CASCADE">CASCADE</option>
                    <option value="RESTRICT">RESTRICT</option>
                    <option value="SET NULL">SET NULL</option>
                    <option value="SET DEFAULT">SET DEFAULT</option>
                  </select>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="action-section">
          <button className="btn-primary" onClick={generateSQL} disabled={!tableName.trim()}>
            {t('Generate CREATE TABLE SQL')}
          </button>
        </div>

        {generatedSQL && (
          <div className="sql-preview-container">
            <h4>{t('Generated SQL Preview')}</h4>
            <textarea
              className="sql-preview-textarea"
              value={generatedSQL}
              onChange={e => setGeneratedSQL(e.target.value)}
              rows={8}
            />
            <div className="sql-preview-actions">
              <button className="btn-secondary" onClick={() => setGeneratedSQL('')}>{t('Discard')}</button>
              <button className="btn-primary btn-save" onClick={handleExecute}><Icon name="play" size={13} /> {t('Execute CREATE TABLE')} </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
