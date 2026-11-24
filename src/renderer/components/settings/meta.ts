import type { SvgIconComponent } from '@mui/icons-material';
import TuneIcon from '@mui/icons-material/Tune';
import VisibilityIcon from '@mui/icons-material/Visibility';
import MapIcon from '@mui/icons-material/Map';
import KeyboardIcon from '@mui/icons-material/Keyboard';
import NotificationsIcon from '@mui/icons-material/Notifications';
import StyleIcon from '@mui/icons-material/Style';
import HubIcon from '@mui/icons-material/Hub';
import LanIcon from '@mui/icons-material/Lan';
import TerminalIcon from '@mui/icons-material/Terminal';
import SettingsIcon from '@mui/icons-material/Settings';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';

/** The IDs are also persisted as the "settings section to open" prop from
 *  callers (e.g. Sidebar's tag-management shortcut jumps straight to `tags`). */
export type SettingsSectionId =
  | 'general'
  | 'view'
  | 'mapique'
  | 'keyboard'
  | 'notifications'
  | 'tags'
  | 'mcp'
  | 'lan'
  | 'commands'
  | 'advanced'
  | 'about';

export interface SettingsSectionMeta {
  id: SettingsSectionId;
  labelKey: string;
  descKey: string;
  Icon: SvgIconComponent;
}

/**
 * Nav order. The rail is grouped (see {@link NAV_GROUPS}); this array is the
 * flat order used for Arrow/Home/End navigation, and it must stay in sync with
 * the group order below.
 */
export const SECTIONS: SettingsSectionMeta[] = [
  { id: 'general', labelKey: 'settingsSectionGeneral', descKey: 'settingsSectionDescGeneral', Icon: TuneIcon },
  { id: 'view', labelKey: 'settingsSectionView', descKey: 'settingsSectionDescView', Icon: VisibilityIcon },
  { id: 'mapique', labelKey: 'settingsSectionMapique', descKey: 'settingsSectionDescMapique', Icon: MapIcon },
  { id: 'keyboard', labelKey: 'settingsSectionKeyboard', descKey: 'settingsSectionDescKeyboard', Icon: KeyboardIcon },
  { id: 'notifications', labelKey: 'settingsSectionNotifications', descKey: 'settingsSectionDescNotifications', Icon: NotificationsIcon },
  { id: 'tags', labelKey: 'settingsSectionTags', descKey: 'settingsSectionDescTags', Icon: StyleIcon },
  { id: 'mcp', labelKey: 'settingsSectionMcp', descKey: 'settingsSectionDescMcp', Icon: HubIcon },
  { id: 'lan', labelKey: 'settingsSectionLan', descKey: 'settingsSectionDescLan', Icon: LanIcon },
  { id: 'commands', labelKey: 'settingsSectionCommands', descKey: 'settingsSectionDescCommands', Icon: TerminalIcon },
  { id: 'advanced', labelKey: 'settingsSectionAdvanced', descKey: 'settingsSectionDescAdvanced', Icon: SettingsIcon },
  { id: 'about', labelKey: 'settingsSectionAbout', descKey: 'settingsSectionDescAbout', Icon: InfoOutlinedIcon },
];

export const SECTION_BY_ID = Object.fromEntries(
  SECTIONS.map((section) => [section.id, section])
) as Record<SettingsSectionId, SettingsSectionMeta>;

/** Five rail groups: daily preferences, habits, content, integrations, system. */
export const NAV_GROUPS: {
  titleKey: string;
  ids: SettingsSectionId[];
}[] = [
  {
    titleKey: 'settingsGroupAppearance',
    ids: ['general', 'view', 'mapique'],
  },
  {
    titleKey: 'settingsGroupInteraction',
    ids: ['keyboard', 'notifications'],
  },
  {
    titleKey: 'settingsGroupContent',
    ids: ['tags'],
  },
  {
    titleKey: 'settingsGroupIntegrations',
    ids: ['mcp', 'lan', 'commands'],
  },
  {
    titleKey: 'settingsGroupSystem',
    ids: ['advanced', 'about'],
  },
];

export interface SettingsSearchEntry {
  id: string;
  section: SettingsSectionId;
  titleKey: string;
  hintKey?: string;
  /** Anchor id of the row to scroll to; omit to scroll the panel to the top. */
  anchor?: string;
  /** Extra search terms that do not appear in the visible label. */
  keywords?: string[];
}

/**
 * Search index: one entry per user-visible setting, labelled with the control's
 * own text so the results read like the UI. Sections whose internals are not
 * row-anchored (MCP/LAN/commands) still get entries that jump to the section.
 */
