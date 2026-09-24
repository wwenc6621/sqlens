import React, { useState, useEffect, useCallback } from 'react';
import { postMessage as postRaw, onMessage } from '../../hooks/useVsCode';
import Icon from '../../components/Icon';
import { t } from '../../i18n';
import './AiActivity.css';

interface AiActivityEntry {
  id: string;
  timestamp: number;
  tool: string;
  client: string;
  argsSummary: string;
  sql?: string;
  connectionName?: string;
  durationMs: number;
  rowCount?: number;
  success: boolean;
  error?: string;
  blocked?: boolean;
}

interface PendingWrite {
  id: string;
  timestamp: number;
  client: string;
  tool: string;
  sql: string;
  connectionName?: string;
  timeoutMs: number;
}

interface ActivityData {
  entries: AiActivityEntry[];
  pending: PendingWrite[];
}

function timeStr(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

/** One line of the activity feed. */
function EntryRow({ entry }: { entry: AiActivityEntry }) {
  const [expanded, setExpanded] = useState(false);
  const statusClass = !entry.success ? 'error' : entry.blocked ? 'blocked' : 'ok';
  const statusIcon = !entry.success ? 'close' : entry.blocked ? 'lock' : 'checkCircle';
  const sql = entry.sql || entry.argsSummary;

  return (
    <div className={`aia-entry ${statusClass}${expanded ? ' expanded' : ''}`}>
      <button className="aia-entry-main" onClick={() => setExpanded(e => !e)} title={sql}>
        <span className={`aia-status ${statusClass}`}>
          <Icon name={statusIcon as never} size={13} />
        </span>
        <span className="aia-time">{timeStr(entry.timestamp)}</span>
        <span className="aia-client">{entry.client}</span>
        <span className="aia-tool">{entry.tool}</span>
        {entry.rowCount != null && entry.success && !entry.blocked && (
          <span className="aia-rows">{entry.rowCount} rows</span>
        )}
        <span className="aia-duration">{entry.durationMs}ms</span>
      </button>
      {expanded && (
        <div className="aia-entry-detail">
          {entry.connectionName && <div className="aia-conn">Connection: {entry.connectionName}</div>}
          {entry.error && <div className="aia-err">Error: {entry.error}</div>}
          <pre className="aia-sql">{sql}</pre>
        </div>
      )}
    </div>
  );
}

/** Inline confirmation card for AI write statements. */
function PendingCard({ pending, onAction }: {
  pending: PendingWrite;
  onAction: (pendingId: string, action: 'confirmWrite' | 'denyWrite') => void;
}) {
  const remainingSec = Math.max(0, Math.round((pending.timeoutMs - (Date.now() - pending.timestamp)) / 1000));

  return (
    <div className="aia-pending">
      <div className="aia-pending-header">
        <Icon name="shield" size={14} />
        <span className="aia-pending-title">{t('AI wants to modify data')}</span>
        <span className="aia-pending-meta">{pending.client} · {timeStr(pending.timestamp)} · expires in {remainingSec}s</span>
      </div>
      <pre className="aia-pending-sql">{pending.sql}</pre>
      <div className="aia-pending-actions">
        <button className="aia-btn allow" onClick={() => onAction(pending.id, 'confirmWrite')}>{t('Allow')}</button>
        <button className="aia-btn deny" onClick={() => onAction(pending.id, 'denyWrite')}>{t('Deny')}</button>
      </div>
    </div>
  );
}

export default function AiActivityView({ instanceId = 'default' }: { instanceId?: string }) {
  const post = useCallback((message: any) => postRaw({ ...message, instanceId }), [instanceId]);
  const [data, setData] = useState<ActivityData>({ entries: [], pending: [] });
  const [filter, setFilter] = useState('');

  useEffect(() => {
    post({ type: 'ready' });
    const unsub = onMessage((msg: any) => {
      if (msg?.instanceId !== instanceId) { return; }
      if (msg.type === 'aiActivityData') {
        setData({ entries: msg.data?.entries || [], pending: msg.data?.pending || [] });
      }
    });
    return unsub;
  }, [instanceId, post]);

  const handleAction = (pendingId: string, action: 'confirmWrite' | 'denyWrite') => {
    post({ type: 'aiActivityResult', data: { pendingId, action } });
  };

  const f = filter.toLowerCase();
  const filtered = data.entries.filter(e =>
    !f || e.tool.toLowerCase().includes(f) || e.client.toLowerCase().includes(f) ||
    (e.sql || e.argsSummary).toLowerCase().includes(f),
  );
  const pendingShown = data.pending.slice(0, 5);

  return (
    <div className="aia-panel">
      <div className="aia-header">
        <h2>{t('AI Activity')}</h2>
        <div className="aia-header-actions">
          <input
            className="aia-filter"
            type="text"
            placeholder={t('Filter...')}
            value={filter}
            onChange={e => setFilter(e.target.value)}
          />
          <button className="aia-btn" onClick={() => post({ type: 'clearAiActivity' })} title={t('Clear all')}>
            <Icon name="close" size={12} /> Clear
          </button>
        </div>
      </div>

      {pendingShown.length > 0 && (
        <div className="aia-pending-list">
          {pendingShown.map(p => (
            <PendingCard key={p.id} pending={p} onAction={handleAction} />
          ))}
        </div>
      )}

      <div className="aia-list">
        {filtered.length === 0 ? (
          <div className="aia-empty">
            <Icon name="zap" size={36} strokeWidth={1.2} />
            <p>{t('No AI activity yet.')}</p>
            <p className="aia-empty-hint">
              Connect your AI assistant to the Sqlens MCP server
              (Sqlens: Register MCP Server to AI Assistants) and its
              database calls will appear here.
            </p>
          </div>
        ) : (
          filtered.map(entry => (
            <EntryRow key={entry.id} entry={entry} />
          ))
        )}
      </div>
      {filtered.length > 0 && (
        <div className="aia-footer">
          <span className="aia-footer-hint">{filtered.length} entr{filtered.length === 1 ? 'y' : 'ies'} · click a row to expand SQL</span>
        </div>
      )}
    </div>
  );
}
