import path from 'path';
import { stat } from 'fs/promises';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { request } from '../index-worker-host';
import {
  assertWithinAllowedRoot,
  onAllowedRootsChanged,
} from '../allowed-roots';
import { readSidecardsForPaths, updateFileTags, mutateSidecar } from '../sidecar';
import { readTagLibrary } from '../tag-library';
import { extractText } from '../fulltext';
import { readTextFile, listDirectory } from '../ipc/fs-read';
import {
  moveEntry,
  copyEntry,
  createDirectory,
  createTextFile,
  deletePath,
  zipEntries,
} from '../ipc/fs-write';
import { normalizeSmartTags } from '../../shared/smart-tags';
import { loadMcpConfig } from './mcp-config';
import { requestApproval } from './mcp-approval';

/**
 * Tool surface exposed to external AI clients over the local MCP server
 * (docs/21). Three groups, matching the workflows the server exists for:
 *
 *   discovery  — search / list tags / browse  (read-only, no approval)
 *   reading    — file text + sidecar metadata (read-only, no approval;
 *                this is the input side of "summarize my documents")
 *   organizing — tags & description (sidecar-only, auto-allowed: they never
 *                touch user files) and file operations move/copy/delete/zip/
 *                create (user approval dialog, fail-closed).
 *
 * Every tool routes through the same main-process modules the renderer's IPC
 * uses — nothing re-implements FS logic here, so allowed-roots confinement,
 * sidecar co-movement, the recycle bin and the index worker all apply
 * verbatim.
 */

/** Raw (display-correct) roots as last pushed by the renderer. */
let rawRoots: string[] = [];

/**
 * MCP is stricter than the renderer-facing IPC: BOTH ends of a mutation must
 * sit inside configured locations (the renderer's own move/copy exempt the
 * destination for drag-and-drop UX; an external client gets no such leeway).
 */
function assertBothEndsInside(source: string, dest: string): void {
  assertWithinAllowedRoot(source);
  assertWithinAllowedRoot(dest);
}

function fail(tool: string, e: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  const message = e instanceof Error ? e.message : String(e);
  return {
    content: [{ type: 'text', text: `${tool} failed: ${message}` }],
    isError: true,
  };
}

type TextResult = { content: { type: 'text'; text: string }[] };
function ok(data: unknown): TextResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 1) }] };
}

function ensureWritable(): void {
  if (loadMcpConfig().readOnly) {
    throw new Error('server is in read-only mode (enable writes in WhaleTag settings)');
  }
}

/**
 * Mutating file ops gate: read-only check first, then the user approval
 * dialog. Resolves true only when the user explicitly allowed it.
 */
async function approve(tool: string, summary: string, details: string[]): Promise<void> {
  ensureWritable();
  const allowed = await requestApproval({ tool, summary, details });
  if (!allowed) {
    throw new Error('the user denied this operation');
  }
}

/** Approval-dialog details: FULL paths (basenames hide too much from the
 *  user), capped with an explicit count of what is not shown. */
function shortList(items: string[], max = 20): string[] {
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  return rest > 0 ? [...shown, `… and ${rest} more not shown`] : shown;
}

