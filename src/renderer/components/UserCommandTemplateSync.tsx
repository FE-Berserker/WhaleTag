import { useEffect } from 'react';
import { useSelector } from 'react-redux';

import type { RootState } from '-/reducers';

/**
 * Mirrors the configured command templates into the main process.
 *
 * `shell:runCommand` only executes templates that were pushed here (main keeps
 * a fail-closed allow-list), so this must run on boot — before the user can
 * right-click anything — and again whenever Settings → Commands changes.
 *
 * Selects the array itself (not a mapped copy) so the effect only re-runs when
 * the settings slice actually replaces it.
 */
export default function UserCommandTemplateSync(): null {
  const commands = useSelector((s: RootState) => s.settings.userCommands);

  useEffect(() => {
    const api = window.whale;
    if (!api?.setUserCommandTemplates) return;
    const templates = (commands ?? []).map((command) => command.template);
    // Fire-and-forget: a failed push leaves main fail-closed (no command can
    // run) rather than silently trusting the previous list, and the next
    // settings change retries.
    api.setUserCommandTemplates(templates).catch(() => undefined);
  }, [commands]);

  return null;
}
