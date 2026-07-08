/**
 * Whale-defined tools for HTTP providers (Ollama / OpenAI-compatible).
 *
 * Unlike the Claude CLI path — where the CLI's OWN tools touch the disk and
 * Whale only gates them — here Whale both DEFINES and EXECUTES the tools. So
 * they're naturally confined to `allowedRoots` (the configured locations) via
 * `assertWithinAllowedRoot`, and writes go through atomic, merge-safe writes —
 * the original roadmap's "Whale-constrained tools" model.
 *
 * The read-only location guard + approval modal are reused: the HTTP provider
 * calls the shared `decideToolCall` gate before executing any tool, so writes
 * prompt the user exactly as they do on the Claude path.
 */
import { promises as fsp } from 'fs';
import * as path from 'path';

import { assertWithinAllowedRoot } from '../../../allowed-roots';
import { atomicWriteText } from '../../../atomic-write';
import { backupRevision } from '../../../revisions';
import { readTagLibrary } from '../../../tag-library';
import { updateFileTags } from '../../../sidecar';
import {
  META_DIR,
  FOLDER_SIDECAR_FILE,
  type SidecarMeta,
} from '../../../../shared/whale-meta';
import { normalizeSmartTags, isPeriodTag } from '../../../../shared/smart-tags';

/** OpenAI function-calling tool descriptor. */
export interface ToolDescriptor {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON schema
  };
}

/** A parsed tool call from the model. */
export interface ParsedToolCall {
  id: string;
  name: string;
  /** Raw arguments string (JSON) from the model. */
  arguments: string;
}

const MAX_READ_BYTES = 50_000;
const MAX_LIST_ENTRIES = 500;

/**
 * The tools Whale advertises to HTTP models. Read tools (read_file /
 * list_directory) are low-risk; write_file mutates and is gated by the approval
 * flow. The `write` set is consulted by the shared gate.
 */
export const READ_TOOLS = new Set(['read_file', 'list_directory', 'list_tags']);
export const WRITE_TOOLS = new Set(['write_file', 'apply_tag']);

export const TOOL_DESCRIPTORS: ToolDescriptor[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a UTF-8 text file under the current location. Returns the (possibly truncated) contents.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute path to the file.' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List entries in a directory under the current location.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute path to the directory.' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tags',
      description:
        "List the tags in use under a directory plus the location's tag-library descriptions. " +
        'Pass a directory path (or a file path; its parent is used). The tag library ' +
        '(`wtaglib.json`) is shared per location, so the tool walks up to find it. ' +
        'Returns JSON: { "tagsByFile": { "<basename>": ["tag", ...] }, "descriptions": { "<tag>": "<desc>" } }. ' +
        'Use this to answer "what tags do I have" or "which files carry workflow:in-progress" ' +
        'before suggesting tag edits. Read-only — never prompts.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to a directory (or file) under the current location.',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Write text content to a file under the current location (overwrites). Requires user approval.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file.' },
          content: { type: 'string', description: 'The full text content to write.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_tag',
      description:
        'Add or remove a tag on a file by editing its portable sidecar (.whale/wsd.json). ' +
        'Tags drive every Whale perspective — adding `in-progress` (a workflow smart tag) ≈ ' +
        'moving the file to that Kanban column; `urgent-important` (a quadrant tag) ≈ Matrix ' +
        'quadrant; `20260706-20260720` (a period range) schedules it on the Gantt timeline. ' +
        'All smart tags are stored BARE — workflow/quadrant/rating tags have no ' +
        '`workflow:`/`quadrant:`/rating prefix and period tags have no `period:` prefix ' +
        '(use `in-progress` not `workflow:in-progress`; `20260706-20260720` not ' +
        '`period:20260706-20260720`). Mutually-exclusive families are normalized ' +
        'automatically (a new workflow tag replaces the old one; one ' +
        'rating/quadrant/period/date per file). Requires user approval.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file to tag.' },
          tag: {
            type: 'string',
            description:
              'The tag to add or remove, verbatim. Examples (all bare): "in-progress" ' +
              '(workflow), "urgent-important" (quadrant), "20260706-20260720" (period), ' +
              '"3star" (rating), "idea" (free text).',
          },
          mode: {
            type: 'string',
            enum: ['add', 'remove'],
            description: 'Add the tag (default) or remove it.',
          },
        },
        required: ['path', 'tag'],
      },
    },
  },
];

