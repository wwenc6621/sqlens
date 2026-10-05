import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { onMessage, postMessage } from '../../hooks/useVsCode';
import { t } from '../../i18n';
import Icon from '../../components/Icon';
import {
  suggestChart,
  buildChartData,
  numericColumnNames,
  CHART_MAX_ROWS,
  type ChartColumn,
  type ChartConfig,
  type ChartKind,
} from '../../utils/chartSuggest';
import { buildChartOption, currentChartColors } from '../../utils/chartOption';
import './ChartView.css';

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  CanvasRenderer,
]);

interface ChartPayload {
  columns: ChartColumn[];
  rows: unknown[][];
  tableName?: string;
  querySql?: string;
}

const KIND_LABEL: Record<ChartKind, string> = {
  bar: 'Bar',
  line: 'Line',
  pie: 'Pie',
};

export default function ChartView({ instanceId = 'default' }: { instanceId?: string }) {
  const [payload, setPayload] = useState<ChartPayload | null>(null);
  const [config, setConfig] = useState<ChartConfig | null>(null);
  const [valuesOpen, setValuesOpen] = useState(false);
  const [themeTick, setThemeTick] = useState(0);

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const valuesRef = useRef<HTMLDivElement | null>(null);

  const post = useCallback((message: any) => postMessage({ ...message, instanceId }), [instanceId]);

  useEffect(() => {
    post({ type: 'ready' });
    const unsub = onMessage((msg: any) => {
      if (!msg || msg.instanceId !== instanceId) { return; }
      if (msg.type === 'chartData') {
        const data = msg.data as ChartPayload;
        setPayload(data);
        setConfig(suggestChart(data.columns, data.rows));
      } else if (msg.type === 'theme') {
        setThemeTick(v => v + 1);
      }
    });
    return unsub;
  }, [instanceId, post]);

  // Close the values dropdown on outside click.
  useEffect(() => {
    if (!valuesOpen) { return; }
    const dismiss = (e: MouseEvent) => {
      if (valuesRef.current && !valuesRef.current.contains(e.target as Node)) {
        setValuesOpen(false);
      }
    };
    window.addEventListener('mousedown', dismiss);
    return () => window.removeEventListener('mousedown', dismiss);
  }, [valuesOpen]);

  // Report the current chart config so the host can reuse it if the user adds
  // this chart to a dashboard.
  useEffect(() => {
    if (config) { post({ type: 'chartState', data: { config } }); }
  }, [config, post]);

  const numericCols = useMemo(
    () => (payload ? numericColumnNames(payload.columns) : []),
    [payload],
  );

  const chartData = useMemo(
    () => (payload && config ? buildChartData(payload.columns, payload.rows, config) : null),
    [payload, config],
  );

  const option = useMemo(() => {
    if (!config || !chartData) { return null; }
    return buildChartOption(config, chartData, currentChartColors()) as any;
  }, [config, chartData, themeTick]);

  // (Re)create the ECharts instance when the option or theme changes.
  useEffect(() => {
    if (!option || !canvasRef.current) { return; }
    if (!chartRef.current) {
      chartRef.current = echarts.init(canvasRef.current, undefined, { renderer: 'canvas' });
    }
    chartRef.current.setOption(option, true);
    const instance = chartRef.current;

    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(canvasRef.current);
    return () => observer.disconnect();
  }, [option, themeTick]);

  useEffect(() => () => {
    chartRef.current?.dispose();
    chartRef.current = null;
  }, []);

  const update = useCallback((patch: Partial<ChartConfig>) => {
    setConfig(prev => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const toggleMeasure = useCallback((name: string) => {
    setConfig(prev => {
      if (!prev) { return prev; }
      const has = prev.y.includes(name);
      const next = has ? prev.y.filter(n => n !== name) : [...prev.y, name];
      if (next.length === 0) { return prev; } // keep at least one measure
      return { ...prev, y: next };
    });
  }, []);

  const exportPng = useCallback(() => {
    const instance = chartRef.current;
    if (!instance) { return; }
    const url = instance.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: 'transparent' });
    const stem = (payload?.tableName || 'chart').replace(/[^\w.-]+/g, '_') || 'chart';
    post({ type: 'saveImage', data: { base64: url, fileName: `${stem}.png` } });
  }, [payload, post]);

  if (!payload) {
    return (
      <div className="chart-view chart-empty">
        <Icon name="chart" size={28} />
        <p>{t('Preparing chart')}</p>
      </div>
    );
  }

  if (!config || numericCols.length === 0) {
    return (
      <div className="chart-view chart-empty">
        <Icon name="chart" size={28} />
        <p>{t('No numeric column to visualize')}</p>
      </div>
    );
  }

  const capped = chartData ? chartData.totalRows > CHART_MAX_ROWS : false;

  return (
    <div className="chart-view">
      <div className="chart-toolbar">
        <div className="chart-toolbar-left">
          <div className="chart-seg" role="group">
            {(['bar', 'line', 'pie'] as ChartKind[]).map(kind => (
              <button
                key={kind}
                type="button"
                className={`chart-seg-btn${config.kind === kind ? ' active' : ''}`}
                onClick={() => update({ kind })}
              >{t(KIND_LABEL[kind])}</button>
            ))}
          </div>

          {config.kind !== 'pie' && (
            <label className="chart-field">
              <span className="chart-field-label">{t('Dimension')}</span>
              <select
                className="chart-select"
                value={config.x ?? ''}
                onChange={e => update({ x: e.target.value || undefined })}
              >
                <option value="">{t('(row index)')}</option>
                {payload.columns.map(col => (
                  <option key={col.name} value={col.name}>{col.name}</option>
                ))}
              </select>
            </label>
          )}

          <div className="chart-field chart-values" ref={valuesRef}>
            <span className="chart-field-label">{t('Values')}</span>
            <button
              type="button"
              className="chart-values-btn"
              onClick={() => setValuesOpen(v => !v)}
              disabled={numericCols.length <= 1}
            >
              <span className="chart-values-text">{config.y.join(', ')}</span>
              <Icon name="chevronDown" size={12} />
            </button>
            {valuesOpen && numericCols.length > 1 && (
              <div className="chart-values-menu">
                {numericCols.map(name => (
                  <label key={name} className="chart-values-item">
                    <input
                      type="checkbox"
                      checked={config.y.includes(name)}
                      onChange={() => toggleMeasure(name)}
                    />
                    <span>{name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {capped && (
            <span className="chart-note">{t('Showing first {0} rows', CHART_MAX_ROWS)}</span>
          )}
        </div>

        <div className="chart-toolbar-right">
          <button
            type="button"
            className="toolbar-btn icon-btn"
            onClick={() => post({ type: 'addToDashboard' })}
            title={t('Add to Dashboard')}
          ><Icon name="share" /></button>
          <button
            type="button"
            className="toolbar-btn icon-btn"
            onClick={exportPng}
            title={t('Export PNG')}
          ><Icon name="download" /></button>
        </div>
      </div>

      <div className="chart-canvas" ref={canvasRef} />
    </div>
  );
}
