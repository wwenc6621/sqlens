/**
 * Builds an ECharts option from shaped chart data. Pure (only reads CSS custom
 * properties for theming) so both the Chart panel and the Dashboard cards can
 * render identical charts.
 */
import type { ChartConfig, ChartData } from './chartSuggest';

export interface ChartColors {
  fg: string;
  muted: string;
  border: string;
  palette: string[];
}

/** Read a VS Code theme colour from a CSS custom property, with a fallback. */
export function cssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') { return fallback; }
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** VS Code chart colours when available; otherwise a neutral palette. */
export function chartPalette(): string[] {
  const vars = ['blue', 'green', 'yellow', 'orange', 'red', 'purple'];
  const colors = vars.map(v => cssVar(`--vscode-charts-${v}`, '')).filter(Boolean);
  return colors.length > 0
    ? colors
    : ['#4e79a7', '#59a14f', '#edc948', '#f28e2b', '#e15759', '#b07aa1'];
}

/** Resolve the current theme colours for a chart. */
export function currentChartColors(): ChartColors {
  return {
    fg: cssVar('--vscode-foreground', '#cccccc'),
    muted: cssVar('--vscode-descriptionForeground', '#8a8a8a'),
    border: cssVar('--vscode-panel-border', 'rgba(128,128,128,0.35)'),
    palette: chartPalette(),
  };
}

export function buildChartOption(config: ChartConfig, data: ChartData, colors: ChartColors): unknown {
  const { fg, muted, border, palette } = colors;

  if (config.kind === 'pie') {
    const first = data.series[0];
    return {
      color: palette,
      tooltip: { trigger: 'item' },
      legend: { type: 'scroll', textStyle: { color: fg }, bottom: 0 },
      series: [{
        type: 'pie',
        radius: ['40%', '68%'],
        center: ['50%', '46%'],
        avoidLabelOverlap: true,
        label: { color: fg },
        data: data.categories.map((name, i) => ({ name, value: first?.data[i] ?? 0 })),
      }],
    };
  }

  return {
    color: palette,
    tooltip: { trigger: 'axis' },
    legend: data.series.length > 1
      ? { type: 'scroll', textStyle: { color: fg }, top: 4 }
      : undefined,
    grid: {
      left: 8,
      right: 16,
      bottom: 8,
      top: data.series.length > 1 ? 40 : 16,
      containLabel: true,
    },
    xAxis: {
      type: 'category',
      data: data.categories,
      boundaryGap: config.kind === 'bar',
      axisLabel: { color: muted },
      axisLine: { lineStyle: { color: border } },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: muted },
      splitLine: { lineStyle: { color: border, type: 'dashed' } },
    },
    series: data.series.map(s => ({
      name: s.name,
      type: config.kind,
      data: s.data,
      smooth: config.kind === 'line',
      showSymbol: config.kind !== 'line' || data.categories.length <= 30,
      connectNulls: true,
    })),
  };
}
