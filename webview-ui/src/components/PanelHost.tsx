import React, { useCallback, useEffect, useRef, useState } from 'react';
import { onMessage, postMessage } from '../hooks/useVsCode';
import DataGrid from '../panels/DataGrid/DataGrid';
import StructureView from '../panels/StructureView/StructureView';
import CreateTable from '../panels/CreateTable/CreateTable';
import ERDiagram from '../panels/ERDiagram/ERDiagram';
import { t } from '../i18n';
import QuickView from '../panels/QuickView/QuickView';
import QueryPlanView from '../panels/QueryPlan/QueryPlanView';
import LogDetailView from '../panels/LogDetail/LogDetailView';
import AiActivityView from '../panels/AiActivity/AiActivityView';
import McpServerView from '../panels/McpServer/McpServerView';
import Icon from './Icon';
import type { IconName } from './Icon';
import './PanelHost.css';

export type PanelKind = 'dataGrid' | 'structureView' | 'createTable' | 'erDiagram' | 'quickView' | 'queryPlan' | 'logDetail' | 'aiActivity' | 'mcp';

export interface PanelTabInfo {
  id: string;
  kind: PanelKind;
  title: string;
  /** Full tooltip text, e.g. the complete SQL behind a query tab. */
  tooltip?: string;
  /** Bumped when the extension asks for a fresh panel instance. */
  token: number;
}

const KIND_META: Record<PanelKind, { icon: IconName }> = {
  dataGrid: { icon: 'table' },
  structureView: { icon: 'wrench' },
  createTable: { icon: 'plus' },
  erDiagram: { icon: 'share' },
  quickView: { icon: 'eye' },
  queryPlan: { icon: 'search' },
  logDetail: { icon: 'terminal' },
  aiActivity: { icon: 'zap' },
  mcp: { icon: 'plug' },
};

function normalizeKind(kind: unknown): PanelKind {
  switch (kind) {
    case 'structureView':
    case 'createTable':
    case 'erDiagram':
    case 'quickView':
    case 'queryPlan':
    case 'logDetail':
    case 'aiActivity':
    case 'mcp':
      return kind;
    default:
      return 'dataGrid';
  }
}

function renderPanel(tab: PanelTabInfo) {
  switch (tab.kind) {
    case 'structureView': return <StructureView instanceId={tab.id} />;
    case 'createTable': return <CreateTable instanceId={tab.id} />;
    case 'erDiagram': return <ERDiagram instanceId={tab.id} />;
    case 'quickView': return <QuickView instanceId={tab.id} />;
    case 'queryPlan': return <QueryPlanView instanceId={tab.id} />;
    case 'logDetail': return <LogDetailView instanceId={tab.id} />;
    case 'aiActivity': return <AiActivityView instanceId={tab.id} />;
    case 'mcp': return <McpServerView instanceId={tab.id} />;
    case 'dataGrid':
    default: return <DataGrid instanceId={tab.id} />;
  }
}

/**
 * Tabbed host rendered inside the Sqlens panel view.
 *
 * Tables, query results, table structure, the create-table form, ER diagrams
 * and the row quick view all live here as tabs. Messages from the extension
 * carry an `instanceId`; the first message for an unknown id creates the tab,
 * so the same object can never be opened twice while different ones coexist.
 */
