import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onMessage, postMessage } from '../../hooks/useVsCode';
import Icon from '../../components/Icon';
import type { IconName } from '../../components/Icon';
import { t } from '../../i18n';
import { matchTableFilter } from './schemaTableFilter';
import './SchemaPanel.css';

/**
 * Schema sidebar panel.
 *
 * This replaces the native TreeView, which cannot host an inline filter box or
 * an in-place rename. Table/column data still comes from the extension host
 * (`SchemaTreeProvider`); this component renders it and owns the interaction
 * state: expansion, selection, filtering, renaming and the context menu.
 */

type SchemaNodeKind = 'schemaGroup' | 'tableGroup' | 'table' | 'redisKey' | 'column';

interface SchemaNode {
  id: string;
  kind: SchemaNodeKind;
  label: string;
  description?: string;
  connectionId: string;
  schema?: string;
  groupType?: 'tables' | 'views';
  collapsible: boolean;
  tableInfo?: {
    name: string;
    type: string;
    schema?: string;
    engine?: string;
    rowCount?: number;
    dataSize?: number;
    comment?: string;
  };
  redis?: { keyName: string; keyType: string; ttl: number; size: number };
  column?: {
    dataType: string;
    nullable: boolean;
    isPrimaryKey: boolean;
    isUnique: boolean;
    isAutoIncrement: boolean;
    isForeignKey: boolean;
    maxLength?: number;
    defaultValue?: string;
    comment?: string;
  };
}

interface SchemaCapabilities {
  hasConnection: boolean;
  connectionId: string;
  connectionName: string;
  database: string;
  driverType: string;
  relational: boolean;
  redis: boolean;
}

interface MenuEntry {
  /** Command id, or 'divider' for a separator line. */
  command: string;
  label: string;
  danger?: boolean;
}

function iconFor(node: SchemaNode): IconName {
  switch (node.kind) {
    case 'schemaGroup':
      return 'database';
    case 'tableGroup':
      return node.groupType === 'views' ? 'eye' : 'table';
    case 'redisKey':
      return 'key';
    case 'column':
      if (node.column?.isPrimaryKey) { return 'key'; }
      if (node.column?.isForeignKey) { return 'link'; }
      return 'columns';
    case 'table':
    default: {
      const type = node.tableInfo?.type;
      return type === 'view' || type === 'materializedView' ? 'eye' : 'table';
    }
  }
}