/** Register every tool on a (per-session) McpServer instance. */
export function registerMcpTools(server: McpServer): void {
  // ---- discovery ----------------------------------------------------------

  server.registerTool(
    'whale_roots',
    {
      title: 'Configured locations',
      description:
        'List the location roots WhaleTag has open, with their search-index status. ' +
        'All other tools require a rootPath from this list. Call this first.',
    },
    async () => {
      try {
        const roots = await Promise.all(
          rawRoots.map(async (rootPath) => {
            try {
              const status = await request('index:status', { rootPath });
              let fulltext = false;
              try {
                fulltext = await request('fulltext:has', { rootPath });
              } catch {
                fulltext = false;
              }
              return { rootPath, ...status, fulltextIndexed: fulltext };
            } catch {
              return { rootPath, count: 0, ready: false, fulltextIndexed: false };
            }
          })
        );
        return ok({ roots, readOnly: loadMcpConfig().readOnly });
      } catch (e) {
        return fail('whale_roots', e);
      }
    }
  );

  server.registerTool(
    'whale_search',
    {
      title: 'Search files',
      description:
        'FTS trigram search over file names, paths and tags within a location. ' +
        'Best for "find files like X". Use whale_advanced_search for tag/size/date filters.',
      inputSchema: {
        rootPath: z.string().describe('Location root from whale_roots'),
        q: z.string().min(1).describe('Search text (matches name/path/tags)'),
        limit: z.number().int().min(1).max(50).default(25).describe('Max results (server caps at 50)'),
      },
    },
    async ({ rootPath, q, limit }) => {
      try {
        assertWithinAllowedRoot(rootPath);
        const hits = await request('index:query', { rootPath, q });
        return ok({ count: hits.length, results: hits.slice(0, limit) });
      } catch (e) {
        return fail('whale_search', e);
      }
    }
  );

  server.registerTool(
    'whale_advanced_search',
    {
      title: 'Advanced search',
      description:
        'Structured file search: all filters AND together. Tag names match the ' +
        'location vocabulary (see whale_list_tags). Sizes in bytes, times in epoch ms.',
      inputSchema: {
        rootPath: z.string(),
        text: z.string().default(''),
        tags: z.array(z.string()).default([]),
        tagMatch: z.enum(['all', 'any']).default('all'),
        excludeTags: z.array(z.string()).default([]),
        type: z.enum(['any', 'files', 'folders']).default('any'),
        extensions: z.array(z.string()).default([]),
        sizeMinBytes: z.number().int().nullable().default(null),
        sizeMaxBytes: z.number().int().nullable().default(null),
        modifiedAfter: z.number().int().nullable().default(null),
        modifiedBefore: z.number().int().nullable().default(null),
        limit: z.number().int().min(1).max(300).default(50),
      },
    },
    async ({ rootPath, limit, ...query }) => {
      try {
        assertWithinAllowedRoot(rootPath);
        const hits = await request('index:advanced', {
          rootPath,
          q: {
            text: query.text ?? '',
            tags: query.tags ?? [],
            tagMatch: query.tagMatch ?? 'all',
            excludeTags: query.excludeTags ?? [],
            type: query.type ?? 'any',
            extensions: query.extensions ?? [],
            sizeMinBytes: query.sizeMinBytes ?? null,
            sizeMaxBytes: query.sizeMaxBytes ?? null,
            modifiedAfter: query.modifiedAfter ?? null,
            modifiedBefore: query.modifiedBefore ?? null,
          },
        });
        return ok({ count: hits.length, results: hits.slice(0, limit) });
      } catch (e) {
        return fail('whale_advanced_search', e);
      }
    }
  );

  server.registerTool(
    'whale_fulltext_search',
    {
      title: 'Search file contents',
      description:
        'Full-text search over document CONTENTS (text, code, md, PDF…) with a match ' +
        'snippet per hit. Requires the location to be fulltext-indexed; if it is not, ' +
        'call whale_build_fulltext first.',
      inputSchema: {
        rootPath: z.string(),
        q: z.string().min(1),
        limit: z.number().int().min(1).max(100).default(25),
      },
    },
    async ({ rootPath, q, limit }) => {
      try {
        assertWithinAllowedRoot(rootPath);
        const hits = await request('fulltext:search', { rootPath, q });
        return ok({ count: hits.length, results: hits.slice(0, limit) });
      } catch (e) {
        return fail('whale_fulltext_search', e);
      }
    }
  );

  server.registerTool(
    'whale_build_fulltext',
    {
      title: 'Build full-text index',
      description:
        '(Re)build the content index for a location (incremental — only changed files ' +
        'are re-extracted). Needed once before whale_fulltext_search works. Can take a ' +
        'while on large locations.',
      inputSchema: { rootPath: z.string() },
    },
    async ({ rootPath }) => {
      try {
        assertWithinAllowedRoot(rootPath);
        const res = await request('fulltext:build', { rootPath });
        return ok({ indexed: res.count });
      } catch (e) {
        return fail('whale_build_fulltext', e);
      }
    }
  );

  server.registerTool(
    'whale_list_tags',
    {
      title: 'List tags',
      description:
        'All tags present in the location index plus the tag library descriptions ' +
        '(the location vocabulary). Use these exact names with whale_apply_tags.',
      inputSchema: { rootPath: z.string() },
    },
    async ({ rootPath }) => {
      try {
        assertWithinAllowedRoot(rootPath);
        const [tags, library] = await Promise.all([
          request('index:tags', { rootPath }),
          readTagLibrary(rootPath),
        ]);
        return ok({ tags, descriptions: library });
      } catch (e) {
        return fail('whale_list_tags', e);
      }
    }
  );

  server.registerTool(
    'whale_list_directory',
    {
      title: 'List a directory',
      description: 'One level of a directory (folders first, alphabetical).',
      inputSchema: {
        path: z.string().describe('Absolute directory path'),
      },
    },
    async ({ path: dirPath }) => {
      try {
        assertWithinAllowedRoot(dirPath);
        const entries = await listDirectory(dirPath);
        return ok({
          count: entries.length,
          entries: entries.map((e) => ({
            name: e.name,
            path: e.path,
            isDirectory: e.isDirectory,
            size: e.size,
            modified: e.modified,
            extension: e.extension,
          })),
        });
      } catch (e) {
        return fail('whale_list_directory', e);
      }
    }
  );

  // ---- reading ------------------------------------------------------------

  server.registerTool(
    'whale_read_text',
    {
      title: 'Read a text file',
      description:
        'Read a text file as UTF-8 (legacy encodings like GBK auto-detected). Returns ' +
        'a character window via offset/limit plus totalLength for paging.',
      inputSchema: {
        path: z.string(),
        offset: z.number().int().min(0).default(0).describe('Character offset to start at'),
        limit: z.number().int().min(1).max(200000).default(20000).describe('Max characters to return'),
      },
    },
    async ({ path: filePath, offset, limit }) => {
      try {
        assertWithinAllowedRoot(filePath);
        const text = await readTextFile(filePath);
        const totalLength = text.length;
        const slice = text.slice(offset, offset + limit);
        return ok({
          totalLength,
          offset,
          returned: slice.length,
          truncated: offset + slice.length < totalLength,
          text: slice,
        });
      } catch (e) {
        return fail('whale_read_text', e);
      }
    }
  );

  server.registerTool(
    'whale_extract_text',
    {
      title: 'Extract document text',
      description:
        'Extract plain text for summarization from a single document — supports PDF ' +
        '(via pdf.js), HTML (tags stripped) and text-like files (md, code, configs). ' +
        'Whitespace is collapsed and the result is capped. For plain text files with ' +
        'exact formatting / paging prefer whale_read_text.',
      inputSchema: { path: z.string() },
    },
    async ({ path: filePath }) => {
      try {
        assertWithinAllowedRoot(filePath);
        const info = await stat(filePath);
        const ext = path.extname(filePath).slice(1).toLowerCase();
        const text = await extractText(filePath, ext, info.size);
        if (text === null) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `whale_extract_text: no extractable text (${ext || 'no extension'}; office formats are not supported)`,
              },
            ],
            isError: true,
          };
        }
        return ok({ path: filePath, length: text.length, text });
      } catch (e) {
        return fail('whale_extract_text', e);
      }
    }
  );

  server.registerTool(
    'whale_get_meta',
    {
      title: 'Read file metadata',
      description:
        "Batch-read WhaleTag sidecar metadata (tags, description, color) for up to 200 " +
        'files. Paths without metadata are omitted. Note: files can also carry tags ' +
        'embedded in their name (name[tag1 tag2].ext) — those appear in search results.',
      inputSchema: {
        paths: z.array(z.string()).min(1).max(200),
      },
    },
    async ({ paths }) => {
      try {
        for (const p of paths) assertWithinAllowedRoot(p);
        const metas = await readSidecardsForPaths(paths);
        return ok({ metas });
      } catch (e) {
        return fail('whale_get_meta', e);
      }
    }
  );

  // ---- organizing: metadata (sidecar-only, auto-allowed) ------------------

  server.registerTool(
    'whale_apply_tags',
    {
      title: 'Add/remove tags',
      description:
        'Add and/or remove tags on files. Merge-safe against concurrent UI edits; ' +
        'existing tags/description are preserved. Stored in .whale/ sidecar metadata ' +
        '— user file names and contents are never modified.',
      inputSchema: {
        paths: z.array(z.string()).min(1).max(500),
        add: z.array(z.string()).max(50).default([]),
        remove: z.array(z.string()).max(50).default([]),
      },
    },
    async ({ paths, add, remove }) => {
      try {
        ensureWritable();
        const removeSet = new Set(remove ?? []);
        const results: unknown[] = [];
        const errors: { path: string; error: string }[] = [];
        for (const p of paths) {
          try {
            assertWithinAllowedRoot(p);
            const res = await updateFileTags(p, (current) => {
              const kept = current.filter((t) => !removeSet.has(t));
              // Normalize smart tags (rating/workflow/quadrant/date) exactly
              // like the renderer's tag-edit paths — an external client must
              // not write shapes the UI would never produce.
              return normalizeSmartTags([...kept, ...(add ?? [])]);
            });
            results.push({ path: p, before: res.before, after: res.after });
          } catch (e) {
            errors.push({ path: p, error: e instanceof Error ? e.message : String(e) });
          }
        }
        return ok({ updated: results.length, results, errors });
      } catch (e) {
        return fail('whale_apply_tags', e);
      }
    }
  );

  server.registerTool(
    'whale_write_description',
    {
      title: 'Write a description',
      description:
        "Write a file's description (sidecar metadata, visible and searchable in " +
        'WhaleTag). This is the recommended landing spot for summaries: it lives in ' +
        '.whale/ metadata and never touches the user file itself.',
      inputSchema: {
        path: z.string(),
        description: z.string().max(10000),
      },
    },
    async ({ path: filePath, description }) => {
      try {
        ensureWritable();
        assertWithinAllowedRoot(filePath);
        // Locked read-modify-write so a concurrent tag edit to the same file
        // can't be clobbered by a stale snapshot (merge-over-wipe).
        await mutateSidecar(filePath, (current) => ({
          ...current,
          description,
        }));
        return ok({ path: filePath, descriptionLength: description.length });
      } catch (e) {
        return fail('whale_write_description', e);
      }
    }
  );

  // ---- organizing: file operations (approval-gated) -----------------------

  server.registerTool(
    'whale_move_files',
    {
      title: 'Move files',
      description:
        'Move files/folders into a destination folder. Never overwrites (a name clash ' +
        'fails that entry). Sidecar metadata and thumbnails move along automatically. ' +
        'Requires user approval in the WhaleTag window.',
      inputSchema: {
        paths: z.array(z.string()).min(1).max(200),
        destDir: z.string().describe('Destination directory (must be inside a configured location)'),
      },
    },
    async ({ paths, destDir }) => {
      try {
        // Validate BEFORE asking the user — never spend a 60s approval
        // window on a request that can't run anyway.
        for (const p of paths) {
          assertBothEndsInside(p, path.join(destDir, path.basename(p)));
        }
        await approve(
          'whale_move_files',
          `Move ${paths.length} item${paths.length === 1 ? '' : 's'} to ${destDir}`,
          shortList(paths)
        );
        const errors: { path: string; error: string }[] = [];
        let moved = 0;
        for (const p of paths) {
          try {
            await moveEntry(p, path.join(destDir, path.basename(p)));
            moved += 1;
          } catch (e) {
            errors.push({ path: p, error: e instanceof Error ? e.message : String(e) });
          }
        }
        return ok({ moved, errors });
      } catch (e) {
        return fail('whale_move_files', e);
      }
    }
  );

  server.registerTool(
    'whale_copy_files',
    {
      title: 'Copy files',
      description:
        'Copy files/folders into a destination folder (recursive). Never overwrites. ' +
        'Sidecar metadata and thumbnails are carried along. Requires user approval.',
      inputSchema: {
        paths: z.array(z.string()).min(1).max(200),
        destDir: z.string(),
      },
    },
    async ({ paths, destDir }) => {
      try {
        for (const p of paths) {
          assertBothEndsInside(p, path.join(destDir, path.basename(p)));
        }
        await approve(
          'whale_copy_files',
          `Copy ${paths.length} item${paths.length === 1 ? '' : 's'} to ${destDir}`,
          shortList(paths)
        );
        const errors: { path: string; error: string }[] = [];
        let copied = 0;
        for (const p of paths) {
          try {
            await copyEntry(p, path.join(destDir, path.basename(p)));
            copied += 1;
          } catch (e) {
            errors.push({ path: p, error: e instanceof Error ? e.message : String(e) });
          }
        }
        return ok({ copied, errors });
      } catch (e) {
        return fail('whale_copy_files', e);
      }
    }
  );

  server.registerTool(
    'whale_create_folder',
    {
      title: 'Create a folder',
      description: 'Create a folder (idempotent). Requires user approval.',
      inputSchema: { path: z.string() },
    },
    async ({ path: dirPath }) => {
      try {
        assertWithinAllowedRoot(dirPath);
        await approve('whale_create_folder', `Create folder ${dirPath}`, [dirPath]);
        await createDirectory(dirPath);
        return ok({ created: dirPath });
      } catch (e) {
        return fail('whale_create_folder', e);
      }
    }
  );

  server.registerTool(
    'whale_delete_files',
    {
      title: 'Delete files (recycle bin)',
      description:
        'Move files/folders to the OS recycle bin (recoverable). Sidecar metadata is ' +
        'cleaned up. Requires user approval. Permanent deletion is not offered.',
      inputSchema: { paths: z.array(z.string()).min(1).max(200) },
    },
    async ({ paths }) => {
      try {
        for (const p of paths) assertWithinAllowedRoot(p);
        await approve(
          'whale_delete_files',
          `Delete ${paths.length} item${paths.length === 1 ? '' : 's'} (to recycle bin)`,
          shortList(paths)
        );
        const errors: { path: string; error: string }[] = [];
        let deleted = 0;
        for (const p of paths) {
          try {
            await deletePath(p, true);
            deleted += 1;
          } catch (e) {
            errors.push({ path: p, error: e instanceof Error ? e.message : String(e) });
          }
        }
        return ok({ deleted, errors });
      } catch (e) {
        return fail('whale_delete_files', e);
      }
    }
  );

  server.registerTool(
    'whale_zip_files',
    {
      title: 'Zip files',
      description:
        'Package files/folders into a zip archive (OS tool, no size limit). The archive ' +
        'path must not exist yet. Requires user approval.',
      inputSchema: {
        paths: z.array(z.string()).min(1).max(500),
        zipPath: z.string().describe('Absolute archive path to create (must not exist)'),
      },
    },
    async ({ paths, zipPath }) => {
      try {
        for (const p of paths) assertWithinAllowedRoot(p);
        assertWithinAllowedRoot(zipPath);
        await approve(
          'whale_zip_files',
          `Zip ${paths.length} item${paths.length === 1 ? '' : 's'} to ${zipPath}`,
          shortList(paths)
        );
        const archive = await zipEntries(paths, zipPath);
        return ok({ archive });
      } catch (e) {
        return fail('whale_zip_files', e);
      }
    }
  );

  server.registerTool(
    'whale_create_text_file',
    {
      title: 'Create a text file',
      description:
        'Create a UTF-8 text file (e.g. a Markdown report consolidating findings). ' +
        'Refuses to overwrite an existing file. Requires user approval.',
      inputSchema: {
        path: z.string(),
        content: z.string().max(1000000),
      },
    },
    async ({ path: filePath, content }) => {
      try {
        assertWithinAllowedRoot(filePath);
        await approve(
          'whale_create_text_file',
          `Create file ${filePath} (${content.length} chars)`,
          [filePath]
        );
        await createTextFile(filePath, content);
        return ok({ created: filePath, bytes: content.length });
      } catch (e) {
        return fail('whale_create_text_file', e);
      }
    }
  );
}

/** Keep rawRoots in sync with renderer pushes (called by mcp-server init). */
export function watchRawRoots(): () => void {
  return onAllowedRootsChanged((roots) => {
    rawRoots = roots;
  });
}
