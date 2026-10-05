import React, { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([BarChart, LineChart, PieChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

export interface EChartProps {
  option: unknown;
  className?: string;
  /** Called once with the ECharts instance (e.g. to export a PNG later). */
  onReady?: (instance: echarts.ECharts) => void;
}

/** Thin ECharts wrapper: init once, update on option change, resize with the box. */
export default function EChart({ option, className, onReady }: EChartProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!hostRef.current) { return; }
    if (!chartRef.current) {
      chartRef.current = echarts.init(hostRef.current);
      onReady?.(chartRef.current);
    }
    chartRef.current.setOption(option as never, true);
    const observer = new ResizeObserver(() => chartRef.current?.resize());
    observer.observe(hostRef.current);
    return () => observer.disconnect();
  }, [option, onReady]);

  useEffect(() => () => {
    chartRef.current?.dispose();
    chartRef.current = null;
  }, []);

  return <div ref={hostRef} className={className} style={{ width: '100%', height: '100%' }} />;
}