export default function PanelHost() {
  const [tabs, setTabs] = useState<PanelTabInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const tabsRef = useRef<PanelTabInfo[]>([]);
  const activeIdRef = useRef<string | null>(null);
  tabsRef.current = tabs;
  activeIdRef.current = activeId;

  const removeTabLocal = useCallback((id: string) => {
    const next = tabsRef.current.filter(t => t.id !== id);
    tabsRef.current = next;
    setTabs(next);
    if (activeIdRef.current === id) {
      const nextActive = next.length > 0 ? next[next.length - 1].id : null;
      activeIdRef.current = nextActive;
      setActiveId(nextActive);
    }
  }, []);

  useEffect(() => {
    postMessage({ type: 'ready' });

    const unsub = onMessage((msg: any) => {
      if (!msg || typeof msg !== 'object') { return; }

      // Extension-initiated close (connection dropped, tab finished, ...).
      if (msg.type === 'closePanelTab') {
        if (msg.instanceId) { removeTabLocal(msg.instanceId); }
        return;
      }

      const instanceId = msg.instanceId as string | undefined;
      if (!instanceId) { return; }

      const known = tabsRef.current.some(t => t.id === instanceId);

      if (!known) {
        // Transient updates for an unknown tab are ignored; only messages that
        // carry tab metadata may create a tab.
        if (!msg.tabTitle) { return; }
        const tab: PanelTabInfo = {
          id: instanceId,
          kind: normalizeKind(msg.tabKind),
          title: String(msg.tabTitle),
          tooltip: typeof msg.querySql === 'string' && msg.querySql ? msg.querySql : undefined,
          token: 0,
        };
        const next = [...tabsRef.current, tab];
        tabsRef.current = next;
        setTabs(next);
      } else {
        const remount = msg.remount === true;
        const next = tabsRef.current.map(t => {
          if (t.id !== instanceId) { return t; }
          const title = msg.tabTitle ? String(msg.tabTitle) : t.title;
          if (!remount && title === t.title) { return t; }
          // Remounting makes the panel re-request its data from scratch.
          return { ...t, title, token: remount ? t.token + 1 : t.token };
        });
        if (next.some((t, i) => t !== tabsRef.current[i])) {
          tabsRef.current = next;
          setTabs(next);
        }
      }

      if (msg.activate === true || activeIdRef.current === null) {
        activeIdRef.current = instanceId;
        setActiveId(instanceId);
      }
    });

    return unsub;
  }, [removeTabLocal]);

  const handleClose = useCallback((id: string) => {
    removeTabLocal(id);
    postMessage({ type: 'closePanelTab', instanceId: id });
  }, [removeTabLocal]);

  // ── Tab context menu (right-click): Close / Close Others / Close All ──
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);

  useEffect(() => {
    if (!ctxMenu) { return; }
    const dismiss = () => setCtxMenu(null);
    window.addEventListener('click', dismiss);
    window.addEventListener('blur', dismiss);
    return () => {
      window.removeEventListener('click', dismiss);
      window.removeEventListener('blur', dismiss);
    };
  }, [ctxMenu]);

  const closeMany = useCallback((ids: string[]) => {
    ids.forEach(id => {
      removeTabLocal(id);
      postMessage({ type: 'closePanelTab', instanceId: id });
    });
  }, [removeTabLocal]);

  const handleCtxCommand = useCallback((command: 'close' | 'closeOthers' | 'closeAll', tabId: string) => {
    setCtxMenu(null);
    const current = tabsRef.current;
    if (command === 'close') {
      closeMany([tabId]);
    } else if (command === 'closeOthers') {
      closeMany(current.filter(x => x.id !== tabId).map(x => x.id));
    } else {
      closeMany(current.map(x => x.id));
    }
  }, [closeMany]);

  const menuTabId = ctxMenu?.tabId ?? null;
  const canCloseOthers = tabs.filter(x => x.id !== menuTabId).length > 0;

  return (
    <div className="panel-host">
      {tabs.length > 0 && (
        <div className="panel-tabs" role="tablist">
          {tabs.map(tab => (
            <div
              key={tab.id}
              role="tab"
              aria-selected={tab.id === activeId}
              className={`panel-tab${tab.id === activeId ? ' active' : ''}`}
              onClick={() => setActiveId(tab.id)}
              onContextMenu={e => {
                e.preventDefault();
                e.stopPropagation();
                setActiveId(tab.id);
                setCtxMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
              }}
              title={tab.tooltip || tab.title}
            >
              <Icon name={KIND_META[tab.kind].icon} size={12} />
              <span className="panel-tab-label">{tab.title}</span>
              <button
                type="button"
                className="panel-tab-close"
                title={t('Close')}
                onClick={e => {
                  e.stopPropagation();
                  handleClose(tab.id);
                }}
              >
                <Icon name="close" size={11} />
              </button>
            </div>
          ))}
          {ctxMenu && (
            <div
              className="panel-tab-ctxmenu"
              style={{ left: ctxMenu.x, top: ctxMenu.y }}
              onClick={e => e.stopPropagation()}
              onContextMenu={e => e.preventDefault()}
            >
              <div className="panel-tab-ctxitem" onClick={() => handleCtxCommand('close', ctxMenu.tabId)}>{t('Close')}</div>
              <div className={`panel-tab-ctxitem${canCloseOthers ? '' : ' disabled'}`} onClick={() => canCloseOthers && handleCtxCommand('closeOthers', ctxMenu.tabId)}>{t('Close Others')}</div>
              <div className="panel-tab-ctxitem" onClick={() => handleCtxCommand('closeAll', ctxMenu.tabId)}>{t('Close All')}</div>
            </div>
          )}
        </div>
      )}

      <div className="panel-host-body">
        {tabs.length === 0 && (
          <div className="panel-host-empty">
            <img
              src={`${(typeof window !== 'undefined' && (window as any).__MEDIA_BASE__) || ''}/logo.svg`}
              width={96}
              height={96}
              alt=""
              style={{ display: 'block', margin: '0 auto 8px', objectFit: 'contain', opacity: 0.9 }}
            />
            <h3>{t('Nothing open yet')}</h3>
            <p className="text-muted">{t('Double-click a table in the Schema view, or run a query.')}</p>
          </div>
        )}
        {tabs.map(tab => (
          <div
            key={`${tab.id}:${tab.token}`}
            className={`panel-tab-pane${tab.id === activeId ? ' active' : ''}`}
          >
            {renderPanel(tab)}
          </div>
        ))}
      </div>
    </div>
  );
}
