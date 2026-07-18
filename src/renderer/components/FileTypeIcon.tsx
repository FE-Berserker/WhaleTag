import type { ComponentType } from 'react';
import type { SvgIconProps } from '@mui/material';
import { Box } from '@mui/material';
import ImageIcon from '@mui/icons-material/Image';
import MovieIcon from '@mui/icons-material/Movie';
import AudiotrackIcon from '@mui/icons-material/Audiotrack';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import DescriptionIcon from '@mui/icons-material/Description';
import TableChartIcon from '@mui/icons-material/TableChart';
import SlideshowIcon from '@mui/icons-material/Slideshow';
import FolderZipIcon from '@mui/icons-material/FolderZip';
import CodeIcon from '@mui/icons-material/Code';
import ArticleIcon from '@mui/icons-material/Article';
import TextSnippetIcon from '@mui/icons-material/TextSnippet';
import DataObjectIcon from '@mui/icons-material/DataObject';
import MenuBookIcon from '@mui/icons-material/MenuBook';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import GestureIcon from '@mui/icons-material/Gesture';
import FontDownloadIcon from '@mui/icons-material/FontDownload';
import ViewInArIcon from '@mui/icons-material/ViewInAr';
import TerminalIcon from '@mui/icons-material/Terminal';
import ArchitectureIcon from '@mui/icons-material/Architecture';
import DesignServicesIcon from '@mui/icons-material/DesignServices';
import PrecisionManufacturingIcon from '@mui/icons-material/PrecisionManufacturing';
import JavascriptIcon from '@mui/icons-material/Javascript';
import HtmlIcon from '@mui/icons-material/Html';
import CssIcon from '@mui/icons-material/Css';
import StorageIcon from '@mui/icons-material/Storage';
import FunctionsIcon from '@mui/icons-material/Functions';
import DataArrayIcon from '@mui/icons-material/DataArray';
import ScienceIcon from '@mui/icons-material/Science';
import BrushIcon from '@mui/icons-material/Brush';
import MailIcon from '@mui/icons-material/Mail';
import LinkIcon from '@mui/icons-material/Link';
import SchoolIcon from '@mui/icons-material/School';
import SaveIcon from '@mui/icons-material/Save';
import InsertDriveFileIcon from '@mui/icons-material/InsertDriveFile';

import excalidrawIcon from '../assets/excalidraw-icon.svg';
import drawioIcon from '../assets/drawio-icon.png';

import { fileIconCategory } from '../domain/file-icon';
import type { FileIconCategory } from '../domain/file-icon';

type IconComponent = ComponentType<SvgIconProps>;

/** Per-extension brand color (and optional icon) for 3D software proprietary
 *  formats that share the `model3d` category. This lets `.blend`, `.dwg`, `.max`,
 *  etc. be visually distinguished in the file list without adding a dozen new
 *  top-level categories to `file-icon.ts`. Colors are approximate brand colors
 *  chosen for readability in both light and dark themes. */
const MODEL3D_BRAND: Record<
  string,
  { color: string; Icon?: IconComponent }
> = {
  // Blender
  blend: { color: '#f5792a', Icon: DesignServicesIcon },
  // Maya
  ma: { color: '#00a896' },
  mb: { color: '#00a896' },
  // 3ds Max
  max: { color: '#00a4e4' },
  // AutoCAD / DXF
  dwg: { color: '#d93222', Icon: ArchitectureIcon },
  dxf: { color: '#d93222', Icon: ArchitectureIcon },
  // SketchUp
  skp: { color: '#e72b2d' },
  // Cinema 4D
  c4d: { color: '#003399' },
  // SolidWorks
  sldprt: { color: '#d12727', Icon: PrecisionManufacturingIcon },
  sldasm: { color: '#d12727', Icon: PrecisionManufacturingIcon },
  slddrw: { color: '#d12727', Icon: PrecisionManufacturingIcon },
  // Rhino
  '3dm': { color: '#333333' },
  // ZBrush
  ztl: { color: '#f68b1f' },
  zpr: { color: '#f68b1f' },
};

/** Returns the lowercase extension of `name` (no dot); '' if none. Mirrors
 *  `extOf` in `file-icon.ts` so this file can resolve brand overrides. */
function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * Per-category glyph + distinguishing color used when a file has no thumbnail.
 * Colors are fixed mid-saturation hex (readable in both light and dark themes,
 * per docs/06-thumbnails.md § "File-type icons"); `generic` uses `undefined` so
 * it inherits the theme's default icon color rather than a fixed gray.
 */
