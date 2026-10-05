import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { onMessage, postMessage } from '../../hooks/useVsCode';
import { t } from '../../i18n';
import Icon from '../../components/Icon';
import EChart from '../../components/EChart';
import { buildChartData } from '../../utils/chartSuggest';
import type { ChartColumn, ChartConfig } from '../../utils/chartSuggest';
import { buildChartOption, currentChartColors } from '../../utils/chartOption';
import './Dashboard.css';

interface DashboardWidget {
  id: string;
  title: string;
  connectionId: string;
  sql: string;
  kind: 'table' | 'bar' | 'line' | 'pie';
  x?: string;
  y?: string[];
}

interface Dashboard {
  id: string;
  name: string;
  widgets: DashboardWidget[];
}

interface WidgetResult {
  columns: ChartColumn[];
  rows: unknown[][];
  error?: string;
}

interface DashboardData {
  dashboard: Dashboard | null;
  results: Record<string, WidgetResult>;
}

const TABLE_ROW_CAP = 100;

function ChartCard({ widget, result }: { widget: DashboardWidget; result: WidgetResult }) {
  const config: ChartConfig = useMemo(
    () => ({ kind: widget.kind as ChartConfig['kind'], x: widget.x, y: widget.y ?? [] }),
    [widget.kind, widget.x, widget.y],
  );
  const option = useMemo(() => {
    if (result.error || result.rows.length === 0) { return null; }
    const data = buildChartData(result.columns, result.rows, config);
    return buildChartOption(config, data, currentChartColors());
  }, [config, result]);

  if (result.error) { return <div className="dash-card-error">{result.error}</div>; }
  if (!option) { return <div className="dash-card-empty">{t('No numeric column to visualize')}</div>; }
  return <EChart option={option} className="dash-chart" />;
}

function TableCard({ result }: { result: WidgetResult }) {
  if (result.error) { return <div className="dash-card-error">{result.error}</div>; }
  if (result.rows.length === 0) { return <div className="dash-card-empty">{t('No rows')}</div>; }
  const rows = result.rows.slice(0, TABLE_ROW_CAP);
  return (
    <div className="dash-table-wrap">
      <table className="dash-table">
        <thead>
          <tr>{result.columns.map((c, i) => <th key={`${c.name}-${i}`}>{c.name}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>
              {result.columns.map((_, c) => (
                <td key={c}>{row[c] === null || row[c] === undefined ? '' : String(row[c])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function DashboardView({ instanceId = 'default' }: { instanceId?: string }) {
  const [data, setData] = useState<DashboardData>({ dashboard: null, results: {} });
  const [refreshing, setRefreshing] = useState(false);

  const post = useCallback((message: any) => postMessage({ ...message, instanceId }), [instanceId]);

  useEffect(() => {
    post({ type: 'ready' });
    const unsub = onMessage((msg: any) => {
      if (!msg || msg.instanceId !== instanceId) { return; }
      if (msg.type === 'dashboardData') {
        setData({ dashboard: msg.data?.dashboard ?? null, results: msg.data?.results ?? {} });
        setRefreshing(false);
      }
    });
    return unsub;
  }, [instanceId, post]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    post({ type: 'dashboardRefresh' });
  }, [post]);

  const handleRemove = useCallback((widgetId: string) => {
    post({ type: 'dashboardRemoveWidget', widgetId });
  }, [post]);

  const widgets = data.dashboard?.widgets ?? [];

  return (
    <div className="dashboard">
      <div className="dashboard-toolbar">
        <div className="dashboard-title">
          <Icon name="chart" size={14} />
          <span>{data.dashboard?.name ?? t('Dashboard')}</span>
          <span className="dashboard-count">{widgets.length}</span>
        </div>
        <div className="dashboard-toolbar-right">
          <button className="dash-btn" onClick={handleRefresh} disabled={refreshing}>
            <Icon name="refresh" size={12} /> {refreshing ? t('Loading...') : t('Refresh')}
          </button>
        </div>
      </div>

      {widgets.length === 0 ? (
        <div className="dashboard-empty">
          <Icon name="chart" size={36} strokeWidth={1.2} />
          <p>{t('No widgets yet')}</p>
          <p className="dashboard-empty-hint">{t('Run a query, then use "Add to Dashboard" to add a card here.')}</p>
        </div>
      ) : (
        <div className="dashboard-grid">
          {widgets.map(widget => (
            <div className="dash-card" key={widget.id}>
              <div className="dash-card-head">
                <span className="dash-card-title" title={widget.sql}>{widget.title}</span>
                <button className="dash-card-remove" title={t('Remove')} onClick={() => handleRemove(widget.id)}>
                  <Icon name="close" size={11} />
                </button>
              </div>
              <div className="dash-card-body">
                {widget.kind === 'table'
                  ? <TableCard result={data.results[widget.id] ?? { columns: [], rows: [] }} />
                  : <ChartCard widget={widget} result={data.results[widget.id] ?? { columns: [], rows: [] }} />}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
