import {
  createContext,
  useContext,
  useState,
  type ReactNode,
} from 'react';
import type { DirEntry } from '../../shared/ipc-types';

/**
 * Mirrors the FileList's selection into a context so siblings of FileList —
 * specifically the AI panel — can see which file(s) are currently selected
 * without lifting FileList's internal `selectedPathsRef` plumbing.
 *
 * One-way sync: FileList writes (`setSelectedEntries`); consumers only read.
 * The provider lives in MainLayout so both FileList and AiPanel sit beneath it.
 */
export interface FileSelectionContextValue {
  selectedEntries: DirEntry[];
  setSelectedEntries: (entries: DirEntry[]) => void;
}

const FileSelectionContext = createContext<FileSelectionContextValue | null>(
  null
);

export function FileSelectionProvider({ children }: { children: ReactNode }) {
  const [selectedEntries, setSelectedEntries] = useState<DirEntry[]>([]);
  return (
    <FileSelectionContext.Provider value={{ selectedEntries, setSelectedEntries }}>
      {children}
    </FileSelectionContext.Provider>
  );
}

export function useFileSelectionContext(): FileSelectionContextValue {
  const ctx = useContext(FileSelectionContext);
  if (!ctx) {
    throw new Error(
      'useFileSelectionContext must be used within FileSelectionProvider'
    );
  }
  return ctx;
}