/** Context-menu entries for a node — mirrors the old TreeView menu contributions. */
function menuFor(node: SchemaNode, caps: SchemaCapabilities | null): MenuEntry[] {
  if (node.kind === 'redisKey') {
    return [{ command: 'sqlens.openTable', label: t('Open Key') }];
  }
  if (node.kind !== 'table') { return []; }

  const isView = node.tableInfo?.type !== 'table';
  const entries: MenuEntry[] = [{ command: 'sqlens.openTable', label: t('Open Table') }];
  if (isView) { return entries; }

  const relational = !!caps?.relational;
  if (relational) {
    entries.push(
      { command: 'divider', label: '' },
      { command: 'sqlens.openStructure', label: t('View Structure') },
      { command: 'sqlens.showDDL', label: t('Show DDL') },
    );
  }
  entries.push({ command: 'sqlens.copyCreateTable', label: t('Copy CREATE TABLE') });
  if (relational) {
    entries.push({ command: 'sqlens.generateTestData', label: t('Generate Test Data') });
  }
  entries.push(
    { command: 'sqlens.exportData', label: t('Export Data') },
    { command: 'sqlens.importData', label: t('Import Data') },
  );
  if (relational) {
    entries.push(
      { command: 'divider', label: '' },
      { command: 'sqlens.renameTable', label: t('Rename') },
      { command: 'divider', label: '' },
      { command: 'sqlens.truncateTable', label: t('Truncate Table'), danger: true },
      { command: 'sqlens.dropTable', label: t('Drop Table'), danger: true },
    );
  }
  return entries;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(1)}M`; }
  if (n >= 1_000) { return `${(n / 1_000).toFixed(1)}K`; }
  return String(n);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) { return `${(bytes / 1_073_741_824).toFixed(1)} GB`; }
  if (bytes >= 1_048_576) { return `${(bytes / 1_048_576).toFixed(1)} MB`; }
  if (bytes >= 1_024) { return `${(bytes / 1_024).toFixed(1)} KB`; }
  return `${bytes} B`;
}

interface TooltipContent {
  title: string;
  badges?: string[];
  rows: Array<[string, string]>;
  hint?: string;
}

/**
 * Hover details for a node — the same information the native tree used to show,
 * rebuilt from the payload. Groups have nothing to add beyond their label, so
 * they get no tooltip.
 */
function tooltipFor(node: SchemaNode): TooltipContent | undefined {
  if (node.kind === 'table') {
    const info = node.tableInfo;
    const isView = !!info && info.type !== 'table';
    const rows: Array<[string, string]> = [];
    if (info?.schema) { rows.push([t('Schema'), info.schema]); }
    if (isView) { rows.push([t('Type'), info!.type]); }
    if (info?.rowCount !== undefined) { rows.push([t('Rows'), formatCount(info.rowCount)]); }
    if (info?.dataSize) { rows.push([t('Size'), formatBytes(info.dataSize)]); }
    if (info?.engine) { rows.push([t('Engine'), info.engine]); }
    if (info?.comment) { rows.push([t('Comment'), info.comment]); }
    return {
      title: node.label,
      rows,
      hint: isView ? undefined : t('Double-click to open the table'),
    };
  }

  if (node.kind === 'column' && node.column) {
    const column = node.column;
    const badges: string[] = [];
    if (column.isPrimaryKey) { badges.push(t('Primary Key')); }
    if (column.isForeignKey) { badges.push(t('Foreign Key')); }
    if (column.isUnique) { badges.push(t('Unique')); }
    if (column.isAutoIncrement) { badges.push(t('Auto Increment')); }

    const rows: Array<[string, string]> = [
      [t('Type'), column.dataType],
      [t('Nullable'), column.nullable ? t('YES') : t('NO')],
    ];
    if (column.defaultValue !== undefined) { rows.push([t('Default Value'), column.defaultValue]); }
    if (column.maxLength) { rows.push([t('Length'), String(column.maxLength)]); }
    if (column.comment) { rows.push([t('Comment'), column.comment]); }
    return { title: node.label, badges, rows };
  }

  if (node.kind === 'redisKey' && node.redis) {
    const { keyType, ttl, size } = node.redis;
    const ttlText = ttl === -1 ? '∞' : ttl < 0 ? '?' : `${ttl}s`;
    const rows: Array<[string, string]> = [
      [t('Type'), keyType],
      [t('TTL'), ttlText],
    ];
    if (size > 0) { rows.push([t('Size'), `${size} B`]); }
    return { title: node.label, rows, hint: t('Double-click to open entries') };
  }

  return undefined;
}

/** Client-side mirror of the extension's rename validation. */
function validateTableName(value: string, current: string): string | undefined {
  const name = value.trim();
  if (!name) { return t('Table name cannot be empty.'); }
  if (name === current) { return t('Enter a different name.'); }
  if (!/^[\w$]+$/.test(name)) { return t('Use letters, digits, underscore or $ only.'); }
  return undefined;
}

interface FlatRow {
  node: SchemaNode;
  depth: number;
  /** While filtering: how many children survived the filter. */
  matched?: number;
  /** While filtering: how many children the group has in total. */
  total?: number;
}

export default function SchemaPanel() {
  const [capabilities, setCapabilities] = useState<SchemaCapabilities | null>(null);
  const [nodeMap, setNodeMap] = useState<Map<string, SchemaNode>>(new Map());
  const [childMap, setChildMap] = useState<Map<string, string[]>>(new Map());
  const [rootIds, setRootIds] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [menu, setMenu] = useState<{ x: number; y: number; node: SchemaNode } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string; original: string; error?: string } | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [revealTarget, setRevealTarget] = useState<string | null>(null);
  const [hover, setHover] = useState<{ node: SchemaNode; x: number; y: number; above: boolean } | null>(null);

  // Mirrors used inside handlers so they never read stale state.
  const childMapRef = useRef(childMap);
  const pendingRef = useRef(new Set<string>());
  const renameRequestRef = useRef<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const filterInputRef = useRef<HTMLInputElement | null>(null);
  const connectionIdRef = useRef('');
  const filterOpenRef = useRef(false);
  /** Groups the user collapsed on purpose; they are never auto-expanded again. */
  const collapsedByUserRef = useRef(new Set<string>());
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  childMapRef.current = childMap;
  filterOpenRef.current = filterOpen;

  const filterActive = filter.trim().length > 0;

  /**
   * Table/view groups start expanded (the native tree used
   * `TreeItemCollapsibleState.Expanded` too), so the object list is visible
   * without a first click. Groups the user collapsed explicitly stay collapsed.
   */
  const autoExpandGroups = useCallback((nodes: SchemaNode[]) => {
    const ids = nodes
      .filter(n => n.kind === 'tableGroup' && n.collapsible && !collapsedByUserRef.current.has(n.id))
      .map(n => n.id);
    if (ids.length === 0) { return; }
    setExpanded(prev => {
      const next = new Set(prev);
      for (const id of ids) { next.add(id); }
      return next;
    });
  }, []);

  // ── Extension messages ────────────────────────────────────────────────────

  useEffect(() => {
    postMessage({ type: 'ready' });

    return onMessage((msg: any) => {
      if (!msg || typeof msg !== 'object') { return; }

      if (msg.type === 'schemaRoot') {
        // Sent on first paint and after every invalidation. Expansion and
        // selection are intentionally preserved so a refresh in the background
        // does not move the user's place.
        const nodes: SchemaNode[] = msg.data?.nodes || [];
        const nextConnectionId = msg.data?.capabilities?.connectionId ?? '';
        // A different connection means every node id is about to change, so the
        // expand/selection/filter state has to go too.
        if (nextConnectionId !== connectionIdRef.current) {
          connectionIdRef.current = nextConnectionId;
          setExpanded(new Set());
          setSelectedId(null);
          setRenaming(null);
          setFilter('');
          collapsedByUserRef.current = new Set();
        }
        setCapabilities(msg.data?.capabilities || null);
        setLoadError(msg.data?.error);
        setNodeMap(new Map(nodes.map(n => [n.id, n])));
        setChildMap(new Map());
        childMapRef.current = new Map();
        setRootIds(nodes.map(n => n.id));
        pendingRef.current = new Set();
        setLoading(false);
        autoExpandGroups(nodes);
        return;
      }

      if (msg.type === 'schemaInvalidate') {
        postMessage({ type: 'schemaLoadRoot' });
        return;
      }

      if (msg.type === 'schemaChildren') {
        const parentId = msg.data?.parentId as string;
        const nodes: SchemaNode[] = msg.data?.nodes || [];
        pendingRef.current.delete(parentId);
        setNodeMap(prev => {
          const next = new Map(prev);
          for (const node of nodes) { next.set(node.id, node); }
          return next;
        });
        setChildMap(prev => {
          const next = new Map(prev);
          next.set(parentId, nodes.map(n => n.id));
          // Keep the mirror in sync immediately: the load-dedupe check reads it
          // before React has re-rendered.
          childMapRef.current = next;
          return next;
        });
        // A schema group (PostgreSQL) expands into table groups, which start
        // expanded as well.
        autoExpandGroups(nodes);
        return;
      }

      if (msg.type === 'schemaCommandResult') {
        if (msg.data?.requestId && msg.data.requestId === renameRequestRef.current) {
          renameRequestRef.current = null;
          const result = msg.data.result;
          if (result && result.ok === false) {
            setRenaming(prev => prev ? { ...prev, error: result.error } : prev);
          } else {
            setRenaming(null);
          }
        }
        return;
      }

      if (msg.type === 'schemaFocusFilter') {
        // The title-bar button toggles the inline box, like the Explorer's
        // search action does.
        const next = !filterOpenRef.current;
        if (!next) { setFilter(''); }
        setFilterOpen(next);
        if (next) { requestAnimationFrame(() => filterInputRef.current?.focus()); }
        return;
      }

      if (msg.type === 'schemaClearFilter') {
        setFilter('');
        return;
      }

      if (msg.type === 'schemaReveal') {
        setRevealTarget(String(msg.data?.name || ''));
        return;
      }
    });
  }, []);

  // ── Loading ───────────────────────────────────────────────────────────────

  const requestChildren = useCallback((node: SchemaNode) => {
    // An entry in `childMap` (even an empty array) means the children were
    // already fetched — including nodes that legitimately have none.
    if (childMapRef.current.has(node.id) || pendingRef.current.has(node.id)) { return; }
    pendingRef.current.add(node.id);
    postMessage({ type: 'schemaLoadChildren', data: { requestId: node.id, node } });
  }, []);

  const toggleExpand = useCallback((node: SchemaNode) => {
    const willExpand = !expanded.has(node.id);
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(node.id)) { next.delete(node.id); } else { next.add(node.id); }
      return next;
    });
    // Remember the user's intent so a later refresh does not fight it.
    if (willExpand) {
      collapsedByUserRef.current.delete(node.id);
      requestChildren(node);
    } else {
      collapsedByUserRef.current.add(node.id);
    }
  }, [expanded, requestChildren]);

  // Expanded rows must be re-fetched after an invalidation cleared the caches;
  // this also covers the initial expand.
  useEffect(() => {
    for (const id of expanded) {
      const node = nodeMap.get(id);
      if (node?.collapsible && !childMap.has(id)) { requestChildren(node); }
    }
  }, [nodeMap, childMap, expanded, requestChildren]);

  // While filtering, every group has to be loaded so matches can be found in
  // collapsed branches too.
  useEffect(() => {
    if (!filterActive) { return; }
    for (const node of nodeMap.values()) {
      if ((node.kind === 'tableGroup' || node.kind === 'schemaGroup') && !childMap.has(node.id)) {
        requestChildren(node);
      }
    }
  }, [filterActive, nodeMap, childMap, requestChildren]);

  // ── Reveal (MCP action follow) ────────────────────────────────────────────

  useEffect(() => {
    if (!revealTarget) { return; }

    let waiting = false;
    for (const node of nodeMap.values()) {
      if ((node.kind === 'tableGroup' || node.kind === 'schemaGroup') && !childMap.has(node.id)) {
        requestChildren(node);
        waiting = true;
      }
    }
    if (waiting) { return; }

    const target = [...nodeMap.values()].find(n => n.kind === 'table' && n.label === revealTarget);
    setRevealTarget(null);
    if (!target) { return; }

    const ancestors: string[] = [];
    let cursor = target.id;
    for (;;) {
      let parent: string | undefined;
      for (const [parentId, kids] of childMapRef.current) {
        if (kids.includes(cursor)) { parent = parentId; break; }
      }
      if (!parent) { break; }
      ancestors.unshift(parent);
      cursor = parent;
    }

    setExpanded(prev => {
      const next = new Set(prev);
      for (const id of ancestors) { next.add(id); }
      return next;
    });
    setSelectedId(target.id);
    setFlashId(target.id);
    setTimeout(() => setFlashId(null), 1600);
    requestAnimationFrame(() => {
      rowRefs.current.get(target.id)?.scrollIntoView({ block: 'center' });
    });
  }, [revealTarget, nodeMap, requestChildren]);

  // ── Rows ──────────────────────────────────────────────────────────────────

  const rows = useMemo<FlatRow[]>(() => {
    const out: FlatRow[] = [];

    /** Emit a node and, when expanded, everything below it (no filtering). */
    const walkPlain = (ids: string[], depth: number) => {
      for (const id of ids) {
        const node = nodeMap.get(id);
        if (!node) { continue; }
        out.push({ node, depth });
        if (node.collapsible && expanded.has(id)) {
          walkPlain(childMap.get(id) || [], depth + 1);
        }
      }
    };

    if (!filterActive) {
      walkPlain(rootIds, 0);
      return out;
    }

    const walkFiltered = (ids: string[], depth: number): number => {
      let matchedTotal = 0;
      for (const id of ids) {
        const node = nodeMap.get(id);
        if (!node) { continue; }

        // The filter only ever matches table/view names, exactly like the
        // native view did.
        if (node.kind === 'table') {
          if (!matchTableFilter(node.label, node.schema, filter)) { continue; }
          out.push({ node, depth });
          matchedTotal += 1;
          // Columns are not filter targets, but an expanded match must still
          // show them — otherwise expanding a filtered table looks broken.
          if (expanded.has(id)) {
            walkPlain(childMap.get(id) || [], depth + 1);
          }
          continue;
        }

        const insertAt = out.length;
        const matched = walkFiltered(childMap.get(id) || [], depth + 1);
        if (matched > 0) {
          out.splice(insertAt, 0, { node, depth, matched, total: (childMap.get(id) || []).length });
          matchedTotal += matched;
        }
      }
      return matchedTotal;
    };

    walkFiltered(rootIds, 0);
    return out;
  }, [filterActive, filter, nodeMap, childMap, rootIds, expanded]);

  const totalTables = useMemo(
    () => [...nodeMap.values()].filter(n => n.kind === 'table').length,
    [nodeMap],
  );
  const matchedTables = useMemo(
    () => (filterActive ? rows.filter(r => r.node.kind === 'table').length : totalTables),
    [filterActive, rows, totalTables],
  );

  // ── Hover tooltip ─────────────────────────────────────────────────────────

  const hideTooltip = useCallback(() => {
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); }
    hoverTimerRef.current = undefined;
    setHover(null);
  }, []);

  const showTooltip = useCallback((event: React.MouseEvent<HTMLDivElement>, node: SchemaNode) => {
    if (!tooltipFor(node)) { return; }
    const rect = event.currentTarget.getBoundingClientRect();
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); }
    // A short delay keeps the tooltip from flashing while moving the mouse
    // across the tree.
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = undefined;
      const below = window.innerHeight - rect.bottom;
      const flip = below < 170 && rect.top > below;
      setHover({
        node,
        x: Math.max(4, Math.min(rect.left, window.innerWidth - 280)),
        y: flip ? rect.top - 6 : rect.bottom + 4,
        above: flip,
      });
    }, 400);
  }, []);

  useEffect(() => () => {
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); }
  }, []);

  // A tooltip pinned to a row must not survive a focus change either.
  useEffect(() => {
    if (!hover) { return; }
    const close = () => setHover(null);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
    };
  }, [hover]);

  // ── Actions ───────────────────────────────────────────────────────────────

  const postCommand = useCallback((command: string, node: SchemaNode, extra?: Record<string, unknown>) => {
    const requestId = `c${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
    postMessage({
      type: 'schemaRunCommand',
      data: {
        requestId,
        command,
        item: { connectionId: node.connectionId, tableInfo: node.tableInfo, ...extra },
      },
    });
    return requestId;
  }, []);

  const startRename = useCallback((node: SchemaNode) => {
    hideTooltip();
    setSelectedId(node.id);
    setRenaming({ id: node.id, value: node.label, original: node.label });
  }, [hideTooltip]);

  const commitRename = useCallback((node: SchemaNode) => {
    if (!renaming || renaming.id !== node.id) { return; }
    const value = renaming.value.trim();
    const invalid = validateTableName(value, renaming.original);
    if (invalid) {
      setRenaming(prev => prev ? { ...prev, error: invalid } : prev);
      return;
    }
    renameRequestRef.current = postCommand('sqlens.renameTable', node, { newName: value });
  }, [renaming, postCommand]);

  const openNode = useCallback((node: SchemaNode) => {
    if (node.kind === 'table' || node.kind === 'redisKey') {
      postCommand('sqlens.openTable', node);
    }
  }, [postCommand]);

  const openMenu = useCallback((event: React.MouseEvent, node: SchemaNode) => {
    event.preventDefault();
    event.stopPropagation();
    if (menuFor(node, capabilities).length === 0) { return; }
    setSelectedId(node.id);
    // The sidebar is narrow: keep the menu inside the viewport instead of
    // letting it spill over the editor.
    const MENU_WIDTH = 200;
    const MENU_HEIGHT = 320;
    const x = Math.max(4, Math.min(event.clientX, window.innerWidth - MENU_WIDTH - 4));
    const y = Math.max(4, Math.min(event.clientY, window.innerHeight - MENU_HEIGHT - 4));
    hideTooltip();
    setMenu({ x, y, node });
  }, [capabilities, hideTooltip]);

  const handleMenuAction = useCallback((command: string, node: SchemaNode) => {
    setMenu(null);
    if (command === 'sqlens.renameTable') {
      startRename(node);
      return;
    }
    postCommand(command, node);
  }, [postCommand, startRename]);

  // Dismiss the context menu on anything that would leave it stranded: a click
  // anywhere else, the webview losing focus (clicking the editor or another
  // sidebar view — the iframe never sees those clicks), Escape, scrolling or a
  // resize.
  useEffect(() => {
    if (!menu) { return; }
    const close = () => setMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { close(); }
    };
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('visibilitychange', close);
    return () => {
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('visibilitychange', close);
    };
  }, [menu]);

  // ── Render ────────────────────────────────────────────────────────────────

  const emptyState = (() => {
    if (loading) { return t('Loading table list...'); }
    if (loadError) { return loadError; }
    if (!capabilities?.hasConnection) {
      return `${t('No active connection')}\n${t('Connect to a database to browse its tables.')}`;
    }
    if (rows.length === 0) { return filterActive ? t('No matches') : t('No tables'); }
    return null;
  })();

  return (
    <div className="schema-panel">
      {/* The title, filter, new-table and refresh actions live in the native
          view title bar (see `view/title` in package.json). Only the expanded
          inline filter box stays in the webview, so it can sit right under the
          title without a modal dialog. */}
      {filterOpen && (
        <div className="sc-filter-row">
          <Icon name="search" size={12} className="sc-fold-icon" />
          <input
            ref={filterInputRef}
            className="sc-filter-input"
            type="text"
            autoFocus
            placeholder={t('Filter tables...')}
            aria-label={t('Filter tables...')}
            value={filter}
            onChange={event => setFilter(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                setFilter('');
                setFilterOpen(false);
              }
            }}
          />
          {filterActive && (
            <span className="sc-filter-count">{t('{0} of {1}', matchedTables, totalTables)}</span>
          )}
          <button
            type="button"
            className="sc-fold-btn"
            title={t('Cancel')}
            aria-label={t('Cancel')}
            onClick={() => {
              setFilter('');
              setFilterOpen(false);
            }}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      )}

      <div className="sc-tree" role="tree" onContextMenu={event => event.preventDefault()}>
        {emptyState ? (
          <div className="sc-empty">
            {emptyState.split('\n').map((line, index) => <p key={index}>{line}</p>)}
          </div>
        ) : (
          rows.map(({ node, depth, matched, total }) => {
            const isLeafEntry = node.kind === 'table' || node.kind === 'redisKey';
            // While filtering, groups are force-expanded so matches are visible;
            // tables keep their own state so the chevron never lies about a
            // collapsed row.
            const isExpanded = node.collapsible && (filterActive && !isLeafEntry ? true : expanded.has(node.id));
            const isRenaming = renaming?.id === node.id;

            return (
              <div
                key={node.id}
                ref={element => {
                  if (element) { rowRefs.current.set(node.id, element); }
                  else { rowRefs.current.delete(node.id); }
                }}
                role="treeitem"
                aria-level={depth + 1}
                aria-expanded={node.collapsible ? isExpanded : undefined}
                aria-selected={selectedId === node.id}
                className={[
                  'sc-row',
                  selectedId === node.id ? 'selected' : '',
                  flashId === node.id ? 'flash' : '',
                ].filter(Boolean).join(' ')}
                style={{ paddingLeft: 4 + depth * 14 }}
                // Groups have nothing to add beyond the label, so they keep the
                // plain native tooltip; objects get the rich hover panel below.
                title={tooltipFor(node) ? undefined : (node.description || node.label)}
                onMouseEnter={event => showTooltip(event, node)}
                onMouseLeave={hideTooltip}
                onClick={() => {
                  setSelectedId(node.id);
                  if (node.collapsible && !isLeafEntry) { toggleExpand(node); }
                }}
                onDoubleClick={() => {
                  if (isLeafEntry) { openNode(node); } else { toggleExpand(node); }
                }}
                onContextMenu={event => openMenu(event, node)}
              >
                {node.collapsible ? (
                  <button
                    type="button"
                    className="sc-chevron"
                    tabIndex={-1}
                    aria-hidden="true"
                    onClick={event => {
                      event.stopPropagation();
                      toggleExpand(node);
                    }}
                  >
                    <Icon name={isExpanded ? 'chevronDown' : 'chevronRight'} size={12} />
                  </button>
                ) : (
                  <span className="sc-chevron sc-chevron-spacer" />
                )}

                <Icon name={iconFor(node)} size={13} className="sc-node-icon" />

                {isRenaming ? (
                  <span className="sc-rename">
                    <input
                      className={`sc-rename-input${renaming?.error ? ' invalid' : ''}`}
                      autoFocus
                      value={renaming?.value ?? ''}
                      aria-label={t('Rename to...')}
                      placeholder={t('Rename to...')}
                      onClick={event => event.stopPropagation()}
                      onChange={event => setRenaming(prev => prev
                        ? { ...prev, value: event.target.value, error: undefined }
                        : prev)}
                      onKeyDown={event => {
                        if (event.key === 'Enter') { commitRename(node); }
                        if (event.key === 'Escape') { setRenaming(null); }
                      }}
                      onBlur={() => { if (!renameRequestRef.current) { setRenaming(null); } }}
                    />
                    <span className="sc-rename-error">{renaming?.error || ''}</span>
                  </span>
                ) : (
                  <>
                    <span className="sc-node-label">{node.label}</span>
                    {node.description && (
                      <span className="sc-node-desc">
                        {filterActive && matched !== undefined && total !== undefined
                          ? t('{0} of {1}', matched, total)
                          : node.description}
                      </span>
                    )}
                  </>
                )}
              </div>
            );
          })
        )}
      </div>

      {hover && (() => {
        const content = tooltipFor(hover.node);
        if (!content) { return null; }
        return (
          <div
            className="sc-tooltip"
            role="tooltip"
            style={{
              left: hover.x,
              top: hover.y,
              transform: hover.above ? 'translateY(-100%)' : undefined,
            }}
          >
            <div className="sc-tooltip-title">
              <span className="sc-tooltip-name">{content.title}</span>
              {content.badges?.map(badge => (
                <span key={badge} className="sc-tooltip-badge">{badge}</span>
              ))}
            </div>
            {content.rows.map(([label, value]) => (
              <div key={label} className="sc-tooltip-row">
                <span className="sc-tooltip-key">{label}</span>
                <span className="sc-tooltip-value">{value}</span>
              </div>
            ))}
            {content.hint && <div className="sc-tooltip-hint">{content.hint}</div>}
          </div>
        );
      })()}

      {menu && (
        <>
          <div
            className="sc-menu-backdrop"
            onClick={() => setMenu(null)}
            onContextMenu={event => { event.preventDefault(); setMenu(null); }}
          />
          <div
            className="sc-menu"
            role="menu"
            style={{ left: menu.x, top: menu.y }}
            onClick={event => event.stopPropagation()}
          >

            {menuFor(menu.node, capabilities).map((entry, index) => (
              entry.command === 'divider'
                ? <div key={`divider-${index}`} className="sc-menu-divider" />
                : (
                  <button
                    key={entry.command}
                    type="button"
                    role="menuitem"
                    className={`sc-menu-item${entry.danger ? ' danger' : ''}`}
                    onClick={() => handleMenuAction(entry.command, menu.node)}
                  >
                    {entry.label}
                  </button>
                )
            ))}
          </div>
        </>
      )}
    </div>
  );
}
