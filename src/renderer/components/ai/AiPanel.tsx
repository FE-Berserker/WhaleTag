import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import {
  Alert,
  Box,
  Button,
  Chip,
  IconButton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import SendIcon from '@mui/icons-material/Send';
import StopCircleIcon from '@mui/icons-material/StopCircle';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import AttachFileIcon from '@mui/icons-material/AttachFile';

import { setAiSettings } from '-/reducers/settings';
import { newConversation, rewindConversation } from '-/reducers/ai';
import type { RootState } from '-/reducers';
import type { ImageAttachment } from '../../../shared/ai-types';
import { useCurrentLocationContext } from '-/hooks/CurrentLocationContextProvider';
import { useFileSelectionContext } from '-/hooks/FileSelectionContextProvider';
import { useDirectoryUI } from '-/hooks/DirectoryContentContextProvider';
import { readPrefs } from '../../domain/perspective-prefs';
import { ipcApi } from '-/services/ipc-api';
import { useAiStream } from './useAiStream';
import MessageRenderer from './MessageRenderer';
import ApprovalModal from './ApprovalModal';
import { useConfirm } from '-/components/ConfirmDialogProvider';
import AiToolbar from './AiToolbar';
import AiTabs from './AiTabs';

/** Extensions whose contents are safe to inline as text context. */
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonc', 'js', 'jsx', 'ts', 'tsx', 'mjs',
  'cjs', 'html', 'htm', 'css', 'scss', 'less', 'yaml', 'yml', 'xml', 'csv',
  'tsv', 'ini', 'toml', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'sh',
  'sql', 'log',
]);
/** Don't inline files larger than this (bytes) — let the agent Read it instead. */
const MAX_INLINE_BYTES = 50_000;

/** localStorage key for the active Task sub-view (mirrors TaskView.tsx). */
const TASK_SUBVIEW_PREFS_KEY = 'whale-task-subview';

/** Coerce a persisted `whale-task-subview` value into a valid sub-view literal. */
function readTaskSubview(): 'kanban' | 'matrix' | 'gantt' | undefined {
  const prefs = readPrefs<{ subView?: string }>(TASK_SUBVIEW_PREFS_KEY);
  const v = prefs?.subView;
  return v === 'kanban' || v === 'matrix' || v === 'gantt' ? v : undefined;
}

/**
 * AI sidebar: a streaming chat panel against the embedded Claude Code CLI.
 * Rendered as the outermost right column in MainLayout. Phase B adds rich
 * rendering (markdown / tool-call cards / thinking), a model + permission
 * toolbar with a context gauge, a tool-call approval modal, and "ask about the
 * current file" context attachment.
 */
