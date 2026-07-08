/**
 * Drag-and-drop wiring shared between the drag source (TagLibrary) and the
 * drop targets (FileList rows). Uses react-dnd with the HTML5 backend.
 */

/** react-dnd item type for a tag chip dragged out of the Tag Library. */
export const DND_TYPE_TAG = 'whale/tag';

/** Payload carried while dragging a tag. */
export interface TagDragItem {
  tag: string;
  /** Smart tags only: the functionality to resolve into a concrete tag at drop. */
  functionality?: string;
}

/** react-dnd item type for a file/folder row dragged to move it. */
export const DND_TYPE_FILE = 'whale/file';

/** Payload carried while dragging one or more files/folders. */
export interface FileDragItem {
  /** Paths of the dragged entries. */
  paths: string[];
  /** Names of the dragged entries. */
  names: string[];
}

/** react-dnd item type for a location row dragged to reorder the list. */
export const DND_TYPE_LOCATION = 'whale/location';

/** Payload carried while dragging a location row (index tracked live on hover). */
export interface LocationDragItem {
  id: string;
  index: number;
}
