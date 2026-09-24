import React, { useState, useEffect, useCallback } from 'react';
import { postMessage as postRaw, onMessage } from '../../hooks/useVsCode';
import Icon from '../../components/Icon';
import { t } from '../../i18n';
import './LogDetailView.css';

interface LogDetailData {
  time: string;
  type: string;
  message: string;
  details?: string;
  executionTime?: number;
}

/**
 * Read-only detail view for a single log entry, rendered as a panel tab.
 */
export default function LogDetailView({ instanceId = 'default' }: { instanceId?: string }) {
  const post = useCallback((message: any) => postRaw({ ...message, instanceId }), [instanceId]);

  const [data, setData] = useState<LogDetailData | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    post({ type: 'ready' });
    const unsub = onMessage((msg: any) => {
      if (msg?.instanceId !== instanceId) { return; }
      if (msg.type === 'logDetailData') {
        setData(msg.data || null);
        setCopied(false);
      }
    });
    return unsub;
  }, [instanceId, post]);

  const copyAll = useCallback(() => {
    if (!data) { return; }
    const parts = [`[${data.time}] [${data.type.toUpperCase()}]`, data.message];
    if (data.executionTime !== undefined) { parts[0] += ` (${data.executionTime}ms)`; }
    if (data.details) { parts.push(data.details); }
    navigator.clipboard.writeText(parts.join('\n\n')).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* clipboard unavailable */ });
  }, [data]);

  if (!data) {
    return <div className="log-entry-view log-entry-empty">{t('Select a log entry...')}</div>;
  }

  return (
    <div className="log-entry-view">
      <header className="log-entry-header">
        <div className="log-entry-meta">
          <span className={`log-entry-type ${data.type}`}>{data.type.toUpperCase()}</span>
          <span className="log-entry-stamp">{data.time}</span>
          {data.executionTime !== undefined && (
            <span className="log-entry-stamp">{data.executionTime}ms</span>
          )}
        </div>
        <button type="button" className="log-entry-action" onClick={copyAll} title={t('Copy log entry')}>
          <Icon name={copied ? 'check' : 'copy'} size={13} /> {copied ? t('Copied') : t('Copy')}
        </button>
      </header>

      <div className="log-entry-body">
        <pre className="log-entry-message">{data.message}</pre>
        {data.details && <pre className="log-entry-details">{data.details}</pre>}
      </div>
    </div>
  );
}
