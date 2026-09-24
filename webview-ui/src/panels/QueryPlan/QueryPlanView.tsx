import React, { useState, useEffect, useCallback } from 'react';
import { postMessage as postRaw, onMessage } from '../../hooks/useVsCode';
import Icon from '../../components/Icon';
import { t } from '../../i18n';
import './QueryPlanView.css';

interface PlanData {
  sql: string;
  driverType: string;
  plan: {
    format: 'json' | 'text' | 'sqlite';
    raw: any;
  };
}

interface SQLitePlanNode {
  id: number;
  parent: number;
  detail: string;
  children: SQLitePlanNode[];
}

export default function QueryPlanView({ instanceId = 'default' }: { instanceId?: string }) {
  const post = useCallback((message: any) => postRaw({ ...message, instanceId }), [instanceId]);

  const [data, setData] = useState<PlanData | null>(null);
  const [viewMode, setViewMode] = useState<'visual' | 'raw'>('visual');

  useEffect(() => {
    post({ type: 'ready' });
    const unsub = onMessage((msg: any) => {
      if (msg?.instanceId !== instanceId) { return; }
      if (msg.type === 'planData') {
        setData(msg.data);
      }
    });
    return unsub;
  }, [instanceId, post]);

  if (!data) {
    return (
      <div className="plan-loading">
        <div className="spinner"></div>
        <h3>{t('Analyzing Query Execution Plan...')}</h3>
      </div>
    );
  }

  // Helper to check if a node performs a Full Table Scan
  const isFullScan = (nodeType: string, detail?: string) => {
    const t = (nodeType || '').toLowerCase();
    const d = (detail || '').toLowerCase();
    return (
      t.includes('seq scan') ||
      t.includes('full scan') ||
      d.includes('scan table') ||
      (d.includes('scan') && !d.includes('using index') && !d.includes('using cover'))
    );
  };

  // Helper to check if a node performs an Index Scan/Seek
  const isIndexScan = (nodeType: string, detail?: string) => {
    const t = (nodeType || '').toLowerCase();
    const d = (detail || '').toLowerCase();
    return (
      t.includes('index scan') ||
      t.includes('index seek') ||
      t.includes('bitmap index scan') ||
      d.includes('using index') ||
      d.includes('using cover') ||
      d.includes('search table using')
    );
  };

  // 1. Postgres Visual Plan Node Renderer
  const renderPostgresNode = (node: any): React.ReactNode => {
    if (!node) return null;
    const type = node['Node Type'] || 'Unknown Operation';
    const relName = node['Relation Name'];
    const alias = node['Alias'];
    const cost = node['Total Cost'];
    const rows = node['Plan Rows'];
    const loops = node['Actual Loops'] || 1;
    const plans = node['Plans'] || [];

    const fullScan = isFullScan(type);
    const indexScan = isIndexScan(type);

    return (
      <div className="plan-node-wrapper" key={`${type}-${cost}-${rows}`}>
        <div className={`plan-card ${fullScan ? 'full-scan' : indexScan ? 'index-scan' : ''}`}>
          <div className="node-type">{type}</div>
          {relName && (
            <div className="node-relation">
              Table: <strong>{relName}</strong> {alias && alias !== relName ? `(as ${alias})` : ''}
            </div>
          )}
          <div className="node-stats">
            <span className="stat-badge">Cost: {cost}</span>
            <span className="stat-badge">Rows: {rows}</span>
            {loops > 1 && <span className="stat-badge">Loops: {loops}</span>}
          </div>
        </div>
        {plans.length > 0 && (
          <div className="plan-children">
            {plans.map((sub: any) => renderPostgresNode(sub))}
          </div>
        )}
      </div>
    );
  };

  // 2. SQLite Visual Plan Builder
  const renderSQLitePlan = (rows: any[]): React.ReactNode => {
    // SQLite EXPLAIN columns: row[0]=id, row[1]=parent, row[2]=notused, row[3]=detail
    const nodesMap = new Map<number, SQLitePlanNode>();
    const roots: SQLitePlanNode[] = [];

    rows.forEach(r => {
      const node: SQLitePlanNode = {
        id: Number(r[0]),
        parent: Number(r[1]),
        detail: String(r[3]),
        children: []
      };
      nodesMap.set(node.id, node);
    });

    rows.forEach(r => {
      const id = Number(r[0]);
      const node = nodesMap.get(id)!;
      if (node.parent === 0) {
        roots.push(node);
      } else {
        const parentNode = nodesMap.get(node.parent);
        if (parentNode) {
          parentNode.children.push(node);
        } else {
          roots.push(node);
        }
      }
    });

    const renderSQLiteNode = (node: SQLitePlanNode): React.ReactNode => {
      const fullScan = isFullScan('', node.detail);
      const indexScan = isIndexScan('', node.detail);

      return (
        <div className="plan-node-wrapper" key={node.id}>
          <div className={`plan-card ${fullScan ? 'full-scan' : indexScan ? 'index-scan' : ''}`}>
            <div className="node-type">{t('SQLite Operation')}</div>
            <div className="node-detail">{node.detail}</div>
          </div>
          {node.children.length > 0 && (
            <div className="plan-children">
              {node.children.map(child => renderSQLiteNode(child))}
            </div>
          )}
        </div>
      );
    };

    return roots.map(root => renderSQLiteNode(root));
  };

  // Determine visual tree content
  const renderVisualTree = () => {
    const { format, raw } = data.plan;

    if (format === 'json') {
      // Postgres format is usually an array
      if (Array.isArray(raw) && raw[0]?.['Plan']) {
        return renderPostgresNode(raw[0]['Plan']);
      }
      // If it's a generic JSON (like MySQL or custom)
      return (
        <pre className="raw-plan-text">
          <code>{JSON.stringify(raw, null, 2)}</code>
        </pre>
      );
    }

    if (format === 'sqlite') {
      return renderSQLitePlan(raw);
    }

    // Default text fallback
    return (
      <pre className="raw-plan-text">
        <code>{String(raw)}</code>
      </pre>
    );
  };

  return (
    <div className="query-plan-view">
      <header className="plan-header">
        <div className="header-info">
          <h2><Icon name="search" size={16} /> {t('Query Execution Plan')} </h2>
          <span className="subtitle">
            Database Type: <strong>{data.driverType.toUpperCase()}</strong>
          </span>
        </div>
        <div className="tab-buttons">
          <button className={viewMode === 'visual' ? 'active' : ''} onClick={() => setViewMode('visual')}>
            Visual Diagram
          </button>
          <button className={viewMode === 'raw' ? 'active' : ''} onClick={() => setViewMode('raw')}>
            Raw Plan Output
          </button>
        </div>
      </header>

      <section className="sql-preview">
        <h4>Target Query:</h4>
        <pre><code>{data.sql}</code></pre>
      </section>

      <div className="plan-body">
        {viewMode === 'visual' ? (
          <div className="diagram-canvas">
            <div className="legend">
              <span className="legend-item"><span className="dot dot-danger"></span> Full Table Scan (Slow)</span>
              <span className="legend-item"><span className="dot dot-success"></span> Index Scan / Seek (Fast)</span>
              <span className="legend-item"><span className="dot dot-default"></span> Internal Operations</span>
            </div>
            <div className="tree-container">
              {renderVisualTree()}
            </div>
          </div>
        ) : (
          <div className="raw-output">
            <pre className="raw-plan-text">
              <code>
                {data.plan.format === 'json'
                  ? JSON.stringify(data.plan.raw, null, 2)
                  : data.plan.format === 'sqlite'
                  ? data.plan.raw.map((r: any) => `ID: ${r[0]} | Parent: ${r[1]} | Detail: ${r[3]}`).join('\n')
                  : String(data.plan.raw)}
              </code>
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