export default function AiPanel() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const width = useSelector((s: RootState) => s.settings.aiPanelWidth);
  const viewDepth = useSelector((s: RootState) => s.settings.viewDepth);
  const { currentLocation } = useCurrentLocationContext();
  const { selectedEntries } = useFileSelectionContext();
  const { viewMode } = useDirectoryUI();
  const { messages, streaming, error, clearError, usage, activeId, send, cancel } = useAiStream();
  const [input, setInput] = useState('');
  const [attachEnabled, setAttachEnabled] = useState(true);
  const hasConversations = useSelector(
    (s: RootState) => Object.keys(s.ai.conversations).length > 0
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const confirm = useConfirm();
  // Draft attachment handed over from a pdf-viewer marquee ("ask AI about
  // this region") via the `whale:ai-draft` CustomEvent. One-shot: consumed
  // by the next send. Not redux — must not survive a restart.
  const [pdfDraft, setPdfDraft] = useState<{
    path: string;
    page?: number;
    text: string;
    imageDataUrl?: string;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onDraft = (e: Event) => {
      const d = (
        e as CustomEvent<{
          path: string;
          page?: number;
          text: string;
          imageDataUrl?: string;
        }>
      ).detail;
      // Accept text and/or a screenshot — a scanned page has no text but
      // still carries the screenshot.
      if (!d || (!d.text && !d.imageDataUrl)) return;
      setPdfDraft(d);
      inputRef.current?.focus();
    };
    window.addEventListener('whale:ai-draft', onDraft);
    return () => window.removeEventListener('whale:ai-draft', onDraft);
  }, []);
  // Follow streaming output only while the user is already near the bottom —
  // scrolling up to read history must not yank the view back on every chunk.
  const nearBottomRef = useRef(true);

  // The single selected file becomes the AI's "current note" when attachment is
  // on. No selection or multi-selection → nothing attached.
  const attachedFile =
    attachEnabled && selectedEntries.length === 1 && selectedEntries[0].isFile
      ? selectedEntries[0]
      : null;
  // Multi-selection (2+ files): surface the selected PATHS so the agent knows
  // which set the user is asking about ("tag all of these urgent"). Single-file
  // selection flows through `attachedFile` (with content); no selection → none.
  const multiSelectPaths =
    selectedEntries.length >= 2
      ? selectedEntries.filter((e) => e.isFile).map((e) => e.path)
      : [];

  // Ensure there's at least one conversation to type into on first open.
  useEffect(() => {
    if (!hasConversations) {
      dispatch(
        newConversation(
          (crypto.randomUUID?.() ??
            `id-${Math.random().toString(36).slice(2)}-${Date.now()}`) as string
        )
      );
    }
  }, [hasConversations, dispatch]);

  // Keep the latest message in view as it streams — but only when the user
  // hasn't scrolled up. Sending a message always re-engages follow mode.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput('');
    nearBottomRef.current = true;
    let attachment: { path: string; content?: string } | null = null;
    if (pdfDraft) {
      // Marquee selection takes priority over the single-file attachment —
      // the user explicitly boxed the region they want to ask about. The
      // send() path wraps this in <current_note>; the inner tag preserves
      // the page provenance. Text may be empty (scanned page) — the
      // screenshot below carries the content then.
      attachment = {
        path: pdfDraft.path,
        ...(pdfDraft.text
          ? {
              content: `<pdf_selection page="${pdfDraft.page ?? '?'}">\n${pdfDraft.text}\n</pdf_selection>`,
            }
          : {}),
      };
    } else if (attachedFile) {
      attachment = { path: attachedFile.path };
      const ext = attachedFile.extension.toLowerCase();
      if (
        TEXT_EXTENSIONS.has(ext) &&
        attachedFile.size > 0 &&
        attachedFile.size <= MAX_INLINE_BYTES
      ) {
        try {
          attachment.content = await ipcApi.readTextFile(attachedFile.path);
        } catch {
          // Binary/unreadable — send the path only; the agent can Read it.
        }
      }
    }
    // Build the image attachment from the marquee screenshot (if any) — a
    // scanned page has no text but the model can still see the region.
    const draftImages: ImageAttachment[] = [];
    if (pdfDraft?.imageDataUrl) {
      const m = pdfDraft.imageDataUrl.match(/^data:(image\/[a-z]+);base64,(.+)$/i);
      if (m) {
        draftImages.push({
          id: `pdf-sel-${Date.now()}`,
          name: `pdf-p${pdfDraft.page ?? '?'}-selection.png`,
          mediaType: m[1].toLowerCase() as ImageAttachment['mediaType'],
          data: m[2],
          size: Math.floor(m[2].length * 0.75),
          source: 'paste',
        });
      }
    }
    setPdfDraft(null);
    // Capture the current perspective so the main process can inject a
    // Perspectives section into the system prompt (undefined when unrecognized
    // → the section is omitted gracefully).
    const perspective =
      viewMode === 'task'
        ? { viewMode, subview: readTaskSubview(), viewDepth }
        : viewMode
          ? { viewMode, viewDepth }
          : { viewDepth };
    void send(
      text,
      attachment,
      perspective,
      multiSelectPaths.length > 0 ? multiSelectPaths : undefined,
      draftImages.length > 0 ? draftImages : undefined
    );
  };

  return (
    <Box
      sx={{
        width,
        flexShrink: 0,
        borderLeft: 1,
        borderColor: 'divider',
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
      }}
    >
      <Box
        sx={{
          px: 1.5,
          py: 1,
          borderBottom: 1,
          borderColor: 'divider',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <SmartToyIcon fontSize="small" color="primary" />
          <Typography variant="overline" color="text.secondary">
            {t('aiPanelTitle')}
          </Typography>
        </Stack>
        <Tooltip title={t('close')}>
          <IconButton
            size="small"
            onClick={() => dispatch(setAiSettings({ aiPanelOpen: false }))}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>

      <AiTabs />

      <Box
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (el) {
            nearBottomRef.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }
        }}
        sx={{ flex: 1, overflowY: 'auto', p: 1.5 }}
      >
        {messages.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
            {currentLocation
              ? t('aiEmptyHint')
              : t('aiNoLocationHint')}
          </Typography>
        ) : (
          <Stack spacing={1.5} sx={{ display: 'flex' }}>
            {messages.map((m) => (
              <MessageRenderer
                key={m.id}
                message={m}
                onRewind={
                  activeId && !streaming
                    ? async (id) => {
                        if (await confirm({ message: t('aiRewindConfirm') })) {
                          dispatch(rewindConversation(activeId, id));
                        }
                      }
                    : undefined
                }
              />
            ))}
            {streaming &&
            !messages.some(
              (m) => m.role === 'assistant' && (m.content || '').length > 0
            ) ? (
              <Typography variant="body2" color="text.secondary" sx={{ alignSelf: 'flex-start' }}>
                …
              </Typography>
            ) : null}
          </Stack>
        )}
      </Box>

      {error ? (
        <Alert
          severity="error"
          sx={{ mx: 1, mb: 0.5, alignItems: 'flex-start' }}
          onClose={clearError}
        >
          {/* pre-wrap so multi-line claude.exe stderr (joined with \n upstream)
              renders as separate lines instead of collapsing to one. */}
          <Box sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{error}</Box>
        </Alert>
      ) : null}

      <AiToolbar usage={usage} />
      <Box sx={{ p: 1, borderTop: 1, borderColor: 'divider' }}>
        <Stack
          direction="row"
          sx={{
            alignItems: 'center',
            gap: 0.5,
            mb: attachedFile || multiSelectPaths.length > 0 || pdfDraft ? 0.5 : 0,
          }}
        >
          <Tooltip title={t('aiAttachToggle')}>
            <IconButton
              size="small"
              color={attachEnabled ? 'primary' : 'default'}
              onClick={() => setAttachEnabled((v) => !v)}
            >
              <AttachFileIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          {attachedFile ? (
            <Chip
              size="small"
              icon={<AttachFileIcon />}
              label={attachedFile.name}
              variant="outlined"
            />
          ) : null}
          {multiSelectPaths.length > 0 ? (
            <Chip
              size="small"
              icon={<AttachFileIcon />}
              label={t('aiMultiSelect', { count: multiSelectPaths.length })}
              variant="outlined"
              color="primary"
            />
          ) : null}
          {pdfDraft ? (
            <Chip
              size="small"
              icon={<AttachFileIcon />}
              label={
                pdfDraft.text
                  ? t('aiPdfSelection', { page: pdfDraft.page ?? '?' })
                  : t('aiPdfScreenshot', { page: pdfDraft.page ?? '?' })
              }
              variant="outlined"
              color="primary"
              onDelete={() => setPdfDraft(null)}
            />
          ) : null}
        </Stack>
        <TextField
          multiline
          minRows={1}
          maxRows={6}
          size="small"
          fullWidth
          inputRef={inputRef}
          placeholder={
            currentLocation ? t('aiInputPlaceholder') : t('aiNoLocationHint')
          }
          value={input}
          disabled={!currentLocation}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // isComposing: CJK IME users press Enter to commit the candidate
            // — that must not send the half-composed text.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              handleSend();
            }
          }}
        />
        <Stack direction="row" sx={{ justifyContent: 'flex-end', mt: 0.5 }}>
          {streaming ? (
            <Button
              size="small"
              color="error"
              startIcon={<StopCircleIcon />}
              onClick={cancel}
            >
              {t('aiStop')}
            </Button>
          ) : (
            <Button
              size="small"
              variant="contained"
              disabled={!currentLocation || !input.trim()}
              startIcon={<SendIcon />}
              onClick={handleSend}
            >
              {t('aiSend')}
            </Button>
          )}
        </Stack>
      </Box>
      <ApprovalModal />
    </Box>
  );
}