export const SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    id: 'theme',
    section: 'general',
    titleKey: 'theme',
    anchor: 'settings-anchor-theme',
    keywords: ['dark', 'light', 'preset', 'theme', '深色', '浅色', '主题', '配色'],
  },
  {
    id: 'font-size',
    section: 'general',
    titleKey: 'fontSize',
    anchor: 'settings-anchor-font-size',
    keywords: ['font', 'text size', '字号', '字体'],
  },
  {
    id: 'language',
    section: 'general',
    titleKey: 'language',
    anchor: 'settings-anchor-language',
    keywords: ['language', 'locale', '语言'],
  },
  {
    id: 'default-location',
    section: 'general',
    titleKey: 'defaultLocation',
    hintKey: 'defaultLocationHint',
    anchor: 'settings-anchor-default-location',
    keywords: ['startup', '默认位置', '启动', '文件夹'],
  },
  {
    id: 'delete-to-trash',
    section: 'general',
    titleKey: 'deleteToTrash',
    hintKey: 'deleteToTrashHint',
    anchor: 'settings-anchor-delete-to-trash',
    keywords: ['trash', 'delete', 'recycle', '回收站', '删除'],
  },
  {
    id: 'hidden-files',
    section: 'general',
    titleKey: 'showHiddenFiles',
    hintKey: 'showHiddenFilesHint',
    anchor: 'settings-anchor-show-hidden-files',
    keywords: ['hidden', 'dotfile', '隐藏文件', '点文件'],
  },
  {
    id: 'lunar-calendar',
    section: 'general',
    titleKey: 'showLunar',
    hintKey: 'showLunarHint',
    anchor: 'settings-anchor-show-lunar',
    keywords: ['lunar', 'calendar', '农历', '日历'],
  },
  {
    id: 'default-view',
    section: 'view',
    titleKey: 'defaultView',
    anchor: 'settings-anchor-default-view',
    keywords: ['view', 'layout', 'list', 'grid', '视图', '布局'],
  },
  {
    id: 'entry-size',
    section: 'view',
    titleKey: 'defaultEntrySize',
    hintKey: 'defaultEntrySizeHint',
    anchor: 'settings-anchor-entry-size',
    keywords: ['thumbnail', 'size', '缩略图', '尺寸'],
  },
  {
    id: 'map-provider',
    section: 'mapique',
    titleKey: 'mapProvider',
    anchor: 'settings-anchor-map-provider',
    keywords: ['map', 'gaode', 'osm', '地图', '高德'],
  },
  {
    id: 'map-tile-url',
    section: 'mapique',
    titleKey: 'mapTileUrl',
    hintKey: 'mapTileUrlHint',
    anchor: 'settings-anchor-map-tile-url',
    keywords: ['tile', 'url', '瓦片'],
  },
  {
    id: 'keybindings',
    section: 'keyboard',
    titleKey: 'settingsSectionKeyboard',
    hintKey: 'keybindingsHint',
    keywords: ['keyboard', 'shortcut', 'key', '快捷键', '按键'],
  },
  {
    id: 'task-reminder',
    section: 'notifications',
    titleKey: 'taskReminder',
    hintKey: 'taskReminderHint',
    anchor: 'settings-anchor-task-reminder',
    keywords: ['reminder', 'notification', 'todo', '提醒', '通知', '待办'],
  },
  {
    id: 'tag-shape',
    section: 'tags',
    titleKey: 'tagShape',
    hintKey: 'tagShapeHint',
    anchor: 'settings-anchor-tag-shape',
    keywords: ['shape', 'tag', '形状', '标签'],
  },
  {
    id: 'workflow-stages',
    section: 'tags',
    titleKey: 'tagsWorkflowSettings',
    hintKey: 'tagsWorkflowSettingsHint',
    keywords: ['workflow', 'stage', 'kanban', '工作流', '阶段'],
  },
  {
    id: 'tag-groups',
    section: 'tags',
    titleKey: 'tagGroups',
    hintKey: 'tagsGroupsHint',
    keywords: ['group', '标签组'],
  },
  {
    id: 'tag-library',
    section: 'tags',
    titleKey: 'tagLibrary',
    hintKey: 'tagsLibraryHint',
    keywords: ['library', '标签库'],
  },
  {
    id: 'smart-tags',
    section: 'tags',
    titleKey: 'smartTags',
    hintKey: 'tagsSmartTagsHint',
    keywords: ['smart', '自动标签'],
  },
  {
    id: 'mcp',
    section: 'mcp',
    titleKey: 'settingsSectionMcp',
    hintKey: 'mcpSettingsHint',
    keywords: ['mcp', 'ai', 'server', '模型', '服务器'],
  },
  {
    id: 'lan',
    section: 'lan',
    titleKey: 'lanTitle',
    hintKey: 'lanHint',
    keywords: ['lan', 'wifi', 'phone', 'qr', '局域网', '二维码', '手机'],
  },
  {
    id: 'user-commands',
    section: 'commands',
    titleKey: 'commandsTitle',
    hintKey: 'commandsHint',
    keywords: ['command', 'shell', 'script', '命令', '脚本'],
  },
  {
    id: 'extensions',
    section: 'advanced',
    titleKey: 'extensionsSettings',
    keywords: ['extension', 'viewer', 'editor', '扩展', '查看器'],
  },
  {
    id: 'fulltext',
    section: 'advanced',
    titleKey: 'fulltextSearch',
    hintKey: 'fulltextHint',
    keywords: ['fulltext', 'index', 'search', '全文', '索引'],
  },
  {
    id: 'updates',
    section: 'about',
    titleKey: 'updateSectionTitle',
    keywords: ['update', 'version', 'release', '更新', '版本'],
  },
];
