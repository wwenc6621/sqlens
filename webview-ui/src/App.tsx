import React from 'react';
import ConnectionForm from './panels/ConnectionForm/ConnectionForm';
import ConnectionImportWizard from './panels/ConnectionImportWizard/ConnectionImportWizard';
import PanelHost from './components/PanelHost';
import StructureView from './panels/StructureView/StructureView';
import ERDiagram from './panels/ERDiagram/ERDiagram';
import QueryPlanView from './panels/QueryPlan/QueryPlanView';
import QuickView from './panels/QuickView/QuickView';
import CreateTable from './panels/CreateTable/CreateTable';
import SchemaPanel from './panels/Schema/SchemaPanel';
import ChartView from './panels/Chart/ChartView';
import DashboardView from './panels/Dashboard/DashboardView';

declare global {
  interface Window {
    __PANEL_TYPE__: string;
  }
}

export default function App() {
  const panelType = window.__PANEL_TYPE__ || 'connectionForm';

  switch (panelType) {
    case 'connectionForm':
      return <ConnectionForm />;
    case 'importWizard':
      return <ConnectionImportWizard />;
    case 'dataGrid':
      return <PanelHost />;
    case 'structureView':
      return <StructureView />;
    case 'createTable':
      return <CreateTable />;
    case 'erDiagram':
      return <ERDiagram />;
    case 'queryPlan':
      return <QueryPlanView />;
    case 'quickView':
      return <QuickView />;
    case 'schema':
      return <SchemaPanel />;
    case 'chart':
      return <ChartView />;
    case 'dashboard':
      return <DashboardView />;
    default:
      return <div style={{ padding: 20, color: 'var(--vscode-foreground)' }}>Unknown panel: {panelType}</div>;
  }
}
