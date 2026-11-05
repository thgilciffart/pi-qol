import { dirname, isAbsolute, relative, sep } from 'node:path';
import type { PathMetadata, Theme } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, truncateToWidth, type Component } from '@earendil-works/pi-tui';

interface ResourceItem {
  path: string;
  enabled: boolean;
  metadata: PathMetadata;
  displayName: string;
}

interface ResourceGroup {
  label: string;
  scope: PathMetadata['scope'];
  subgroups: { items: ResourceItem[] }[];
}

type Entry = { type: 'item'; item: ResourceItem } | { type: 'group'; group: ResourceGroup } | { type: 'subgroup' };

/** Pi 1.3 resource-list internals used by the presentation adapter. */
export interface NativeResourceList extends Component {
  flatItems: Entry[];
  filteredItems: Entry[];
  selectedIndex: number;
  maxVisible: number;
  searchInput: Component & { getValue(): string };
  filterItems(query: string): void;
  findNextItem(index: number, direction: number): number;
  renderCheckbox(item: ResourceItem): string;
  getItemSuffix(item: ResourceItem): string;
  isDimmedItem(item: ResourceItem): boolean;
  onToggle?: (item: ResourceItem, enabled: boolean) => void;
}

interface TreeNode {
  name: string;
  items: ResourceItem[];
  children: Map<string, TreeNode>;
}

interface TreeRow {
  label: string;
  item?: ResourceItem;
  prefix: string;
  ancestors: number[];
  inherited?: boolean;
}

function clean(text: string): string {
  return stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

function commonDirectory(items: ResourceItem[]): string {
  let base = dirname(items[0].path);
  for (const item of items.slice(1)) {
    while (true) {
      const path = relative(base, item.path);
      if (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)) break;
      const parent = dirname(base);
      if (parent === base) break;
      base = parent;
    }
  }
  return base;
}

function tree(items: ResourceItem[], groupItems: ResourceItem[]): TreeNode {
  const root: TreeNode = { name: '', items: [], children: new Map() };
  // Settings paths have no baseDir. Use one stable root for the whole group,
  // including when search hides siblings, and retain the root folder's name.
  const base = groupItems[0].metadata.baseDir ?? dirname(commonDirectory(groupItems));
  for (const item of items) {
    const parts = relative(base, item.path).split(sep).filter(Boolean);
    let node = root;
    for (const name of parts) {
      if (!node.children.has(name)) node.children.set(name, { name, items: [], children: new Map() });
      node = node.children.get(name)!;
    }
    node.items.push(item);
  }
  return root;
}

function appendTree(rows: TreeRow[], node: TreeNode, prefix: string, ancestors: number[]): void {
  const children = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
  children.forEach((child, index) => {
    const last = index === children.length - 1;
    const rowIndex = rows.length;
    const row = { label: child.name, prefix: prefix + (last ? '└─ ' : '├─ '), ancestors };
    if (child.items.length) rows.push(...child.items.map(item => ({ ...row, item })));
    else rows.push(row);
    appendTree(rows, child, prefix + (last ? '   ' : '│  '), [...ancestors, rowIndex]);
  });
}

function groupRows(group: ResourceGroup, items: ResourceItem[]): TreeRow[] {
  const groupItems = group.subgroups.flatMap(subgroup => subgroup.items);
  if (groupItems.length === 1 && items[0]?.metadata.origin === 'package') {
    const item = items[0];
    return [{ label: group.label, item, prefix: '', ancestors: [] }];
  }
  const rows: TreeRow[] = [{ label: group.label, prefix: '', ancestors: [], inherited: group.scope === 'user' }];
  appendTree(rows, tree(items, groupItems), '', [0]);
  return rows;
}

function visibleRows(entries: Entry[]): TreeRow[] {
  const rows: TreeRow[] = [];
  let group: ResourceGroup | undefined;
  let items: ResourceItem[] = [];
  const flush = () => {
    if (!group || !items.length) return;
    const offset = rows.length;
    rows.push(...groupRows(group, items).map(row => ({ ...row, ancestors: row.ancestors.map(index => index + offset) })));
  };
  for (const entry of entries) {
    if (entry.type === 'group') { flush(); group = entry.group; items = []; }
    else if (entry.type === 'item') items.push(entry.item);
  }
  flush();
  return rows;
}

export function compactResourceList(list: NativeResourceList, theme: Pick<Theme, 'fg' | 'bold'>, project = false): void {
  // Match native keyboard navigation to the displayed tree's depth-first order.
  const entries = list.flatItems;
  const ordered: Entry[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.type !== 'group') continue;
    const items: ResourceItem[] = [];
    for (let next = index + 1; next < entries.length && entries[next].type !== 'group'; next++) {
      const child = entries[next];
      if (child.type === 'item') {
        items.push(child.item);
        // Single-row packages are searchable by source as well as file path.
        if (child.item.metadata.origin === 'package') child.item.displayName += ` ${child.item.metadata.source}`;
      }
    }
    ordered.push(entry, ...groupRows(entry.group, items).flatMap(row => row.item ? [{ type: 'item' as const, item: row.item }] : []));
  }
  list.flatItems = ordered;
  list.filterItems(list.searchInput.getValue());

  const onToggle = list.onToggle;
  list.onToggle = (item, enabled) => {
    list.selectedIndex = list.findNextItem(list.selectedIndex, 1);
    onToggle?.(item, enabled);
  };

  list.render = width => {
    const lines = [...list.searchInput.render(width), ''];
    const rows = visibleRows(list.filteredItems);
    if (!rows.length) return [...lines, theme.fg('muted', '  No extensions found')];
    const selected = list.filteredItems[list.selectedIndex];
    const selectedItem = selected?.type === 'item' ? selected.item : undefined;
    const active = Math.max(0, rows.findIndex(row => row.item === selectedItem));
    const budget = Math.max(1, list.maxVisible);
    let start = Math.max(0, Math.min(active - Math.floor(budget / 2), rows.length - budget));
    let context = rows[start].ancestors.filter(index => index < start).slice(0, budget - 1);
    if (active >= start + budget - context.length) {
      start = active;
      context = rows[start].ancestors.slice(0, budget - 1);
    }
    const indices = [...context, ...rows.slice(start, start + budget - context.length).map((_row, index) => start + index)];
    for (const index of indices) {
      const row = rows[index];
      const cursor = row.item && row.item === selectedItem ? '> ' : '  ';
      let label = clean(row.label);
      if (row.item === selectedItem) label = theme.bold(label);
      if (row.item) {
        if (list.isDimmedItem(row.item)) label = theme.fg('dim', label);
        lines.push(truncateToWidth(`${cursor}${row.prefix}${list.renderCheckbox(row.item)} ${label}${list.getItemSuffix(row.item)}`, width, '…'));
      } else {
        const inherited = project && row.inherited;
        if (inherited) label += ' · inherited global';
        lines.push(truncateToWidth(`  ${row.prefix}${theme.fg(inherited ? 'dim' : 'accent', label)}`, width, '…'));
      }
    }
    if (indices.length < rows.length) {
      const items = list.filteredItems.filter(entry => entry.type === 'item');
      lines.push(truncateToWidth(theme.fg('dim', `  (${items.findIndex(entry => entry.type === 'item' && entry.item === selectedItem) + 1}/${items.length})`), width, ''));
    }
    return lines;
  };
}