const CATEGORY_ICON: Record<
  FileIconCategory,
  { Icon: IconComponent; color?: string }
> = {
  image: { Icon: ImageIcon, color: '#2e9e5b' },
  video: { Icon: MovieIcon, color: '#7e57c2' },
  audio: { Icon: AudiotrackIcon, color: '#ec407a' },
  pdf: { Icon: PictureAsPdfIcon, color: '#d32f2f' },
  word: { Icon: DescriptionIcon, color: '#2b579a' },
  excel: { Icon: TableChartIcon, color: '#217346' },
  ppt: { Icon: SlideshowIcon, color: '#d24726' },
  archive: { Icon: FolderZipIcon, color: '#d99e2b' },
  javascript: { Icon: JavascriptIcon, color: '#f7df1e' },
  typescript: { Icon: CodeIcon, color: '#3178c6' },
  html: { Icon: HtmlIcon, color: '#e34f26' },
  css: { Icon: CssIcon, color: '#264de4' },
  python: { Icon: CodeIcon, color: '#3776ab' },
  java: { Icon: CodeIcon, color: '#b07219' },
  cpp: { Icon: CodeIcon, color: '#00599c' },
  csharp: { Icon: CodeIcon, color: '#178600' },
  go: { Icon: CodeIcon, color: '#00add8' },
  rust: { Icon: CodeIcon, color: '#dea584' },
  shell: { Icon: TerminalIcon, color: '#43a047' },
  database: { Icon: StorageIcon, color: '#607d8b' },
  matlab: { Icon: FunctionsIcon, color: '#0076a8' },
  json: { Icon: DataArrayIcon, color: '#f5b041' },
  notebook: { Icon: ScienceIcon, color: '#f37626' },
  design: { Icon: BrushIcon, color: '#31a8ff' },
  email: { Icon: MailIcon, color: '#5c6bc0' },
  link: { Icon: LinkIcon, color: '#42a5f5' },
  diskimage: { Icon: SaveIcon, color: '#78909c' },
  code: { Icon: CodeIcon, color: '#0097a7' },
  markdown: { Icon: ArticleIcon, color: '#546e7a' },
  text: { Icon: TextSnippetIcon, color: '#607d8b' },
  data: { Icon: DataObjectIcon, color: '#8d6e63' },
  ebook: { Icon: MenuBookIcon, color: '#5c6bc0' },
  caj: { Icon: SchoolIcon, color: '#8e24aa' },
  drawio: { Icon: AccountTreeIcon, color: '#e07b39' },
  excalidraw: { Icon: GestureIcon, color: '#9575cd' },
  font: { Icon: FontDownloadIcon, color: '#455a64' },
  model3d: { Icon: ViewInArIcon, color: '#00897b' },
  executable: { Icon: TerminalIcon, color: '#455a64' },
  generic: { Icon: InsertDriveFileIcon, color: undefined },
};

/**
 * Renders a file-type fallback icon for `name`, chosen by extension category
 * (see `fileIconCategory`). Used everywhere a file has no thumbnail: list /
 * grid / gallery (via `ThumbIcon`) and the search-result rows. Unrecognized
 * extensions render the generic file icon in the theme's default color.
 *
 * `size` sets the glyph's `fontSize` (px). `color` overrides the category color
 * when a caller needs to match a surrounding context.
 */
export default function FileTypeIcon({
  name,
  size,
  color,
}: {
  name: string;
  /** Glyph size in px. Omit to inherit MUI's `fontSize` (small/medium/large). */
  size?: number;
  /** Override the category color. */
  color?: string;
}) {
  const category = fileIconCategory(name);
  const ext = extOf(name);
  const brand = category === 'model3d' ? MODEL3D_BRAND[ext] : undefined;

  // Branded app icons for diagram formats: the generated thumbnails are too
  // faint at small sizes, so we show the Excalidraw / Draw.io logos directly.
  if (category === 'excalidraw') {
    return (
      <Box
        component="img"
        src={excalidrawIcon}
        alt=""
        sx={{ width: size, height: size, objectFit: 'contain' }}
      />
    );
  }
  if (category === 'drawio') {
    return (
      <Box
        component="img"
        src={drawioIcon}
        alt=""
        sx={{ width: size, height: size, objectFit: 'contain' }}
      />
    );
  }

  const { Icon: CategoryIcon, color: categoryColor } = CATEGORY_ICON[category];
  const Icon = brand?.Icon ?? CategoryIcon;
  const resolved = color ?? brand?.color ?? categoryColor;
  return (
    <Icon
      sx={{
        fontSize: size,
        color: resolved,
      }}
    />
  );
}
