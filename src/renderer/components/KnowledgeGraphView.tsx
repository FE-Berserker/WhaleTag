import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Snackbar,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import HubIcon from '@mui/icons-material/Hub';
import SaveIcon from '@mui/icons-material/Save';
import DriveFileMoveIcon from '@mui/icons-material/DriveFileMove';
import FitScreenIcon from '@mui/icons-material/FitScreen';
import FolderIcon from '@mui/icons-material/Folder';
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { buildGraph, layoutGraph } from '../domain/knowledge-graph';
import { type TagCategory } from '../domain/tagcloud';
import {
  CATEGORY_LABEL_KEY,
  DEFAULT_SHOWN_CATEGORIES,
  FILTERABLE_CATEGORIES,
  readPrefs,
  sanitizeShownCategories,
  writePrefs,
} from '../domain/perspective-prefs';
import { getTagColor } from '../domain/tag-colors';
import { tagDisplayLabel } from '-/services/tag-display';
import { useDirectoryUI } from '-/hooks/DirectoryContentContextProvider';
import { useCurrentLocationContext } from '-/hooks/CurrentLocationContextProvider';
import { useImageExport } from '-/hooks/useImageExport';
import { ipcApi } from '-/services/ipc-api';
import { parentDir } from '-/services/path-util';
import LoadingOverlay from '-/components/perspective/LoadingOverlay';
import EmptyHint from '-/components/perspective/EmptyHint';
import ErrorBanner from '-/components/perspective/ErrorBanner';
import type { FileCellData } from '-/components/file-cell';

interface KnowledgeGraphViewProps {
  /** The shared per-cell handler bag from FileList. */
  data: FileCellData;
}

// localStorage key shape: `whale.kg.${locationId}` → KgPrefs. Short `kg`
// namespace keeps the key well under localStorage limits even with a long
// locationId. Persisted per-location (plan §H.22 P2-2).
const PREFS_KEY_PREFIX = 'whale.kg.';

interface KgPrefs {
  shown: TagCategory[];
  /** User-dragged node positions, keyed by node id (path / tag name). Wins
   *  over the deterministic radial layout when present (2026-07-22). */
  positions?: Record<string, { x: number; y: number }>;
}

/** Light shape check for persisted positions (drops malformed entries). */
function sanitizeKgPositions(
  raw: unknown
): Record<string, { x: number; y: number }> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const out: Record<string, { x: number; y: number }> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (
      typeof v === 'object' &&
      v !== null &&
      typeof (v as { x?: unknown }).x === 'number' &&
      typeof (v as { y?: unknown }).y === 'number'
    ) {
      out[k] = v as { x: number; y: number };
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

const TAG_FALLBACK = '#7e9cd8';
/** Type-icon colors for file nodes, keyed by lowercased extension. */
const EXT_COLORS: Record<string, string> = {
  pdf: '#e57373',
  doc: '#64b5f6', docx: '#64b5f6',
  xls: '#81c784', xlsx: '#81c784',
  ppt: '#ffb74d', pptx: '#ffb74d',
  jpg: '#ba68c8', jpeg: '#ba68c8', png: '#ba68c8', gif: '#ba68c8',
  mp4: '#4dd0e1', mov: '#4dd0e1',
  txt: '#90a4ae', md: '#90a4ae',
};
const extColor = (ext: string) => EXT_COLORS[ext] ?? '#bdbdbd';
/** Warm amber for directory nodes — visually distinct from ext and tag colors. */
const DIR_COLOR = '#ffa726';

interface TagNodeData {
  label: string;
  color: string;
  raw: string;
  degree: number;
  [key: string]: unknown;
}
interface FileNodeData {
  name: string;
  ext: string;
  path: string;
  color: string;
  [key: string]: unknown;
}
interface DirectoryNodeData {
  name: string;
  path: string;
  color: string;
  [key: string]: unknown;
}

/** A tag node: a colored pill whose size grows with its degree. */
function TagNode({ data }: NodeProps<Node<TagNodeData>>) {
  const scale = Math.min(1.6, 1 + Math.log10(data.degree + 1) * 0.5);
  return (
    <div
      style={{
        background: data.color,
        color: '#fff',
        borderRadius: 999,
        padding: `${4 * scale}px ${10 * scale}px`,
        fontSize: 12 * scale,
        fontWeight: 600,
        maxWidth: 220,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
      }}
      title={`${data.label} · ${data.degree}`}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      {data.label}
    </div>
  );
}

/** A file node: a colored type chip with the extension + file name. */
function FileNode({ data }: NodeProps<Node<FileNodeData>>) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        // React Flow exposes theme-aware CSS vars (--xy-node-background-color /
        // --xy-node-color) that flip when <ReactFlow colorMode="dark"> is
        // active. Falling back to the *-default vars keeps the node readable
        // even if the class isn't applied for some reason.
        background: 'var(--xy-node-background-color, var(--xy-node-background-color-default, #fff))',
        color: 'var(--xy-node-color, var(--xy-node-color-default, inherit))',
        border: '1px solid var(--xy-node-border, rgba(128,128,128,0.4))',
        borderRadius: 6,
        padding: '3px 8px 3px 4px',
        fontSize: 11,
        maxWidth: 200,
        boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
      }}
      title={data.name}
    >
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
      <span
        style={{
          flexShrink: 0,
          minWidth: 22,
          height: 16,
          padding: '0 4px',
          borderRadius: 3,
          background: data.color,
          color: '#fff',
          fontSize: 9,
          fontWeight: 700,
          textTransform: 'uppercase',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {data.ext || '•'}
      </span>
      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {data.name}
      </span>
    </div>
  );
}

