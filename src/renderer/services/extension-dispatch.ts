import type { DirEntry } from '../../shared/ipc-types';
import type {
  ExtensionManifest,
  ExtensionRegistry,
} from '../../shared/extension-types';

export interface DispatchContext {
  registry: ExtensionRegistry | null;
  userDefaults: Record<string, string>;
  enabledOverrides: Record<string, boolean>;
}

function isEnabled(
  manifest: ExtensionManifest,
  enabledOverrides: Record<string, boolean>
): boolean {
  const override = enabledOverrides[manifest.id];
  return override !== undefined ? override : manifest.enabled;
}

function extOf(name: string): string {
  return name.includes('.')
    ? name.slice(name.lastIndexOf('.') + 1).toLowerCase()
    : '';
}

function compatibleExtensions(
  entry: DirEntry,
  registry: ExtensionRegistry,
  enabledOverrides: Record<string, boolean>
): ExtensionManifest[] {
  const ext = extOf(entry.name);
  return registry.extensions.filter(
    (m) => m.fileTypes.includes(ext) && isEnabled(m, enabledOverrides)
  );
}

/**
 * Returns all enabled extensions that can open this file, ordered as they
 * appear in the registry.
 */
export function getCompatibleExtensions(
  entry: DirEntry,
  context: DispatchContext
): ExtensionManifest[] {
  if (!context.registry) return [];
  return compatibleExtensions(entry, context.registry, context.enabledOverrides);
}

/**
 * Selects the best extension for a file.
 * Priority: user default > isDefault extension > first compatible viewer.
 * If both a viewer and editor match and no default is set, viewer wins.
 */
export function selectExtension(
  entry: DirEntry,
  context: DispatchContext
): ExtensionManifest | null {
  const candidates = getCompatibleExtensions(entry, context);
  if (candidates.length === 0) return null;

  const ext = extOf(entry.name);
  const userDefaultId = context.userDefaults[ext];
  if (userDefaultId) {
    const userDefault = candidates.find((m) => m.id === userDefaultId);
    if (userDefault) return userDefault;
  }

  const defaultExt = candidates.find((m) => m.isDefault);
  if (defaultExt) return defaultExt;

  // Prefer viewer over editor when ambiguous and no default is set.
  const viewer = candidates.find((m) => m.type === 'viewer');
  if (viewer) return viewer;

  return candidates[0];
}

/** Returns whether any enabled extension can handle the file. */
export function hasExtensionHandler(
  entry: DirEntry,
  context: DispatchContext
): boolean {
  return selectExtension(entry, context) !== null;
}
