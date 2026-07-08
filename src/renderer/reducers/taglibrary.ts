import type { AnyAction } from 'redux';
import type { TagGroup } from '../../shared/tag-library';

export type { TagGroup };

/**
 * User-defined, persisted collections of reusable tags. A tag's color comes
 * from its own settings.tagColors entry, OR — as a fallback — its group's
 * color (see getTagColor in shared/tag-colors.ts).
 */
export interface TagLibraryState {
  groups: TagGroup[];
}

const initialState: TagLibraryState = { groups: [] };

export const ADD_GROUP = 'taglibrary/ADD_GROUP';
export const REMOVE_GROUP = 'taglibrary/REMOVE_GROUP';
export const RENAME_GROUP = 'taglibrary/RENAME_GROUP';
export const TOGGLE_GROUP = 'taglibrary/TOGGLE_GROUP';
export const ADD_TAG_TO_GROUP = 'taglibrary/ADD_TAG_TO_GROUP';
export const REMOVE_TAG_FROM_GROUP = 'taglibrary/REMOVE_TAG_FROM_GROUP';
export const SET_GROUP_COLOR = 'taglibrary/SET_GROUP_COLOR';

interface AddGroupAction extends AnyAction {
  type: typeof ADD_GROUP;
  payload: TagGroup;
}
interface RemoveGroupAction extends AnyAction {
  type: typeof REMOVE_GROUP;
  payload: string; // group id
}
interface RenameGroupAction extends AnyAction {
  type: typeof RENAME_GROUP;
  payload: { id: string; title: string };
}
interface ToggleGroupAction extends AnyAction {
  type: typeof TOGGLE_GROUP;
  payload: string; // group id
}
interface AddTagToGroupAction extends AnyAction {
  type: typeof ADD_TAG_TO_GROUP;
  payload: { id: string; tag: string };
}
interface RemoveTagFromGroupAction extends AnyAction {
  type: typeof REMOVE_TAG_FROM_GROUP;
  payload: { id: string; tag: string };
}
interface SetGroupColorAction extends AnyAction {
  type: typeof SET_GROUP_COLOR;
  payload: { id: string; color: string | null }; // null = clear
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `grp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export function addGroup(title: string): AddGroupAction {
  return {
    type: ADD_GROUP,
    payload: { id: newId(), title: title.trim(), expanded: true, tags: [] },
  };
}
export function removeGroup(id: string): RemoveGroupAction {
  return { type: REMOVE_GROUP, payload: id };
}
export function renameGroup(id: string, title: string): RenameGroupAction {
  return { type: RENAME_GROUP, payload: { id, title: title.trim() } };
}
export function toggleGroup(id: string): ToggleGroupAction {
  return { type: TOGGLE_GROUP, payload: id };
}
export function addTagToGroup(id: string, tag: string): AddTagToGroupAction {
  return { type: ADD_TAG_TO_GROUP, payload: { id, tag: tag.trim() } };
}
export function removeTagFromGroup(
  id: string,
  tag: string
): RemoveTagFromGroupAction {
  return { type: REMOVE_TAG_FROM_GROUP, payload: { id, tag } };
}

export function setGroupColor(
  id: string,
  color: string | null
): SetGroupColorAction {
  return { type: SET_GROUP_COLOR, payload: { id, color } };
}

type TagLibraryAction =
  | AddGroupAction
  | RemoveGroupAction
  | RenameGroupAction
  | ToggleGroupAction
  | AddTagToGroupAction
  | RemoveTagFromGroupAction
  | SetGroupColorAction;

export default function tagLibraryReducer(
  state = initialState,
  action: TagLibraryAction | AnyAction
): TagLibraryState {
  // Migrate persisted state from before this slice existed.
  const base: TagLibraryState =
    state && Array.isArray(state.groups) ? state : initialState;

  switch (action.type) {
    case ADD_GROUP:
      return { groups: [...base.groups, (action as AddGroupAction).payload] };
    case REMOVE_GROUP: {
      const id = (action as RemoveGroupAction).payload;
      return { groups: base.groups.filter((g) => g.id !== id) };
    }
    case RENAME_GROUP: {
      const { id, title } = (action as RenameGroupAction).payload;
      return {
        groups: base.groups.map((g) =>
          g.id === id ? { ...g, title } : g
        ),
      };
    }
    case TOGGLE_GROUP: {
      const id = (action as ToggleGroupAction).payload;
      return {
        groups: base.groups.map((g) =>
          g.id === id ? { ...g, expanded: !g.expanded } : g
        ),
      };
    }
    case ADD_TAG_TO_GROUP: {
      const { id, tag } = (action as AddTagToGroupAction).payload;
      if (!tag) return base;
      return {
        groups: base.groups.map((g) =>
          g.id === id && !g.tags.includes(tag)
            ? { ...g, tags: [...g.tags, tag] }
            : g
        ),
      };
    }
    case REMOVE_TAG_FROM_GROUP: {
      const { id, tag } = (action as RemoveTagFromGroupAction).payload;
      return {
        groups: base.groups.map((g) =>
          g.id === id ? { ...g, tags: g.tags.filter((tg) => tg !== tag) } : g
        ),
      };
    }
    case SET_GROUP_COLOR: {
      const { id, color } = (action as SetGroupColorAction).payload;
      return {
        groups: base.groups.map((g) =>
          g.id === id ? { ...g, color: color ?? undefined } : g
        ),
      };
    }
    default:
      return base;
  }
}