/** Parse the model's raw arguments JSON, tolerating malformed input. */
export function parseArguments(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Execute one tool call. Confines every path to the configured locations via
 * `assertWithinAllowedRoot` (throws → returned as an error string, never thrown
 * to the caller). Returns the tool-result string the model will see.
 */
export async function executeTool(
  call: ParsedToolCall
): Promise<{ content: string; isError: boolean }> {
  const args = parseArguments(call.arguments);
  const target = typeof args.path === 'string' ? args.path : '';
  try {
    if (call.name === 'read_file') {
      if (!target) return err('missing "path"');
      assertWithinAllowedRoot(target);
      const buf = await fsp.readFile(target);
      const text = buf.subarray(0, MAX_READ_BYTES).toString('utf8');
      const truncated = buf.length > MAX_READ_BYTES;
      return { content: truncated ? `${text}\n…[truncated]` : text, isError: false };
    }
    if (call.name === 'list_directory') {
      if (!target) return err('missing "path"');
      assertWithinAllowedRoot(target);
      const names = await fsp.readdir(target);
      const rows: string[] = [];
      for (const name of names.slice(0, MAX_LIST_ENTRIES)) {
        try {
          const st = await fsp.stat(path.join(target, name));
          rows.push(st.isDirectory() ? `${name}/` : name);
        } catch {
          rows.push(name);
        }
      }
      const more = names.length > MAX_LIST_ENTRIES ? `\n…[+${names.length - MAX_LIST_ENTRIES}]` : '';
      return { content: rows.join('\n') + more, isError: false };
    }
    if (call.name === 'list_tags') {
      if (!target) return err('missing "path"');
      assertWithinAllowedRoot(target);
      let dirPath: string;
      try {
        const st = await fsp.stat(target);
        dirPath = st.isDirectory() ? target : path.dirname(target);
      } catch {
        return err(`path not found: ${target}`);
      }
      const tagsByFile = await readWsdTagsByFile(dirPath);
      const locationRoot = await findLocationRoot(dirPath);
      const descriptions = locationRoot
        ? await readTagLibrary(locationRoot)
        : {};
      const filteredDescriptions: Record<string, string> = {};
      // Only surface descriptions for tags actually present (don't dump the
      // entire library when the directory is mostly untagged).
      const usedTags = new Set<string>();
      for (const tags of Object.values(tagsByFile)) {
        for (const t of tags) usedTags.add(t);
      }
      for (const [t, d] of Object.entries(descriptions)) {
        if (usedTags.has(t)) filteredDescriptions[t] = d;
      }
      return {
        content: JSON.stringify(
          { tagsByFile, descriptions: filteredDescriptions },
          null,
          2
        ),
        isError: false,
      };
    }
    if (call.name === 'write_file') {
      const content = typeof args.content === 'string' ? args.content : '';
      if (!target) return err('missing "path"');
      assertWithinAllowedRoot(target);
      // Back up the existing content to `.whale/revisions/` BEFORE overwriting,
      // so an AI write is recoverable via the existing revision-history dialog
      // (the manual "file rewind"). Silent if the file doesn't exist yet.
      try {
        await backupRevision(target);
      } catch {
        // best-effort — don't block the write on a backup failure
      }
      await atomicWriteText(target, content);
      return { content: `Wrote ${content.length} chars to ${target}.`, isError: false };
    }
    if (call.name === 'apply_tag') {
      const tag = typeof args.tag === 'string' ? args.tag.trim() : '';
      const mode = args.mode === 'remove' ? 'remove' : 'add';
      if (!target) return err('missing "path"');
      if (!tag) return err('missing or empty "tag"');
      assertWithinAllowedRoot(target);
      // Period tags have NO `period:` prefix in sidecar storage — the bare
      // `YYYYMMDD-YYYYMMDD` is what `isPeriodTag` / `dateTagRangeKey` recognize and
      // what the Gantt view reads. A `period:` prefix only appears as a UI chip
      // affordance; storage uses bare ranges.
      if (tag.startsWith('period:')) {
        const stripped = tag.slice('period:'.length);
        if (isPeriodTag(stripped)) {
          return err(
            `Period tags have no "period:" prefix in storage. ` +
              `Pass "${stripped}" (the bare YYYYMMDD-YYYYMMDD range), not "${tag}".`
          );
        }
        return err(
          `Tag "${tag}" starts with "period:" but the rest is not a valid ` +
            `YYYYMMDD-YYYYMMDD range.`
        );
      }
      // Must be a file (apply_tag on a directory makes no sense — tags live on
      // per-file sidecars keyed by basename).
      let stat;
      try {
        stat = await fsp.stat(target);
      } catch {
        stat = null;
      }
      if (stat?.isDirectory()) {
        return err(
          `Target is a directory; apply_tag needs a file path: ${target}`
        );
      }
      // Best-effort backup of the directory's aggregated sidecar BEFORE the
      // merge. Lands at <dir>/.whale/revisions/wsd.json/<ts>.json — covered by
      // the 30-day cleanup sweep (`cleanupRevisionsForLocation` recurses). The
      // RevisionHistoryDialog UI is keyed on file paths, so this backup is
      // operator-recoverable rather than user-visible (per docs/11-ai.md §16.2 #4).
      try {
        await backupRevision(
          path.join(path.dirname(target), META_DIR, FOLDER_SIDECAR_FILE)
        );
      } catch {
        // best-effort — don't block the tag write on a backup failure
      }
      const { before, after } = await updateFileTags(target, (current) => {
        const without = current.filter((t) => t !== tag);
        if (mode === 'remove') return without;
        // Adding: place the new tag last (so `withSingleFrom`'s "last wins"
        // semantics pick it over any existing same-family member), then
        // normalize so mutually-exclusive families collapse correctly.
        return normalizeSmartTags([...without, tag]);
      });
      if (mode === 'remove' && !before.includes(tag)) {
        return {
          content: `No-op: "${target}" did not carry tag "${tag}".`,
          isError: false,
        };
      }
      return {
        content:
          `${mode === 'remove' ? 'Removed' : 'Applied'} tag "${tag}" ` +
          `on ${target}.\nBefore: ${
            before.length ? before.join(', ') : '(none)'
          }\nAfter: ${after.length ? after.join(', ') : '(none)'}`,
        isError: false,
      };
    }
    return err(`unknown tool: ${call.name}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

function err(message: string): { content: string; isError: boolean } {
  return { content: message, isError: true };
}

/**
 * Read a directory's aggregated sidecar (`.whale/wsd.json`) and project it to
 * a `{ basename: string[] }` tag map. Files without tags are absent (sparse
 * sidecar). Returns `{}` when wsd.json is missing / unparseable — the
 * directory is simply untagged so far, not an error.
 */
async function readWsdTagsByFile(
  dirPath: string
): Promise<Record<string, string[]>> {
  const wsdPath = path.join(dirPath, META_DIR, FOLDER_SIDECAR_FILE);
  let raw: string;
  try {
    raw = await fsp.readFile(wsdPath, 'utf8');
  } catch {
    return {}; // No sidecar yet — directory has no tags.
  }
  try {
    const parsed = JSON.parse(raw) as {
      files?: Record<string, SidecarMeta>;
    };
    const files = parsed?.files;
    if (!files || typeof files !== 'object') return {};
    const out: Record<string, string[]> = {};
    for (const [name, meta] of Object.entries(files)) {
      const tags = meta?.tags;
      if (Array.isArray(tags) && tags.length > 0) {
        out[name] = tags.filter((t) => typeof t === 'string');
      }
    }
    return out;
  } catch {
    return {}; // Corrupt sidecar — treat as untagged rather than fail.
  }
}

/**
 * Walk up from `dirPath` to the nearest ancestor that owns a
 * `.whale/wtaglib.json` (the per-location tag library lives at a location
 * root). Returns `null` when no ancestor carries one — caller then treats
 * the vocabulary as empty. Stops at the filesystem root.
 */
async function findLocationRoot(dirPath: string): Promise<string | null> {
  let cur = path.resolve(dirPath);
  // Guard against an infinite loop on Windows when resolve hits the drive root
  // (e.g. `C:\` — whose dirname is `C:\`).
  let prev = '';
  for (let i = 0; i < 64; i++) {
    const libPath = path.join(cur, META_DIR, 'wtaglib.json');
    try {
      await fsp.access(libPath);
      return cur;
    } catch {
      // not present here — keep walking up
    }
    const parent = path.dirname(cur);
    if (parent === cur || parent === prev) return null;
    prev = cur;
    cur = parent;
  }
  return null;
}
