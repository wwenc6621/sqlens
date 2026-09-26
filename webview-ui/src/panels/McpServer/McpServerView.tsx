import React, { useState, useEffect, useCallback } from 'react';
import { postMessage as postRaw, onMessage } from '../../hooks/useVsCode';
import Icon from '../../components/Icon';
import { t } from '../../i18n';
import './McpServer.css';

interface RegisteredAssistant {
  id: string;
  name: string;
  registered: boolean;
  configPath: string;
}

interface McpStatusData {
  enabled: boolean;
  running: boolean;
  endpoint: string;
  port: number;
  token: string;
  readOnly: boolean;
  writeMode: string;
  maxRows: number;
  registeredAssistants: RegisteredAssistant[];
  activity: { entries: number; pending: number };
}

export default function McpServerView({ instanceId = 'mcp-server' }: { instanceId?: string }) {
  const post = useCallback((message: any) => postRaw({ ...message, instanceId }), [instanceId]);
  const [data, setData] = useState<McpStatusData | null>(null);
  const [revealToken, setRevealToken] = useState(false);

  useEffect(() => {
    post({ type: 'ready' });
    post({ type: 'mcpGetStatus' });
    const unsub = onMessage((msg: any) => {
      if (msg?.instanceId !== instanceId) { return; }
      if (msg.type === 'mcpStatus') {
        setData(msg.data);
        setRevealToken(false);
      }
    });
    return unsub;
  }, [instanceId, post]);

  const refresh = () => post({ type: 'mcpGetStatus' });
  const start = () => post({ type: 'mcpStart' });
  const stop = () => post({ type: 'mcpStop' });
  const regenerate = () => post({ type: 'mcpRegenerateToken' });
  const copyEndpoint = () => post({ type: 'mcpCopyEndpoint' });
  const copyConfig = () => post({ type: 'mcpCopyConfig' });
  const register = () => post({ type: 'mcpRegister' });
  const toggleReadOnly = () => post({ type: 'mcpToggleReadOnly', data: { readOnly: !data?.readOnly } });
  const toggleAutoApprove = () => post({ type: 'mcpToggleAutoApprove', data: { autoApprove: data?.writeMode !== 'allow' } });
  const openActivity = () => post({ type: 'mcpOpenActivity' });

  if (!data) {
    return (
      <div className="mcp-panel">
        <div className="mcp-empty">
          <Icon name="plug" size={36} strokeWidth={1.2} />
          <p>{t('Loading...')}</p>
        </div>
      </div>
    );
  }

  const statusClass = data.running ? 'running' : 'stopped';
  const tokenDisplay = revealToken ? data.token : '•'.repeat(Math.min(24, Math.max(12, data.token.length)));
  // `writeMode: 'allow'` means writes run without asking; 'confirm' asks.
  const autoApprove = data.writeMode === 'allow';

  return (
    <div className="mcp-panel">
      <div className="mcp-header">
        <div className="mcp-header-left">
          <div className={`mcp-status-badge ${statusClass}`}>
            <Icon name="dot" size={12} className="mcp-dot" />
            <span>{data.running ? t('Running') : t('Stopped')}</span>
          </div>
          {/* Switch is on = Read & Write; off = Read-only (matches the label). */}
          <label
            className="mcp-switch"
            title={data.readOnly ? t('Access Mode: Read-only') : t('Access Mode: Read & Write')}
          >
            <input type="checkbox" checked={!data.readOnly} onChange={toggleReadOnly} />
            <span className="mcp-switch-track"><span className="mcp-switch-thumb" /></span>
            <span className="mcp-switch-label">{data.readOnly ? t('Read-only') : t('Read & Write')}</span>
          </label>
          <label
            className={`mcp-switch${autoApprove ? ' danger' : ''}${data.readOnly ? ' disabled' : ''}`}
            title={data.readOnly
              ? t('Switch to Read & Write first to enable writes')
              : (autoApprove
                ? t('Writes execute without confirmation')
                : t('Every write asks for confirmation'))}
          >
            <input type="checkbox" checked={autoApprove} disabled={data.readOnly} onChange={toggleAutoApprove} />
            <span className="mcp-switch-track"><span className="mcp-switch-thumb" /></span>
            <span className="mcp-switch-label">
              {autoApprove ? t('Auto-approve') : t('Confirm writes')}
            </span>
          </label>
        </div>
        <div className="mcp-header-actions">
          <button className="mcp-icon-btn" onClick={refresh} title={t('Refresh')}>
            <Icon name="refresh" size={14} />
          </button>
          {data.running ? (
            <button className="mcp-icon-btn danger" onClick={stop} title={t('Stop Server')}>
              <Icon name="stop" size={14} />
            </button>
          ) : (
            <button className="mcp-icon-btn" onClick={start} title={t('Start Server')}>
              <Icon name="play" size={14} />
            </button>
          )}
          <button className="mcp-icon-btn" onClick={register} title={t('Register to Assistant...')}>
            <Icon name="plug" size={14} />
          </button>
        </div>
      </div>

      {!data.enabled && (
        <div className="mcp-banner">
          <Icon name="lock" size={13} />
          <span>{t('MCP server is disabled in settings (sqlens.mcp.enabled). You can still start it manually below.')}</span>
        </div>
      )}

      {autoApprove && !data.readOnly && (
        <div className="mcp-banner danger">
          <Icon name="zap" size={13} />
          <span>
            {t('Auto-approve is on: AI writes (INSERT/UPDATE/DELETE/CREATE/ALTER) run without confirmation. DROP and TRUNCATE are still blocked.')}
          </span>
        </div>
      )}

      {/* Endpoint + Token (merged) */}
      <section className="mcp-card">
        <div className="mcp-card-title">{t('Endpoint & Token')}</div>
        {data.running ? (
          <>
            <div className="mcp-endpoint-row">
              <code className="mcp-endpoint">{data.endpoint}</code>
              <button className="mcp-btn" onClick={copyEndpoint} title={t('Copy Endpoint')}>
                <Icon name="copy" size={13} />
              </button>
            </div>
            <div className="mcp-endpoint-row">
              <code className="mcp-token">{tokenDisplay}</code>
              <button className="mcp-btn" onClick={() => setRevealToken(v => !v)} title={t('Reveal')}>
                <Icon name={revealToken ? 'eye' : 'lock'} size={13} />
              </button>
              <button className="mcp-btn" onClick={regenerate} title={t('Regenerate')}>
                <Icon name="refresh" size={13} />
              </button>
            </div>
            <button
              className="mcp-btn primary mcp-full"
              onClick={copyConfig}
              title={t('Copy full MCP config JSON (endpoint + bearer token)')}
            >
              <Icon name="copy" size={13} /> {t('Copy MCP Config')}
            </button>
          </>
        ) : (
          <div className="mcp-muted">{t('Start the server to expose the endpoint.')}</div>
        )}
        <div className="mcp-hint">{t('Bound to 127.0.0.1 only — not reachable from other machines.')}</div>
      </section>

      {/* Registered assistants */}
      <section className="mcp-card">
        <div className="mcp-card-title">
          {t('Registered Assistants')}
          <button className="mcp-link" onClick={register}>{t('Register more')}</button>
        </div>
        {data.registeredAssistants.length === 0 ? (
          <div className="mcp-muted">{t('No assistants detected.')}</div>
        ) : (
          <ul className="mcp-assistants">
            {data.registeredAssistants.map(a => (
              <li key={a.id} className={`mcp-assistant${a.registered ? ' on' : ''}`}>
                <Icon name={a.registered ? 'checkCircle' : 'dot'} size={14} className={a.registered ? 'ok' : 'off'} />
                <span className="mcp-assistant-name">{a.name}</span>
                <span className="mcp-assistant-state">{a.registered ? t('Registered') : t('Not registered')}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* AI Activity */}
      <section className="mcp-card">
        <div className="mcp-card-title">{t('AI Activity')}</div>
        <div className="mcp-activity-row">
          <span className="mcp-activity-meta">
            {t('{0} calls', data.activity.entries)}{data.activity.pending > 0 ? ` · ${t('{0} pending', data.activity.pending)}` : ''}
          </span>
          <button className="mcp-link" onClick={openActivity}>{t('View AI Activity')}</button>
        </div>
        <div className="mcp-hint">{t('Open the AI Activity panel to confirm or inspect AI queries.')}</div>
      </section>
    </div>
  );
}
