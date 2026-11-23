import type { TFunction } from 'i18next';

import type { DirEntry } from '../../../shared/ipc-types';
import PromptDialog from '-/components/PromptDialog';
import { splitNameExt } from '-/services/tags';

function copyDefaultName(name: string, suffix: string): string {
  const { base, ext } = splitNameExt(name);
  return `${base} ${suffix}${ext || ''}`;
}

/**
 * The five name prompts `FileList` owns (rename / copy / create / create with
 * tag / package), extracted as a presentational block during the P2 FileList
 * split. All state and the confirm handlers stay in `FileList`; this component
 * only renders the dialogs.
 */
export interface FileListDialogsProps {
  t: TFunction;
  renameTarget: DirEntry | null;
  copyTarget: DirEntry | null;
  createKind: 'folder' | 'file' | null;
  createWithTag: { kind: 'folder' | 'file'; tag: string } | null;
  packageOpen: boolean;
  /** Prefilled package name (`basename(currentDirectoryPath) || 'archive'`). */
  packageDefaultName: string;
  onRenameConfirm: (name: string) => void | Promise<void>;
  onRenameClose: () => void;
  onCopyConfirm: (name: string) => void | Promise<void>;
  onCopyClose: () => void;
  onCreateConfirm: (name: string) => void | Promise<void>;
  onCreateClose: () => void;
  onCreateWithTagConfirm: (name: string) => void | Promise<void>;
  onCreateWithTagClose: () => void;
  onPackageConfirm: (name: string) => void | Promise<void>;
  onPackageClose: () => void;
}

export default function FileListDialogs({
  t,
  renameTarget,
  copyTarget,
  createKind,
  createWithTag,
  packageOpen,
  packageDefaultName,
  onRenameConfirm,
  onRenameClose,
  onCopyConfirm,
  onCopyClose,
  onCreateConfirm,
  onCreateClose,
  onCreateWithTagConfirm,
  onCreateWithTagClose,
  onPackageConfirm,
  onPackageClose,
}: FileListDialogsProps) {
  return (
    <>
      <PromptDialog
        open={renameTarget !== null}
        title={t('rename')}
        label={t('name')}
        defaultValue={renameTarget?.name ?? ''}
        onConfirm={onRenameConfirm}
        onClose={onRenameClose}
      />

      <PromptDialog
        open={copyTarget !== null}
        title={t('copy')}
        label={t('name')}
        defaultValue={
          copyTarget ? copyDefaultName(copyTarget.name, t('copySuffix')) : ''
        }
        onConfirm={onCopyConfirm}
        onClose={onCopyClose}
      />

      <PromptDialog
        open={createKind !== null}
        title={createKind === 'folder' ? t('newFolder') : t('newFile')}
        label={t('name')}
        onConfirm={onCreateConfirm}
        onClose={onCreateClose}
      />

      <PromptDialog
        open={createWithTag !== null}
        title={
          createWithTag
            ? `${createWithTag.kind === 'folder' ? t('newFolder') : t('newFile')} (${createWithTag.tag})`
            : ''
        }
        label={t('name')}
        onConfirm={onCreateWithTagConfirm}
        onClose={onCreateWithTagClose}
      />

      <PromptDialog
        open={packageOpen}
        title={t('package')}
        label={t('name')}
        defaultValue={packageDefaultName}
        onConfirm={onPackageConfirm}
        onClose={onPackageClose}
      />
    </>
  );
}
