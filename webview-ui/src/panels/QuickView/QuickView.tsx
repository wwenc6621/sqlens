import React, { useState, useEffect, useCallback } from 'react';
import { postMessage as postRaw, onMessage } from '../../hooks/useVsCode';
import Icon from '../../components/Icon';
import { formatColumnType } from '../../utils/columnType';
import { t } from '../../i18n';
import './QuickView.css';

interface ColumnHeader {
  name: string;
  type: string;
  normalizedType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  rawType?: string;
  maxLength?: number;
  precision?: number;
  scale?: number;
  /** Column comment / description from the database catalog. */
  comment?: string;
}

function valueToText(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') {
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
  }
  const text = String(value);
  const trimmed = text.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try { return JSON.stringify(JSON.parse(trimmed), null, 2); } catch {}
  }
  return text;
}

export default function QuickView({ instanceId = 'default' }: { instanceId?: string }) {
  const post = useCallback((message: any) => postRaw({ ...message, instanceId }), [instanceId]);

  const [columns, setColumns] = useState<ColumnHeader[]>([]);
  const [rowData, setRowData] = useState<unknown[]>([]);
  const [filterText, setFilterText] = useState('');
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [expandedField, setExpandedField] = useState<{ name: string; type: string; value: string; comment?: string } | null>(null);

  useEffect(() => {
    post({ type: 'ready' });
    const unsub = onMessage((msg: any) => {
      if (msg?.instanceId !== instanceId) { return; }
      if (msg.type === 'quickViewData') {
        setColumns(msg.data.columns || []);
        setRowData(msg.data.rowData || []);
      } else if (msg.type === 'rowSelected') {
        // Real-time update when user selects a different row
        setColumns(msg.data.columns || []);
        setRowData(msg.data.rowData || []);
      }
    });
    return unsub;
  }, [instanceId, post]);

  const showToast = (kind: 'success' | 'error', text: string) => {
    setToast({ kind, text });
    setTimeout(() => setToast(null), 1800);
  };

  const writeClipboard = async (text: string, successText: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast('success', successText);
      return true;
    } catch (err) {
      showToast('error', `Copy failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };

  const handleCopy = async (value: unknown, index: number) => {
    const copied = await writeClipboard(valueToText(value), 'Copied value');
    if (copied) {
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 1500);
    }
  };

  const handleCopyAll = async (format: 'json' | 'csv' | 'tsv') => {
    const cols = columns;
    let text = '';
    if (format === 'json') {
      const obj: Record<string, unknown> = {};
      cols.forEach((col, i) => { obj[col.name] = rowData[i]; });
      text = JSON.stringify(obj, null, 2);
    } else if (format === 'csv') {
      const header = cols.map(c => c.name).join(',');
      const vals = rowData.map(v => {
        if (v === null) return '';
        const s = String(v);
        return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(',');
      text = `${header}\n${vals}`;
    } else if (format === 'tsv') {
      text = rowData.map(v => v === null ? 'NULL' : String(v)).join('\t');
    }
    await writeClipboard(text, `Copied ${format.toUpperCase()}`);
  };

  const filteredFields = columns
    .map((col, idx) => ({ col, val: rowData[idx], idx }))
    .filter(item => item.col.name.toLowerCase().includes(filterText.toLowerCase()));

  return (
    <div className="quickview-panel">
      <div className="quickview-header">
        <h2>{t('Quick View')}</h2>
        <div className="quickview-copy-btns">
          <button className="qv-copy-btn" onClick={() => handleCopyAll('json')} title={t('Copy all as JSON')}>JSON</button>
          <button className="qv-copy-btn" onClick={() => handleCopyAll('csv')} title={t('Copy all as CSV')}>CSV</button>
          <button className="qv-copy-btn" onClick={() => handleCopyAll('tsv')} title={t('Copy all as TSV')}>TSV</button>
        </div>
      </div>
      <div className="quickview-search">
        <input
          type="text"
          placeholder={t('Filter fields...')}
          value={filterText}
          onChange={e => setFilterText(e.target.value)}
        />
      </div>
      <div className="quickview-content">
        {filteredFields.length === 0 ? (
          <div className="quickview-empty">{t('No matching fields')}</div>
        ) : (
          <table className="quickview-table">
            <thead>
              <tr>
                <th className="col-header">{t('Column')}</th>
                <th className="type-header">{t('Type')}</th>
                <th className="val-header">{t('Value')}</th>
                <th className="copy-header"></th>
              </tr>
            </thead>
            <tbody>
              {filteredFields.map(({ col, val, idx }) => (
                <tr key={idx} className={col.isPrimaryKey ? 'pk-row' : ''}>
                  <td className="col-cell">
                    {col.isPrimaryKey && <span className="pk-badge"><Icon name="key" size={12} /></span>}
                    <span className="col-name">{col.name}</span>
                    {col.comment && <span className="col-comment" title={col.comment}>{col.comment}</span>}
                  </td>
                  <td className="type-cell">
                    <span className="col-type-badge">{formatColumnType(col)}</span>
                  </td>
                  <td className="val-cell">
                    {val === null ? (
                      <span className="val-null">NULL</span>
                    ) : (
                      <button
                        className="val-text"
                        onClick={() => setExpandedField({ name: col.name, type: formatColumnType(col), value: valueToText(val), comment: col.comment })}
                        title={t('Click to view full value')}
                      >
                        {valueToText(val)}
                      </button>
                    )}
                  </td>
                  <td className="copy-cell">
                    <button
                      className={`copy-btn ${copiedIndex === idx ? 'copied' : ''}`}
                      onClick={() => handleCopy(val, idx)}
                      title={t('Copy value')}
                    >
                      {copiedIndex === idx ? <Icon name="check" size={13} /> : <Icon name="copy" size={13} />}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {toast && <div className={`quickview-toast ${toast.kind}`}>{toast.text}</div>}
      {expandedField && (
        <div className="quickview-modal-backdrop" onClick={() => setExpandedField(null)}>
          <div className="quickview-modal" onClick={e => e.stopPropagation()}>
            <div className="quickview-modal-header">
              <div>
                <strong>{expandedField.name}</strong>
                <span>{expandedField.type}</span>
                {expandedField.comment && <span className="quickview-modal-comment">{expandedField.comment}</span>}
              </div>
              <button onClick={() => setExpandedField(null)} title={t('Close')}>x</button>
            </div>
            <pre className="quickview-modal-content">{expandedField.value}</pre>
            <div className="quickview-modal-actions">
              <button onClick={() => writeClipboard(expandedField.value, 'Copied full value')}>{t('Copy')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
