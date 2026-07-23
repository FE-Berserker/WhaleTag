import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Backdrop,
  Box,
  Button,
  CircularProgress,
  Divider,
  IconButton,
  InputAdornment,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Snackbar,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import SaveIcon from '@mui/icons-material/Save';
import DriveFileMoveIcon from '@mui/icons-material/DriveFileMove';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import LoginIcon from '@mui/icons-material/Login';
import ImageIcon from '@mui/icons-material/Image';
import LaunchIcon from '@mui/icons-material/Launch';
import SearchIcon from '@mui/icons-material/Search';
import CloseIcon from '@mui/icons-material/Close';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import VisibilityIcon from '@mui/icons-material/Visibility';
import UnfoldMoreIcon from '@mui/icons-material/UnfoldMore';
import UnfoldLessIcon from '@mui/icons-material/UnfoldLess';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import ReactECharts from 'echarts-for-react';
// On-demand echarts instance (Treemap + Sunburst + 5 components + Canvas +
// SVG renderers). Replaces `import * as echarts from 'echarts'` which
// pulled the full UMD distribution (~1 MB).
import { echarts } from '../services/echarts-setup';

import {
  buildTree,
  defaultNodeColor,
  toEChartsSunburst,
  toEChartsTree,
  toEChartsTreemap,
  type FilterMode,
  type FolderVizNode,
  type FolderVizType,
} from '../domain/folderviz';
import type { DirEntry } from '../../shared/ipc-types';
import type { FileCellData } from '-/components/file-cell';
import { useCurrentLocationContext } from '-/hooks/CurrentLocationContextProvider';
import { useImageExport, base64FromDataUrl, type ClipboardKind } from '-/hooks/useImageExport';
import { ipcApi } from '-/services/ipc-api';
import { formatSize, truncate } from '-/services/format';
import { useSelector } from 'react-redux';
import type { RootState } from '-/reducers';

interface FolderVizViewProps {
  /** The shared per-cell handler bag from FileList. */
  data: FileCellData;
}

// localStorage key shape: `whale.folderViz.${locationId}` → { vizType }.
// maxDepth used to live here too; H.24 R4 moved depth to the global
// `viewDepth` setting, so only vizType is persisted per-location now.
const PREFS_KEY_PREFIX = 'whale.folderViz.';

interface FolderVizPrefs {
  vizType: FolderVizType;
}

