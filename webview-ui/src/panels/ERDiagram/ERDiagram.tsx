import React, { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import { postMessage as postRaw, onMessage } from '../../hooks/useVsCode';
import Icon from '../../components/Icon';
import { t } from '../../i18n';
import {
  arrangeTables,
  buildConnections,
  connectionPath,
  estimateBoxSize,
  renderDiagramToCanvas,
  type DiagramTable,
  type Position,
  type Size,
} from './renderDiagram';
import './ERDiagram.css';

interface ColumnInfo {
  name: string;
  type: string;
  isPrimaryKey: boolean;
  foreignKey?: boolean;
}

interface ForeignKeyInfo {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
}

interface ERTableData extends DiagramTable {
  name: string;
  schema?: string;
  columns: ColumnInfo[];
  foreignKeys: ForeignKeyInfo[];
}

export default function ERDiagram({ instanceId = 'default' }: { instanceId?: string }) {
  const post = useCallback((message: any) => postRaw({ ...message, instanceId }), [instanceId]);

  const [tables, setTables] = useState<ERTableData[]>([]);
  const [positions, setPositions] = useState<Record<string, Position>>({});
  const [sizes, setSizes] = useState<Record<string, Size>>({});
  const [draggingTable, setDraggingTable] = useState<string | null>(null);
  // `generating` means the extension is still scanning the schema; without this
  // flag an empty database would sit on the spinner forever.
  const [status, setStatus] = useState<'generating' | 'ready' | 'error'>('generating');
  const [errorText, setErrorText] = useState('');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const dragStart = useRef({ x: 0, y: 0 });
  const tableStartPos = useRef({ x: 0, y: 0 });
  const boxRefs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    post({ type: 'ready' });
    const unsub = onMessage((msg: any) => {
      if (msg?.instanceId !== instanceId) { return; }
      if (msg.type === 'erDiagramData') {
        const data = (msg.data as ERTableData[]) || [];
        setTables(data);
        setStatus('ready');
        // Positions are recalculated from the measured boxes (see below).
        setPositions({});
      } else if (msg.type === 'error') {
        setStatus('error');
        setErrorText(msg.data?.message || 'Failed to load the ER diagram.');
      } else if (msg.type === 'reloadERDiagram') {
        // Reopening an existing panel asks for a fresh scan.
        setStatus('generating');
        post({ type: 'ready' });
      }
    });
    return unsub;
  }, [instanceId, post]);

  const handleMouseDown = (e: React.MouseEvent, tableName: string) => {
    e.preventDefault();
    setDraggingTable(tableName);
    dragStart.current = { x: e.clientX, y: e.clientY };
    tableStartPos.current = { ...positions[tableName] };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!draggingTable) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    setPositions(prev => ({
      ...prev,
      [draggingTable]: {
        x: Math.max(0, tableStartPos.current.x + dx),
        y: Math.max(0, tableStartPos.current.y + dy)
      }
    }));
  };

  const handleMouseUp = () => {
    setDraggingTable(null);
  };

  /**
   * Lay the diagram out once the boxes are in the DOM: their real size depends on
   * the font and the column count, and the shelf layout needs that height to keep
   * rows from overlapping. Runs before paint, so the first frame is already placed.
   */
  useLayoutEffect(() => {
    if (tables.length === 0) { return; }
    const measured: Record<string, Size> = {};
    tables.forEach(table => {
      const el = boxRefs.current[table.name];
      measured[table.name] = el && el.offsetHeight > 0
        ? { w: el.offsetWidth, h: el.offsetHeight }
        : estimateBoxSize(table);
    });
    setSizes(measured);
    setPositions(arrangeTables(tables, measured));
  }, [tables]);

  const connections = useMemo(
    () => buildConnections(tables, positions, sizes),
    [tables, positions, sizes],
  );

  const buildCanvas = useCallback(
    () => renderDiagramToCanvas({ tables, positions, sizes, connections }),
    [tables, positions, sizes, connections],
  );

  const reportNotice = useCallback((kind: 'ok' | 'error', text: string) => {
    setNotice({ kind, text });
    window.setTimeout(() => setNotice(null), 2600);
  }, []);

  const handleCopyImage = useCallback(async () => {
    const canvas = buildCanvas();
    if (!canvas) { return; }
    try {
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob) { throw new Error('Could not encode the image.'); }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      reportNotice('ok', 'Diagram copied to clipboard.');
    } catch (err) {
      reportNotice('error', `Copy failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [buildCanvas, reportNotice]);

  const handleExportPng = useCallback(() => {
    const canvas = buildCanvas();
    if (!canvas) { return; }
    // The extension owns the file system: it shows a save dialog and writes the PNG.
    post({ type: 'saveImage', data: { base64: canvas.toDataURL('image/png'), fileName: 'er-diagram.png' } });
  }, [buildCanvas, post]);

  if (status === 'generating') {
    return (
      <div className="diagram-loading">
        <div className="spinner"></div>
        <h3>{t('Generating ER Diagram...')}</h3>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="diagram-loading">
        <h3>{t('Could not build the ER diagram')}</h3>
        <p className="text-muted">{errorText}</p>
        <button className="diagram-retry-btn" onClick={() => { setStatus('generating'); post({ type: 'ready' }); }}>
          <Icon name="refresh" size={13} /> {t('Retry')} </button>
      </div>
    );
  }

  if (tables.length === 0) {
    return (
      <div className="diagram-loading">
        <h3>{t('No tables to diagram')}</h3>
        <p className="text-muted">{t('The current database has no tables yet.')}</p>
        <button className="diagram-retry-btn" onClick={() => { setStatus('generating'); post({ type: 'ready' }); }}>
          <Icon name="refresh" size={13} /> {t('Refresh')} </button>
      </div>
    );
  }

  return (
    <div className="er-diagram" onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp}>
      <header className="diagram-header">
        <div className="header-info">
          <h2><Icon name="share" size={16} /> {t('Entity Relationship Diagram')} </h2>
          <span className="subtitle">Drag tables to rearrange. Lines indicate foreign key relationships.</span>
        </div>
        <div className="diagram-actions">
          <button className="diagram-action-btn" onClick={() => void handleCopyImage()} title={t('Copy the diagram to the clipboard as a PNG')}>
            <Icon name="copy" size={13} /> {t('Copy image')} </button>
          <button className="diagram-action-btn" onClick={handleExportPng} title={t('Save the diagram as a PNG file')}>
            <Icon name="save" size={13} /> {t('Export PNG')} </button>
        </div>
      </header>

      <div className="canvas">
        <svg className="svg-overlay">
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--vscode-charts-blue, #007acc)" />
            </marker>
          </defs>
          {connections.map(conn => (
            <g key={conn.id}>
              <path d={connectionPath(conn)} className="relationship-line" markerEnd="url(#arrow)" />
            </g>
          ))}
        </svg>

        {tables.map(table => {
          const pos = positions[table.name] || { x: 0, y: 0 };
          return (
            <div
              key={table.name}
              className="table-box"
              ref={el => { boxRefs.current[table.name] = el; }}
              style={{ left: pos.x, top: pos.y }}
              onMouseDown={e => {
                // Only initiate drag on header
                if ((e.target as HTMLElement).closest('.table-box-header')) {
                  handleMouseDown(e, table.name);
                }
              }}
            >
              <div className="table-box-header">
                <span className="icon"><Icon name="database" size={14} /></span>
                <span className="name" title={table.name}>{table.name}</span>
              </div>
              <div className="table-box-columns">
                {table.columns.map(col => (
                  <div key={col.name} className={`column-row ${col.isPrimaryKey ? 'pk' : ''} ${col.foreignKey ? 'fk' : ''}`}>
                    <span className="key-indicator">
                      {col.isPrimaryKey ? <Icon name="key" size={12} /> : col.foreignKey ? <Icon name="link" size={12} /> : ''}
                    </span>
                    <span className="col-name" title={col.name}>{col.name}</span>
                    <span className="col-type" title={col.type}>{col.type}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {notice && <div className={`diagram-notice ${notice.kind}`}>{notice.text}</div>}
    </div>
  );
}
