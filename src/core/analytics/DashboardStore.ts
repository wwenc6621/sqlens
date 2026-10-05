import * as fs from 'fs';
import * as path from 'path';

export type DashboardWidgetKind = 'table' | 'bar' | 'line' | 'pie';

export interface DashboardWidget {
  id: string;
  title: string;
  connectionId: string;
  sql: string;
  kind: DashboardWidgetKind;
  /** Chart dimension column (chart widgets only). */
  x?: string;
  /** Chart measure columns (chart widgets only). */
  y?: string[];
}

export interface Dashboard {
  id: string;
  name: string;
  widgets: DashboardWidget[];
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Dashboards are stored as a single JSON file under the extension's global
 * storage, so they are shared across every project on this machine but are not
 * tied to any workspace. Dashboards are saved queries + a display hint — never
 * data — so the file holds nothing sensitive.
 */
export class DashboardStore {
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'dashboards.json');
  }

  list(): Dashboard[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (Array.isArray(parsed)) { return parsed as Dashboard[]; }
      if (parsed && Array.isArray(parsed.dashboards)) { return parsed.dashboards as Dashboard[]; }
      return [];
    } catch {
      return [];
    }
  }

  private write(list: Dashboard[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify({ version: 1, dashboards: list }, null, 2));
  }

  get(id: string): Dashboard | undefined {
    return this.list().find(d => d.id === id);
  }

  create(name: string): Dashboard {
    const list = this.list();
    const dash: Dashboard = { id: newId('dash'), name: name.trim() || 'Dashboard', widgets: [] };
    list.push(dash);
    this.write(list);
    return dash;
  }

  rename(id: string, name: string): Dashboard | undefined {
    const list = this.list();
    const dash = list.find(d => d.id === id);
    if (!dash) { return undefined; }
    dash.name = name.trim() || dash.name;
    this.write(list);
    return dash;
  }

  delete(id: string): void {
    this.write(this.list().filter(d => d.id !== id));
  }

  addWidget(dashboardId: string, widget: Omit<DashboardWidget, 'id'>): Dashboard | undefined {
    const list = this.list();
    const dash = list.find(d => d.id === dashboardId);
    if (!dash) { return undefined; }
    dash.widgets.push({ ...widget, id: newId('w') });
    this.write(list);
    return dash;
  }

  removeWidget(dashboardId: string, widgetId: string): Dashboard | undefined {
    const list = this.list();
    const dash = list.find(d => d.id === dashboardId);
    if (!dash) { return undefined; }
    dash.widgets = dash.widgets.filter(w => w.id !== widgetId);
    this.write(list);
    return dash;
  }
}