/** Read prefs from localStorage. Returns null on miss / parse error / bounds violation. */
function loadFolderVizPrefs(locationId: string): FolderVizPrefs | null {
  try {
    const raw = localStorage.getItem(PREFS_KEY_PREFIX + locationId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<FolderVizPrefs>;
    if (
      typeof parsed.vizType === 'string' &&
      (parsed.vizType === 'tree' ||
        parsed.vizType === 'radial' ||
        parsed.vizType === 'treemap' ||
        parsed.vizType === 'sunburst')
    ) {
      return { vizType: parsed.vizType };
    }
    return null;
  } catch {
    return null;
  }
}

/** Best-effort write. Swallows quota / disabled-storage errors — prefs are
 *  convenience, not core data, and we never want a save failure to break the
 *  view. */
function saveFolderVizPrefs(locationId: string, prefs: FolderVizPrefs): void {
  try {
    localStorage.setItem(
      PREFS_KEY_PREFIX + locationId,
      JSON.stringify(prefs)
    );
  } catch {
    // localStorage full / disabled (private mode) — silently ignore
  }
}

/**
 * FolderViz perspective: visualize the directory structure of the current
 * location using ECharts tree/radial/treemap/sunburst charts.
 */
export default function FolderVizView({ data }: FolderVizViewProps) {
  const { onOpen, t, readOnly } = data;
  const { currentDirectoryPath, currentLocation, navigateTo } =
    useCurrentLocationContext();
  const theme = useTheme();
  const chartRef = useRef<ReactECharts>(null);

  const [vizType, setVizType] = useState<FolderVizType>('tree');
  // H.24 R4: depth comes from the global `viewDepth` setting. `maxDepth` is a
  // debounced copy so the recursive `listDirectoryRecursive` IPC fires once
  // per settled value, not per slider tick.
  const viewDepth = useSelector((s: RootState) => s.settings?.viewDepth ?? 1);
  const [maxDepth, setMaxDepth] = useState(viewDepth);
  const [tree, setTree] = useState<FolderVizNode | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-node right-click anchor (plan §H.20 A). null = no menu open. Empty-canvas
  // right-clicks never reach this state — see `handleNodeContextMenu`.
  const [nodeCtx, setNodeCtx] = useState<{
    x: number;
    y: number;
    path: string;
    isDirectory: boolean;
    name: string;
  } | null>(null);
  // Original DirEntry by absolute path. The tree only carries (name, path,
  // size, isDirectory, fileCount) — `modified`, `extension`, real `name`
  // and `size` come from here when we hand an entry back to `onOpen`.
  // Recomputed on every `load()` (plan §H.20 H).
  const [entriesByPath, setEntriesByPath] = useState<Map<string, DirEntry>>(
    () => new Map()
  );
  // In-tree search box (plan §H.20 B). Raw input drives the TextField;
  // `deferredQuery` feeds the option-decorating useMemo so a fast typist
  // doesn't stall the chart at every keystroke.
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  // Folders whose file children are hidden (plan §H.20 E re-scoped). The
  // user toggles via:
  //   - right-click → "折叠" / "展开" on a directory node (per-folder)
  //   - toolbar 全部展开 / 全部折叠 (global: clear / fill the set)
  // Paths are absolute so the set survives `load()` refreshes in the same
  // session; it's lost on component unmount (FileList re-creates the view
  // on directory change anyway).
  const [hiddenFilesInFolders, setHiddenFilesInFolders] = useState<
    Set<string>
  >(() => new Set());
  // Mode filter (plan §H.20 F): 'all' | 'dir' | 'file'. Drives `buildTree`
  // via the `filter` option — for "仅文件", files in subdirectories become
  // unreachable (dir placeholders can't be synthesized). Documented in
  // plan §H.20 F trade-offs.
  const [filterMode, setFilterMode] = useState<FilterMode>('all');

  const load = useCallback(async () => {
    if (!currentDirectoryPath) return;
    setLoading(true);
    setError(null);
    try {
      const all = await ipcApi.listDirectoryRecursive(currentDirectoryPath, {
        maxDepth,
      });
      setTree(buildTree(currentDirectoryPath, all, { maxDepth, filter: filterMode }));
      const map = new Map<string, DirEntry>();
      for (const e of all) map.set(e.path, e);
      setEntriesByPath(map);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [currentDirectoryPath, maxDepth, filterMode]);

  useEffect(() => {
    void load();
  }, [load]);

  // Persist vizType + maxDepth to localStorage, keyed by locationId. The save
  // is debounced (same 200ms as the slider commit) so dragging the depth
  // slider doesn't hammer localStorage. (plan §H.20 D)
  useEffect(() => {
    if (!currentLocation?.id) return;
    const t = setTimeout(() => {
      saveFolderVizPrefs(currentLocation.id, { vizType });
    }, 200);
    return () => clearTimeout(t);
  }, [currentLocation?.id, vizType]);

  // Hydrate vizType + maxDepth from localStorage when the active location
  // changes. (plan §H.20 D: "切回 FolderViz 视角时,记住上次的 vizType 和
  // maxDepth"). Runs on initial mount AND on locationId change; navigating
  // within the same location (sub-directory) keeps the current values
  // because `currentLocation.id` is unchanged.
  useEffect(() => {
    if (!currentLocation?.id) return;
    const prefs = loadFolderVizPrefs(currentLocation.id);
    if (prefs) {
      setVizType(prefs.vizType);
    }
    // If no saved prefs, leave the default vizType (tree). Depth now follows
    // the global `viewDepth` setting (H.24 R4).
  }, [currentLocation?.id]);

  // H.24 R4: debounce the global `viewDepth` into `maxDepth` so the recursive
  // `listDirectoryRecursive` IPC fires once per settled value, not per tick.
  useEffect(() => {
    if (viewDepth === maxDepth) return;
    const t = setTimeout(() => setMaxDepth(viewDepth), 200);
    return () => clearTimeout(t);
  }, [viewDepth, maxDepth]);

  // Walk the tree once when the deferred query changes: collect (a) every node
  // whose name contains the query (case-insensitive), and (b) every ancestor
  // path so the chain from root → match stays visible. When the query is
  // empty, both sets are empty and the chart renders unfiltered.
  const searchHits = useMemo(() => {
    const matches = new Set<string>();
    const visible = new Set<string>();
    if (!tree || !deferredQuery.trim()) return { matches, visible };
    const q = deferredQuery.trim().toLowerCase();
    const walk = (node: FolderVizNode): boolean => {
      const selfMatch = node.name.toLowerCase().includes(q);
      let childHit = false;
      if (node.children) {
        for (const c of node.children) {
          if (walk(c)) childHit = true;
        }
      }
      if (selfMatch) {
        matches.add(node.path);
        visible.add(node.path);
      }
      if (childHit) visible.add(node.path);
      return selfMatch || childHit;
    };
    walk(tree);
    return { matches, visible };
  }, [tree, deferredQuery]);

  const echartsData = useMemo(() => {
    if (!tree) return null;
    const options = { getColor: defaultNodeColor };
    let data: any;
    switch (vizType) {
      case 'tree':
      case 'radial':
        data = toEChartsTree(tree, { radial: vizType === 'radial', ...options });
        break;
      case 'treemap': {
        // Size-weighted color (plan §H.20 G P2): darker amber for larger
        // directories so a glance at the chart surfaces "what's bloated".
        // Files keep `defaultNodeColor` since they all share the same
        // visual weight in the chart. The closure captures `tree.size`
        // so each node's color reflects its share of the root.
        const totalSize = tree.size || 1;
        const weightedColor = (n: FolderVizNode): string => {
          if (!n.isDirectory) return defaultNodeColor(n);
          const ratio = Math.min(1, n.size / totalSize);
          // Light yellow #f4b400 → dark amber #b45309 as ratio grows.
          const r = Math.round(244 - (244 - 180) * ratio);
          const g = Math.round(180 - (180 - 83) * ratio);
          const b = Math.round(0 + 9 * ratio);
          return `rgb(${r}, ${g}, ${b})`;
        };
        data = toEChartsTreemap(tree, { getColor: weightedColor });
        break;
      }
      case 'sunburst':
        data = toEChartsSunburst(tree, options);
        break;
      default:
        return null;
    }
    // Decorate the ECharts data with search-driven opacity / highlight, and
    // mark every ancestor of a match `collapsed: false` so ECharts renders
    // the chain expanded. (plan §H.20 B)
    if (searchHits.visible.size > 0) {
      const { matches, visible } = searchHits;
      const primary = theme.palette.primary.main;
      const dim = (node: any) => {
        if (node.path) {
          if (matches.has(node.path)) {
            node.itemStyle = {
              ...(node.itemStyle ?? {}),
              borderColor: primary,
              borderWidth: 2,
            };
            node.label = {
              ...(node.label ?? {}),
              fontWeight: 'bold',
              color: primary,
            };
          } else if (!visible.has(node.path)) {
            node.itemStyle = { ...(node.itemStyle ?? {}), opacity: 0.2 };
            node.label = { ...(node.label ?? {}), opacity: 0.2 };
          }
        }
        if (node.children) for (const c of node.children) dim(c);
      };
      const expandAncestors = (node: any) => {
        if (!node.children) return;
        for (const c of node.children) expandAncestors(c);
        // If any direct child is visible, this node should be expanded so
        // the chain from root → match renders without manual clicks.
        if (node.children.some((c: any) => visible.has(c.path))) {
          node.collapsed = false;
        }
      };
      dim(data);
      expandAncestors(data);
    }
    // Per-folder "hide files" (plan §H.20 E re-scoped). For each path in
    // `hiddenFilesInFolders`, drop the direct file children; directory
    // children and the subtree under them stay. Recursion keeps walking
    // so a sub-folder in the set is filtered too, but only at its own
    // level — the toggle is per-folder, not recursive.
    if (hiddenFilesInFolders.size > 0) {
      const filter = (node: any) => {
        if (hiddenFilesInFolders.has(node.path) && node.children) {
          node.children = node.children.filter((c: any) => c.isDirectory);
        }
        if (node.children) for (const c of node.children) filter(c);
      };
      filter(data);
    }
    return data;
  }, [tree, vizType, searchHits, theme, hiddenFilesInFolders]);

  const option = useMemo(() => {
    if (!echartsData) return {};

    const tooltipFormatter = (params: any) => {
      const size = params.value ?? 0;
      const count = params.data?.fileCount ?? 0;
      const lines = [
        params.name,
        `${t('size')}: ${formatSize(size)}`,
      ];
      if (count > 0) lines.push(`${t('files')}: ${count}`);
      return lines.join('<br/>');
    };

    const common = {
      tooltip: {
        trigger: 'item',
        formatter: tooltipFormatter,
      },
      animationDuration: 300,
      animationDurationUpdate: 300,
    };

    if (vizType === 'tree' || vizType === 'radial') {
      return {
        ...common,
        series: [
          {
            type: 'tree',
            data: [echartsData],
            top: '5%',
            left: '5%',
            bottom: '5%',
            right: '20%',
            symbolSize: 10,
            layout: vizType === 'radial' ? 'radial' : 'orthogonal',
            orient: 'LR',
            initialTreeDepth: maxDepth,
            // For the orthogonal tree, `rotate: 0` overrides ECharts' default
            // of auto-rotating labels by the connecting branch angle
            // (see node_modules/echarts/lib/chart/tree/TreeView.js — when
            // `label.rotate` is null it sets `rotation: -rad`). In the
            // orthogonal layout, `rad` is computed from the straight
            // root→target line (not the L-shaped visual edge), so the tilt
            // accumulates for deep branches and siblings stacked at
            // different y. Radial mode is left undefined on purpose so it
            // keeps the ECharts `'tangential'` default.
            label: {
              position: vizType === 'radial' ? undefined : 'right',
              verticalAlign: 'middle',
              align: vizType === 'radial' ? undefined : 'left',
              rotate: vizType === 'radial' ? undefined : 0,
              fontSize: 12,
              color: theme.palette.text.primary,
              textBorderWidth: 0,
            },
            leaves: {
              label: {
                position: vizType === 'radial' ? undefined : 'right',
                verticalAlign: 'middle',
                align: vizType === 'radial' ? undefined : 'left',
                rotate: vizType === 'radial' ? undefined : 0,
                color: theme.palette.text.primary,
                textBorderWidth: 0,
              },
            },
            emphasis: { focus: 'descendant' },
            expandAndCollapse: true,
            animationDuration: 300,
            animationDurationUpdate: 300,
          },
        ],
      };
    }

    if (vizType === 'treemap') {
      // The size-weighted color is applied at the data layer (see the
      // `echartsData` useMemo above) so each `node.itemStyle.color` is
      // baked in. The series config below only handles label / border.
      return {
        ...common,
        series: [
          {
            type: 'treemap',
            data: echartsData.children ?? [],
            breadcrumb: { show: false },
            label: {
              show: true,
              fontSize: 11,
              // Truncate long names so they don't overflow the tile
              // (plan §H.20 G). ECharts calls formatter with the data
              // item; we use `name`.
              formatter: (p: any) => truncate(p.name ?? '', 16),
            },
            itemStyle: { borderColor: '#fff', borderWidth: 1 },
            emphasis: { focus: 'ancestor' },
          },
        ],
      };
    }

    // sunburst
    // Center summary: use ECharts `graphic` to render 3 lines in the
    // donut hole — root name (truncated), total size, total file count
    // (plan §H.20 G). Data is read from the source `tree` (which is
    // the post-`buildTree` root, so values reflect any active filter).
    const rootSize = echartsData.size;
    const rootFileCount = echartsData.fileCount;
    const rootName = echartsData.name;
    return {
      ...common,
      // Reserve the inner 15% so the center summary has room.
      series: [
        {
          type: 'sunburst',
          data: echartsData.children ?? [],
          radius: ['15%', '90%'],
          label: {
            rotate: 'radial',
            fontSize: 11,
            formatter: (p: any) => truncate(p.name ?? '', 16),
          },
          // Hide labels in very thin slices — `minAngle` skips slices
          // narrower than N degrees so the label doesn't get crammed
          // into a hairline.
          minAngle: 5,
          emphasis: { focus: 'ancestor' },
        },
      ],
      graphic: [
        {
          type: 'text',
          left: 'center',
          top: '38%',
          style: {
            text: truncate(rootName, 24),
            fill: theme.palette.text.primary,
            fontSize: 14,
            fontWeight: 600,
            textAlign: 'center',
          },
        },
        {
          type: 'text',
          left: 'center',
          top: '50%',
          style: {
            text: formatSize(rootSize),
            fill: theme.palette.text.secondary,
            fontSize: 12,
            textAlign: 'center',
          },
        },
        {
          type: 'text',
          left: 'center',
          top: '60%',
          style: {
            text: `${rootFileCount} ${t('files')}`,
            fill: theme.palette.text.secondary,
            fontSize: 12,
            textAlign: 'center',
          },
        },
      ],
    };
  }, [echartsData, vizType, maxDepth, t, theme]);

  const handleChartClick = useCallback(
    (params: any) => {
      const path: string | undefined = params.data?.path;
      const isDirectory: boolean | undefined = params.data?.isDirectory;
      if (!path) return;
      if (isDirectory) {
        navigateTo(path);
      } else {
        // Pull the full DirEntry from the source map (plan §H.20 H):
        // ECharts `params.data` only carries (name, value, path, isDirectory)
        // — `modified` and `extension` are gone. The original DirEntry is the
        // only source of truth for those.
        const original = entriesByPath.get(path);
        const name = original?.name ?? params.name ?? '';
        const ext =
          original?.extension ??
          (name.includes('.')
            ? name.slice(name.lastIndexOf('.') + 1).toLowerCase()
            : '');
        onOpen({
          name,
          path,
          isDirectory: false,
          isFile: true,
          size: original?.size ?? params.value ?? 0,
          modified: original?.modified ?? '',
          extension: ext,
        });
      }
    },
    [navigateTo, onOpen, entriesByPath]
  );

  // Right-click on a node → open the per-node context menu (plan §H.20 A).
  // Right-click on the empty canvas → swallow the event and show no menu
  // (plan §H.2 line 1069-1070: "新建文件/夹" only belongs to list/grid).
  const handleNodeContextMenu = useCallback((params: any) => {
    const evt = params?.event?.event;
    if (evt?.preventDefault) evt.preventDefault();
    if (evt?.stopPropagation) evt.stopPropagation();
    if (!params?.data?.path) return;
    setNodeCtx({
      x: evt.clientX,
      y: evt.clientY,
      path: params.data.path,
      isDirectory: !!params.data.isDirectory,
      name: params.data.name ?? '',
    });
  }, []);

  const closeNodeMenu = useCallback(() => setNodeCtx(null), []);

  const handleEnterDir = useCallback(() => {
    if (nodeCtx?.isDirectory) navigateTo(nodeCtx.path);
    setNodeCtx(null);
  }, [nodeCtx, navigateTo]);

  const handleReveal = useCallback(() => {
    if (!nodeCtx) return;
    const target = nodeCtx.path;
    setNodeCtx(null);
    void ipcApi.revealPath(target).catch((e) => {
      setNotice(e instanceof Error ? e.message : String(e));
    });
  }, [nodeCtx]);

  const handleSetThumb = useCallback(() => {
    if (!nodeCtx?.isDirectory) return;
    const target = nodeCtx.path;
    setNodeCtx(null);
    void (async () => {
      const src = await ipcApi.openImageFileDialog();
      if (!src) return;
      try {
        await ipcApi.setFolderThumbnail(target, src);
      } catch (e) {
        setNotice(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [nodeCtx]);

  // Per-folder "hide files inside this folder" toggle (plan §H.20 E
  // re-scoped). Single toggle: clicking the menu item either adds the
  // folder path to `hiddenFilesInFolders` (collapses files) or removes
  // it (expands files back). The decoration pass in the `echartsData`
  // useMemo drops the file children of any path in the set.
  const handleToggleFolderFiles = useCallback(() => {
    if (!nodeCtx?.isDirectory) return;
    const target = nodeCtx.path;
    setNodeCtx(null);
    setHiddenFilesInFolders((prev) => {
      const next = new Set(prev);
      if (next.has(target)) next.delete(target);
      else next.add(target);
      return next;
    });
  }, [nodeCtx]);

  // Global "show all files" — toolbar 全部展开 button. Clears the entire
  // hidden set, regardless of per-folder toggles.
  const handleExpandAllFiles = useCallback(() => {
    setHiddenFilesInFolders(new Set());
  }, []);

  // Global "hide all files in the entire tree" — toolbar 全部折叠 button.
  // Walks the source `tree` (not the ECharts data, which may already be
  // filtered) and adds every directory path to the hidden set. Files
  // disappear across the whole tree in one click.
  const handleCollapseAllFiles = useCallback(() => {
    if (!tree) return;
    const paths = new Set<string>();
    const walk = (node: FolderVizNode): void => {
      if (node.isDirectory) {
        paths.add(node.path);
        if (node.children) for (const c of node.children) walk(c);
      }
    };
    walk(tree);
    setHiddenFilesInFolders(paths);
  }, [tree]);

  const handleOpenFile = useCallback(() => {
    if (!nodeCtx || nodeCtx.isDirectory) return;
    const { path } = nodeCtx;
    // Look up the original DirEntry so `modified`, `size`, and `extension`
    // reach `onOpen` instead of being placeholdered (plan §H.20 H).
    const original = entriesByPath.get(path);
    const name = original?.name ?? nodeCtx.name;
    const ext =
      original?.extension ??
      (name.includes('.')
        ? name.slice(name.lastIndexOf('.') + 1).toLowerCase()
        : '');
    onOpen({
      name,
      path,
      isDirectory: false,
      isFile: true,
      size: original?.size ?? 0,
      modified: original?.modified ?? '',
      extension: ext,
    });
    setNodeCtx(null);
  }, [nodeCtx, onOpen, entriesByPath]);

  // Files only — bypass extensions and open with the OS-registered handler
  // (shell.openPath). Mirrors FileList's `openWithDefaultApp` MenuItem.
  const handleOpenWithDefaultApp = useCallback(() => {
    if (!nodeCtx || nodeCtx.isDirectory) return;
    const target = nodeCtx.path;
    setNodeCtx(null);
    void ipcApi.openNative(target).catch((e) => {
      setNotice(e instanceof Error ? e.message : String(e));
    });
  }, [nodeCtx]);

  const onEvents = useMemo(
    () => ({
      click: handleChartClick,
      contextmenu: handleNodeContextMenu,
    }),
    [handleChartClick, handleNodeContextMenu]
  );

  const getChartDataUrl = useCallback((): string | null => {
    const instance = chartRef.current?.getEchartsInstance();
    if (!instance) return null;
    return instance.getDataURL({
      type: 'png',
      pixelRatio: 2,
      backgroundColor: theme.palette.background.paper,
    });
  }, [theme]);

  // P2-3: shared save/save-as/copy-to-clipboard flow. The hook owns its own
  // `saving` / `error` so we rename to `exportError` to avoid shadowing the
  // local `error` (which surfaces revealPath / setFolderThumbnail failures).
  const {
    saving,
    error: exportError,
    handleSave,
    handleSaveAs,
    handleCopyToClipboard,
  } = useImageExport({
    capture: useCallback(async () => {
      const url = getChartDataUrl();
      return url ? base64FromDataUrl(url) : null;
    }, [getChartDataUrl]),
    prefix: 'folder-viz',
  });

  // P2-3: copy-to-clipboard notice (mirrors TagCloud / Calendar). Tailored
  // message for image vs base64-fallback so the user knows what landed.
  const [notice, setNotice] = useState<string | null>(null);
  const onCopyToClipboard = useCallback(async () => {
    try {
      const kind: ClipboardKind = await handleCopyToClipboard();
      setNotice(kind === 'image' ? t('folderVizCopied') : t('folderVizCopiedAsBase64'));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }, [handleCopyToClipboard, t]);

  if (!currentDirectoryPath) {
    return (
      <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Typography color="text.secondary">{t('folderVizEmpty')}</Typography>
      </Box>
    );
  }

  return (
    <Box
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      sx={{
        height: '100%',
        width: '100%',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        p: 1.5,
        overflow: 'hidden',
      }}
    >
      <Stack
        direction="row"
        sx={{
          alignItems: 'center',
          gap: 2,
          flexShrink: 0,
          flexWrap: 'wrap',
        }}
      >
        <AccountTreeIcon color="action" />
        <Typography variant="subtitle1" sx={{ fontWeight: 500 }}>
          {t('folderViz')}
        </Typography>

        <ToggleButtonGroup
          size="small"
          exclusive
          value={vizType}
          onChange={(_e, value: FolderVizType | null) => {
            if (value) setVizType(value);
          }}
        >
          <ToggleButton value="tree">{t('folderVizTree')}</ToggleButton>
          <ToggleButton value="radial">{t('folderVizRadial')}</ToggleButton>
          <ToggleButton value="treemap">{t('folderVizTreemap')}</ToggleButton>
          <ToggleButton value="sunburst">{t('folderVizSunburst')}</ToggleButton>
        </ToggleButtonGroup>

        <ToggleButtonGroup
          size="small"
          exclusive
          value={filterMode}
          onChange={(_e, value: FilterMode | null) => {
            if (value) setFilterMode(value);
          }}
          aria-label={t('folderVizFilterAll')}
        >
          <ToggleButton value="all">{t('folderVizFilterAll')}</ToggleButton>
          <ToggleButton value="dir">{t('folderVizFilterDir')}</ToggleButton>
          <ToggleButton value="file">{t('folderVizFilterFile')}</ToggleButton>
        </ToggleButtonGroup>

        <TextField
          size="small"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('folderVizSearch')}
          sx={{ width: 180, flexShrink: 0 }}
          slotProps={{
            htmlInput: { 'aria-label': t('folderVizSearch') },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
              endAdornment: query ? (
                <InputAdornment position="end">
                  <Tooltip title={t('folderVizSearchClear')}>
                    <IconButton
                      size="small"
                      edge="end"
                      onClick={() => setQuery('')}
                      aria-label={t('folderVizSearchClear')}
                    >
                      <CloseIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </InputAdornment>
              ) : null,
            },
          }}
        />

        <Tooltip title={t('folderVizExpandAll')}>
          <span>
            <IconButton
              size="small"
              // "Show all files everywhere" — clears the per-folder hidden
              // set. Mirrors the right-click "展开此文件夹的文件" but at
              // global scope.
              onClick={handleExpandAllFiles}
              disabled={loading || !tree || hiddenFilesInFolders.size === 0}
              aria-label={t('folderVizExpandAll')}
            >
              <UnfoldMoreIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>

        <Tooltip title={t('folderVizCollapseAll')}>
          <span>
            <IconButton
              size="small"
              // "Hide all files in the entire tree" — walks the tree and
              // adds every directory to the hidden set. Mirrors the
              // right-click "折叠此文件夹的文件" but at global scope.
              onClick={handleCollapseAllFiles}
              disabled={loading || !tree}
              aria-label={t('folderVizCollapseAll')}
            >
              <UnfoldLessIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>

        <Tooltip title={t('folderVizRefresh')}>
          <span>
            <IconButton size="small" onClick={() => void load()} disabled={loading}>
              {loading ? (
                <CircularProgress size={18} />
              ) : (
                <RefreshIcon fontSize="small" />
              )}
            </IconButton>
          </span>
        </Tooltip>

        <Tooltip title={t('folderVizCopy')}>
          <span>
            <IconButton
              size="small"
              onClick={() => void onCopyToClipboard()}
              disabled={saving || loading || !tree || readOnly}
              aria-label={t('folderVizCopy')}
            >
              <ContentCopyIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>

        <Tooltip title={t('save')}>
          <span>
            <IconButton
              size="small"
              onClick={() => void handleSave()}
              disabled={saving || loading || !tree || readOnly}
            >
              <SaveIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>

        <Tooltip title={t('saveTo')}>
          <span>
            <IconButton
              size="small"
              onClick={() => void handleSaveAs()}
              disabled={saving || loading || !tree || readOnly}
            >
              <DriveFileMoveIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>

      {error ? (
        // Data-load failure: nothing to chart — show the error with a retry
        // (transient right-click errors go to the Snackbar instead and never
        // reach this branch).
        <Alert
          severity="error"
          sx={{ m: 2 }}
          action={
            <Button color="inherit" size="small" onClick={() => void load()}>
              {t('extRetry')}
            </Button>
          }
        >
          {error}
        </Alert>
      ) : (
        <Box tabIndex={-1} sx={{ flex: 1, minHeight: 0, position: 'relative' }}>
          <ReactECharts
            ref={chartRef}
            echarts={echarts}
            option={option}
            onEvents={onEvents}
            style={{ height: '100%', width: '100%' }}
            notMerge
            lazyUpdate
          />
          {/* Dim the (stale) chart while a fresh `listDirectoryRecursive`
              is in flight, so the user knows the next render is coming. The
              Backdrop's own CircularProgress is centered. (plan §H.20 C) */}
          <Backdrop
            open={loading}
            sx={{
              position: 'absolute',
              zIndex: (muiTheme) => muiTheme.zIndex.drawer + 1,
              bgcolor: 'action.disabledBackground',
            }}
          >
            <CircularProgress />
          </Backdrop>
        </Box>
      )}

      <Menu
        open={nodeCtx !== null}
        onClose={closeNodeMenu}
        anchorReference="anchorPosition"
        anchorPosition={
          nodeCtx
            ? { top: nodeCtx.y, left: nodeCtx.x }
            : undefined
        }
      >
        {nodeCtx?.isDirectory ? (
          <>
            <MenuItem onClick={handleEnterDir} disabled={readOnly}>
              <ListItemIcon>
                <LoginIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>{t('folderVizEnterDir')}</ListItemText>
            </MenuItem>
            {/* Per-folder "hide files" toggle (plan §H.20 E re-scoped).
                Single menu item that flips based on the folder's current
                state — no need to show both at once. */}
            <MenuItem onClick={handleToggleFolderFiles}>
              <ListItemIcon>
                {hiddenFilesInFolders.has(nodeCtx.path) ? (
                  <VisibilityIcon fontSize="small" />
                ) : (
                  <VisibilityOffIcon fontSize="small" />
                )}
              </ListItemIcon>
              <ListItemText>
                {hiddenFilesInFolders.has(nodeCtx.path)
                  ? t('folderVizExpandFolder')
                  : t('folderVizCollapseFolder')}
              </ListItemText>
            </MenuItem>
          </>
        ) : (
          <MenuItem onClick={handleOpenFile}>
            <ListItemIcon>
              <OpenInNewIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{t('open')}</ListItemText>
          </MenuItem>
        )}
        {!nodeCtx?.isDirectory && (
          <MenuItem onClick={handleOpenWithDefaultApp}>
            <ListItemIcon>
              <LaunchIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{t('openWithDefaultApp')}</ListItemText>
          </MenuItem>
        )}
        <MenuItem onClick={handleReveal}>
          <ListItemIcon>
            <FolderOpenIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t('revealInExplorer')}</ListItemText>
        </MenuItem>
        {nodeCtx?.isDirectory && (
          <>
            <Divider />
            <MenuItem onClick={handleSetThumb} disabled={readOnly}>
              <ListItemIcon>
                <ImageIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>{t('setFolderThumbnail')}</ListItemText>
            </MenuItem>
          </>
        )}
      </Menu>

      {/* P2-3: copy-to-clipboard notice + transient export-error toast.
          Kept as a Snackbar so a failed save/copy doesn't replace the chart
          (the chart-replace above is reserved for right-click menu errors). */}
      <Snackbar
        open={notice !== null || exportError !== null}
        autoHideDuration={2400}
        onClose={() => {
          setNotice(null);
        }}
        message={notice ?? exportError ?? ''}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </Box>
  );
}