/** A directory node: a folder icon + directory name chip. */
function DirectoryNode({ data }: NodeProps<Node<DirectoryNodeData>>) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        background: 'var(--xy-node-background-color, var(--xy-node-background-color-default, #fff))',
        color: 'var(--xy-node-color, var(--xy-node-color-default, inherit))',
        border: '1px solid var(--xy-node-border, rgba(128,128,128,0.4))',
        borderRadius: 6,
        padding: '3px 8px',
        fontSize: 11,
        maxWidth: 200,
        boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
      }}
      title={data.name}
    >
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
      <FolderIcon
        sx={{ fontSize: 18, color: data.color, flexShrink: 0 }}
      />
      <span
        style={{
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {data.name}
      </span>
    </div>
  );
}

const nodeTypes = { tag: TagNode, file: FileNode, directory: DirectoryNode };

/**
 * Knowledge Graph perspective (TagSpaces "tagsgraph"): a bipartite tag↔file
 * graph of the current directory's tagged files, laid out radially and
 * rendered with React Flow. Nodes are draggable; click a tag to filter,
 * click a file to open.
 *
 * H.13 adds a depth slider so subdirectories can be included in the graph.
 * H.19 renamed it from `MindMap` and added position memory + recenter.
 */
export default function KnowledgeGraphView({ data }: KnowledgeGraphViewProps) {
  const { entries, tagsByName, tagColors, groups, onOpen, onClickTag, readOnly, t } = data;
  const { currentDirectoryPath, currentLocation, navigateTo } = useCurrentLocationContext();
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';
  const wrapperRef = useRef<HTMLDivElement>(null);

  const [shown, setShown] = useState<TagCategory[]>(DEFAULT_SHOWN_CATEGORIES);
  // User-dragged node positions for the current location (persisted in prefs).
  const [storedPositions, setStoredPositions] = useState<
    Record<string, { x: number; y: number }>
  >({});
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  // H.24 R4: depth + loading come from the global directory content context
  // (single source); the recursive-scan truncation banner is at FileList level.
  const { loading } = useDirectoryUI();

  // P2-2: keep a live ref to the latest prefs so the unmount cleanup can flush
  // them immediately. This prevents losing a just-toggled filter when the user
  // switches perspectives within the 200ms debounce window.
  const prefsRef = useRef<KgPrefs>({ shown });
  useEffect(() => {
    prefsRef.current = { shown, positions: storedPositions };
  });

  // P2-2: restore / persist per-location prefs (depth + visible categories),
  // mirroring TagCloud and FolderViz. Load on location change; debounced save
  // on any change, with the cleanup flushing the latest prefs on unmount.
  useEffect(() => {
    const id = currentLocation?.id;
    if (!id) return;
    const prefs = readPrefs<KgPrefs>(PREFS_KEY_PREFIX + id);
    // Location switch: drop the previous location's drag map immediately so
    // a stale position never leaks into another folder's graph.
    setStoredPositions(sanitizeKgPositions(prefs?.positions) ?? {});
    if (!prefs) return;
    const shownV = sanitizeShownCategories(prefs.shown);
    if (shownV !== null) setShown(shownV);
  }, [currentLocation?.id]);

  useEffect(() => {
    const id = currentLocation?.id;
    if (!id) return undefined;
    const handle = window.setTimeout(() => {
      writePrefs<KgPrefs>(PREFS_KEY_PREFIX + id, prefsRef.current);
    }, 200);
    return () => {
      window.clearTimeout(handle);
      writePrefs<KgPrefs>(PREFS_KEY_PREFIX + id, prefsRef.current);
    };
  }, [currentLocation?.id, shown]);

  const { rfNodes, rfEdges, tagCount, fileCount } = useMemo(() => {
    const exclude = FILTERABLE_CATEGORIES.filter((c) => !shown.includes(c));
    const graph = buildGraph(entries, tagsByName, { exclude });
    const pos = layoutGraph(graph);
    const nodes: Node[] = graph.nodes.map((n) =>
      n.kind === 'tag'
        ? {
            id: n.id,
            type: 'tag',
            position: storedPositions[n.id] ?? pos.get(n.id) ?? { x: 0, y: 0 },
            data: {
              label: tagDisplayLabel(n.tag, t),
              color: getTagColor(n.tag, tagColors, groups) ?? TAG_FALLBACK,
              raw: n.tag,
              degree: n.degree,
            } satisfies TagNodeData,
          }
        : n.kind === 'directory'
          ? {
              id: n.id,
              type: 'directory',
              position: storedPositions[n.id] ?? pos.get(n.id) ?? { x: 0, y: 0 },
              data: { name: n.name, path: n.path, color: DIR_COLOR } satisfies DirectoryNodeData,
            }
          : {
              id: n.id,
              type: 'file',
              position: storedPositions[n.id] ?? pos.get(n.id) ?? { x: 0, y: 0 },
              data: { name: n.name, ext: n.ext, path: n.path, color: extColor(n.ext) } satisfies FileNodeData,
            }
    );
    const edges: Edge[] = graph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      // RF swaps --xy-edge-stroke between light (#b1b1b7) and dark (#3e3e3e)
      // when <ReactFlow colorMode> flips; falling back to neutral gray keeps
      // both modes readable.
      style: { stroke: 'var(--xy-edge-stroke, rgba(128,128,128,0.45))' },
    }));
    return {
      rfNodes: nodes,
      rfEdges: edges,
      tagCount: graph.nodes.filter((n) => n.kind === 'tag').length,
      fileCount: graph.nodes.filter((n) => n.kind === 'file' || n.kind === 'directory').length,
    };
  }, [entries, tagsByName, tagColors, groups, shown, storedPositions, t]);

  const [nodes, setNodes, onNodesChange] = useNodesState(rfNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(rfEdges);
  // Persist user-dragged positions per location. Fires once per drag gesture
  // (not per mousemove), so the 200ms-debounced prefs write stays cheap.
  const handleNodeDragStop = useCallback(() => {
    setStoredPositions((prev) => {
      const next = { ...prev };
      for (const n of nodes) next[n.id] = { x: n.position.x, y: n.position.y };
      return next;
    });
  }, [nodes]);
  const flowRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const fitTimer = useRef<number | undefined>(undefined);
  // Tracks the last node count we fitView'd to. fitView only re-runs when
  // this changes — toggling a filter that *keeps* the same number of nodes
  // (e.g. swap one excluded category for another of equal count) leaves the
  // viewport alone. Pure pan/zoom by the user doesn't change count either,
  // so manual viewport adjustments still survive across renders.
  const lastFitCount = useRef<number>(-1);

  // Fit after the custom nodes have been measured — their width is content-
  // driven, so fitting on the same frame uses default sizes and ends up too
  // small. A short delay lets React Flow measure first.
  const fitSoon = useCallback(() => {
    window.clearTimeout(fitTimer.current);
    fitTimer.current = window.setTimeout(() => {
      flowRef.current?.fitView({ padding: 0.12, duration: 300, maxZoom: 1.75 });
    }, 160);
  }, []);

  useEffect(() => () => window.clearTimeout(fitTimer.current), []);

  // Sync the freshly-computed graph into React Flow's state with a full
  // replacement. The previous per-id diff caused nodes/edges to disappear
  // when the (now-removed) tension slider fired rapid onChange events; the
  // full-replace path here doesn't have that problem because React Flow's
  // internal reconciliation handles a fresh array cleanly.
  useEffect(() => {
    setNodes(rfNodes);
    setEdges(rfEdges);
    if (rfNodes.length !== lastFitCount.current) {
      lastFitCount.current = rfNodes.length;
      fitSoon();
    }
  }, [rfNodes, rfEdges, setNodes, setEdges, fitSoon]);

  const onNodeClick = useCallback(
    (_e: unknown, node: Node) => {
      if (node.type === 'tag') {
        onClickTag((node.data as TagNodeData).raw);
      } else if (node.type === 'directory') {
        const path = (node.data as DirectoryNodeData).path;
        const ent = entries.find((en) => en.path === path);
        if (!ent) return;
        navigateTo(ent.path);
      } else {
        const path = (node.data as FileNodeData).path;
        const ent = entries.find((en) => en.path === path);
        if (!ent) return;
        // If the file lives in a subdirectory, navigate there first so the
        // file list reflects the selection; otherwise open directly.
        if (currentDirectoryPath && parentDir(ent.path) !== currentDirectoryPath) {
          navigateTo(parentDir(ent.path));
        } else {
          onOpen(ent);
        }
      }
    },
    [entries, currentDirectoryPath, navigateTo, onOpen, onClickTag]
  );

  const captureMindMap = useCallback(async (): Promise<string | null> => {
    const el = wrapperRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return ipcApi.captureRegion({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
  }, []);

  const { saving, error, handleSave, handleSaveAs, handleCopyToClipboard } =
    useImageExport({
      capture: captureMindMap,
      prefix: 'mind-map',
    });

  // Copy-to-clipboard notice (mirrors FolderViz / TagCloud): image when the
  // clipboard accepts PNG, base64 text otherwise.
  const [notice, setNotice] = useState<string | null>(null);
  const onCopyToClipboard = useCallback(async () => {
    try {
      const kind = await handleCopyToClipboard();
      setNotice(kind === 'image' ? t('kgCopied') : t('kgCopiedAsBase64'));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }, [handleCopyToClipboard, t]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }, []);

  return (
    <Box
      onContextMenu={handleContextMenu}
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
      <Stack direction="row" sx={{ alignItems: 'center', gap: 2, flexShrink: 0, flexWrap: 'wrap' }}>
        <HubIcon color="action" />
        <Typography variant="subtitle1" sx={{ fontWeight: 500 }}>
          {t('knowledgeGraph')}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {t('knowledgeGraphSummary', { tags: tagCount, files: fileCount })}
        </Typography>

        <Box sx={{ flex: 1 }} />

        <ToggleButtonGroup
          size="small"
          value={shown}
          onChange={(_e, next: TagCategory[]) => setShown(next)}
          aria-label={t('tagCloudFilter')}
        >
          {FILTERABLE_CATEGORIES.map((cat) => (
            <ToggleButton key={cat} value={cat} sx={{ px: 1, py: 0.25 }}>
              {t(CATEGORY_LABEL_KEY[cat])}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>

        <Tooltip title={t('fitView')}>
          <span>
            <IconButton
              size="small"
              onClick={() => fitSoon()}
              disabled={nodes.length === 0}
            >
              <FitScreenIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>

        <Tooltip title={t('saveImage')}>
          <span>
            <IconButton
              size="small"
              onClick={() => void handleSave()}
              disabled={saving || loading || nodes.length === 0 || readOnly}
            >
              <SaveIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>

        <Tooltip title={t('saveImageAs')}>
          <span>
            <IconButton
              size="small"
              onClick={() => void handleSaveAs()}
              disabled={saving || loading || nodes.length === 0 || readOnly}
            >
              <DriveFileMoveIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>

        <Tooltip title={t('copy')}>
          <span>
            <IconButton
              size="small"
              onClick={() => void onCopyToClipboard()}
              disabled={saving || loading || nodes.length === 0 || readOnly}
              aria-label={t('copy')}
            >
              <ContentCopyIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>

      {error ? <ErrorBanner message={error} /> : null}

      {loading ? (
        <LoadingOverlay label={t('loading')} />
      ) : nodes.length === 0 ? (
        <EmptyHint message={t('knowledgeGraphEmpty')} />
      ) : (
        <Box
          ref={wrapperRef}
          tabIndex={-1}
          sx={{
            flex: 1,
            minHeight: 0,
            borderRadius: 1,
            overflow: 'hidden',
            bgcolor: 'background.paper',
          }}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            colorMode={isDark ? 'dark' : 'light'}
            onInit={(inst) => {
              flowRef.current = inst;
              fitSoon();
            }}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={onNodeClick}
            onNodeDragStop={handleNodeDragStop}
            nodesConnectable={false}
            elementsSelectable
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={16} />
            <Controls showInteractive={false} />
            <MiniMap
              pannable
              zoomable
              // Show each node in its own type/tag color so the minimap is
              // a useful overview of the graph, not a uniform grey blob.
              nodeColor={(n) => {
                const d = n.data as TagNodeData | FileNodeData | undefined;
                if (!d || typeof (d as { color?: unknown }).color !== 'string') {
                  return undefined;
                }
                return (d as { color: string }).color;
              }}
            />
          </ReactFlow>
        </Box>
      )}

      <Menu
        open={ctxMenu !== null}
        onClose={() => setCtxMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={
          ctxMenu ? { top: ctxMenu.y, left: ctxMenu.x } : undefined
        }
      >
        <MenuItem
          onClick={() => {
            void handleSave();
            setCtxMenu(null);
          }}
          disabled={saving || loading || nodes.length === 0}
        >
          <ListItemIcon>
            <SaveIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t('saveImage')}</ListItemText>
        </MenuItem>
        <MenuItem
          onClick={() => {
            void handleSaveAs();
            setCtxMenu(null);
          }}
          disabled={saving || loading || nodes.length === 0}
        >
          <ListItemIcon>
            <DriveFileMoveIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t('saveImageAs')}</ListItemText>
        </MenuItem>
        <MenuItem
          onClick={() => {
            void onCopyToClipboard();
            setCtxMenu(null);
          }}
          disabled={saving || loading || nodes.length === 0}
        >
          <ListItemIcon>
            <ContentCopyIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t('copy')}</ListItemText>
        </MenuItem>
      </Menu>

      {/* Copy result notice (image vs base64 fallback), same pattern as
          FolderViz / TagCloud. */}
      <Snackbar
        open={notice !== null}
        autoHideDuration={2400}
        onClose={() => setNotice(null)}
        message={notice ?? ''}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </Box>
  );
}
