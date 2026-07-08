# WhaleTag UI Design Language

> Design source file: `c:\Whale\UI_Design\Whale_UI.pen`
> This document is intended to be read and updated by other agents when making UI changes.

---

## 1. Design Direction

WhaleTag has **nine visual themes** that can be selected from Settings → Appearance:

| Theme | Chinese Name | Mode | Personality | Best For |
|-------|--------------|------|-------------|----------|
| **Clean Professional** | 清新专业 | Light | Clean, breathable, low fatigue | Daily productivity, office users |
| **Dark Geek** | 深色极客 | Dark | Low-saturation, high contrast, tool-like | Night usage, power users, developers |
| **System** | 跟随系统 | Auto | Follows OS light/dark | Users who want Whale to match the OS |
| **Warm Paper** | 暖沙纸感 | Light | Warm, easy on the eyes, paper-like | Long reading sessions, writing |
| **Midnight Plum** | 午夜梅紫 | Dark | Elegant, deep, focused | Night work, creative workflows |
| **Frosted Mint** | 雾松薄荷 | Light | Fresh, calm, natural | Spring/summer, calming focus |
| **Deep Ocean** | 深海蓝 | Dark | Deep, immersive, blue-toned | Focused deep work, night usage |
| **Dawn Blush** | 晨曦粉 | Light | Soft, warm, rosy | Gentle daytime use, creative writing |
| **Forest Ink** | 森林墨 | Dark | Rich, natural, green-toned | Calm night work, reading |

The first three are the classic appearance modes (light / dark / system). The remaining six are curated full-theme presets that bind a fixed color palette to a fixed effective mode (`warm-paper`, `frosted-mint`, and `dawn-blush` always render as light; `midnight-plum`, `deep-ocean`, and `forest-ink` always render as dark).

All themes share the **same layout structure** and **component sizes**; only colors change.

> The nine theme modes are persisted in `settings.themeMode`. The curated themes are implemented via `THEME_MODE_PRESET_MAP` in `src/renderer/theme/presets.ts` and rendered in `Whale_UI.pen` frames `HV6Ci`, `fkv8b`, and `n50SC2`.

---

## 2. Layout Structure

The main application window uses a **three-pane layout**:

```
┌─────────────────┬───────────────┬────────────────────────────────────────────┐
│  Locations      │  Directory    │  Toolbar + File List + Properties Tray     │
│  Sidebar        │  Tree         │                                            │
│  (260 px)       │  (240 px)     │  (remaining width)                         │
└─────────────────┴───────────────┴────────────────────────────────────────────┘
```

### 2.1 Shared Dimensions

| Element | Width | Height | Notes |
|---------|-------|--------|-------|
| Locations sidebar | 260 px | fill | Contains location list, tag groups, tag library |
| Directory tree | 240 px | fill | Lazy-loading folder tree |
| Shared header height | — | 48 px | Used by sidebar header, tree header, file toolbar |
| File toolbar | fill | 48 px | Nav icons, new buttons, search, breadcrumb |
| Properties tray | 300 px (default) | fill | Resizable between 260–600 px |
| File list row | fill | 56 px | Thumbnail 40 px inside a 56 px row |
| Tag chip height | 20–24 px | — | Pill shape (`cornerRadius: 999`) |

### 2.2 Content Hierarchy

- **Frame** `document` root contains:
  - Reference screenshots (`W0hVN5`, `czynu`)
  - `清新专业（浅色）` — Chinese light theme (ID: `SekfE`)
  - `深色极客（深色）` — Chinese dark theme (ID: `fhRXq`)
  - `Clean Professional (Light - EN)` — English light theme (ID: `Trgis`)
  - `Dark Geek (Dark - EN)` — English dark theme (ID: `p1Urg`)
  - `设计语言规范` — Design token spec (ID: `i1Oz5V`)

---

## 3. Color Tokens

### 3.1 Clean Professional (Light)

| Token | Hex | Usage |
|-------|-----|-------|
| Primary | `#0EA5E9` | Active location, selected folder, active view icon, primary button |
| Background | `#F8FAFC` | Main content background, empty states |
| Surface | `#FFFFFF` | Cards, sidebar, tree, toolbar, properties tray |
| Border | `#E2E8F0` | Dividers, card borders, input borders |
| Text Primary | `#0F172A` | File names, titles, active breadcrumb |
| Text Secondary | `#64748B` | Metadata, icons, placeholders, captions |
| Hover | `#F1F5F9` | List hover, selected tree row background |
| Primary Light | `#E0F2FE` | Active location background |

### 3.2 Dark Geek (Dark)

| Token | Hex | Usage |
|-------|-----|-------|
| Primary | `#818CF8` | Active location, selected folder, active view icon, primary button |
| Background | `#0F0F10` | Main content background |
| Surface | `#18181B` | Cards, sidebar, tree, toolbar, properties tray |
| Border | `#27272A` | Dividers, card borders, input borders |
| Text Primary | `#FAFAFA` | File names, titles, active breadcrumb |
| Text Secondary | `#A1A1AA` | Metadata, icons, placeholders, captions |
| Hover | `#27272A` | List hover, selected tree row background |
| Primary Light | `#818CF820` | Active location background (16% opacity) |

### 3.3 Warm Paper

| Token | Light | Dark | Usage |
|-------|-------|------|-------|
| Primary | `#B45309` | `#FB923C` | Active location, selected folder, active view icon, primary button |
| Secondary | `#D97706` | `#FBBF24` | Accent details, secondary actions |
| Background | `#F5F1E8` | `#1A1714` | Main content background |
| Surface | `#FAF8F2` | `#24201C` | Cards, sidebar, tree, toolbar, properties tray |
| Border | `#E7E5E4` | `#3F382F` | Dividers, card borders, input borders |
| Text Primary | `#292524` | `#FAFAF9` | File names, titles, active breadcrumb |
| Text Secondary | `#78716C` | `#A8A29E` | Metadata, icons, placeholders, captions |
| Hover | `#EFEAE0` | `#3F382F` | List hover, selected tree row background |
| Primary Light | `#FFF7ED` | `#FB923C20` | Active location background |

### 3.4 Midnight Plum

| Token | Light | Dark | Usage |
|-------|-------|------|-------|
| Primary | `#9333EA` | `#C084FC` | Active location, selected folder, active view icon, primary button |
| Secondary | `#C026D3` | `#E879F9` | Accent details, secondary actions |
| Background | `#FAF8FF` | `#0F0A14` | Main content background |
| Surface | `#FFFFFF` | `#1A1421` | Cards, sidebar, tree, toolbar, properties tray |
| Border | `#E9D5FF` | `#2D2438` | Dividers, card borders, input borders |
| Text Primary | `#3B0764` | `#F5F3FF` | File names, titles, active breadcrumb |
| Text Secondary | `#7E22CE` | `#A8A3B3` | Metadata, icons, placeholders, captions |
| Hover | `#F3E8FF` | `#2A2035` | List hover, selected tree row background |
| Primary Light | `#F3E8FF` | `#C084FC20` | Active location background |

### 3.5 Frosted Mint

| Token | Light | Dark | Usage |
|-------|-------|------|-------|
| Primary | `#14B8A6` | `#2DD4BF` | Active location, selected folder, active view icon, primary button |
| Secondary | `#06B6D4` | `#22D3EE` | Accent details, secondary actions |
| Background | `#F0FDFA` | `#0A1614` | Main content background |
| Surface | `#FFFFFF` | `#112826` | Cards, sidebar, tree, toolbar, properties tray |
| Border | `#CCFBF1` | `#1F423E` | Dividers, card borders, input borders |
| Text Primary | `#134E4A` | `#F0FDFA` | File names, titles, active breadcrumb |
| Text Secondary | `#5F7774` | `#94A3B8` | Metadata, icons, placeholders, captions |
| Hover | `#D6F5F0` | `#1F423E` | List hover, selected tree row background |
| Primary Light | `#CCFBF1` | `#2DD4BF20` | Active location background |

### 3.6 Deep Ocean

| Token | Light | Dark | Usage |
|-------|-------|------|-------|
| Primary | `#0284C7` | `#38BDF8` | Active location, selected folder, active view icon, primary button |
| Secondary | `#0891B2` | `#22D3EE` | Accent details, secondary actions |
| Background | `#F0F9FF` | `#0A1929` | Main content background |
| Surface | `#FFFFFF` | `#112A3F` | Cards, sidebar, tree, toolbar, properties tray |
| Border | `#BAE6FD` | `#1E3A5F` | Dividers, card borders, input borders |
| Text Primary | `#082F49` | `#E6F7FF` | File names, titles, active breadcrumb |
| Text Secondary | `#0369A1` | `#8FB8D9` | Metadata, icons, placeholders, captions |
| Hover | `#E0F2FE` | `#1E3A5F` | List hover, selected tree row background |
| Primary Light | `#E0F2FE` | `#38BDF820` | Active location background |

### 3.7 Dawn Blush

| Token | Light | Dark | Usage |
|-------|-------|------|-------|
| Primary | `#DB2777` | `#F472B6` | Active location, selected folder, active view icon, primary button |
| Secondary | `#E11D48` | `#FB7185` | Accent details, secondary actions |
| Background | `#FFF5F7` | `#2A0A14` | Main content background |
| Surface | `#FFFFFF` | `#3D1020` | Cards, sidebar, tree, toolbar, properties tray |
| Border | `#FCE7EB` | `#5C2535` | Dividers, card borders, input borders |
| Text Primary | `#4A1423` | `#FFF1F2` | File names, titles, active breadcrumb |
| Text Secondary | `#9D5B6E` | `#D48BA0` | Metadata, icons, placeholders, captions |
| Hover | `#FCE7EB` | `#5C2535` | List hover, selected tree row background |
| Primary Light | `#FCE7F3` | `#F472B620` | Active location background |

### 3.8 Forest Ink

| Token | Light | Dark | Usage |
|-------|-------|------|-------|
| Primary | `#16A34A` | `#34D399` | Active location, selected folder, active view icon, primary button |
| Secondary | `#65A30D` | `#A3E635` | Accent details, secondary actions |
| Background | `#F0FDF4` | `#0A1F15` | Main content background |
| Surface | `#FFFFFF` | `#112B1E` | Cards, sidebar, tree, toolbar, properties tray |
| Border | `#BBF7D0` | `#1F4232` | Dividers, card borders, input borders |
| Text Primary | `#052E16` | `#ECFDF5` | File names, titles, active breadcrumb |
| Text Secondary | `#3F6212` | `#86B8A0` | Metadata, icons, placeholders, captions |
| Hover | `#DCFCE7` | `#1F4232` | List hover, selected tree row background |
| Primary Light | `#DCFCE7` | `#34D39920` | Active location background |

### 3.9 Tag Color Palette

| Semantic | Light Theme | Dark Theme |
|----------|-------------|------------|
| Design / blue | `#DBEAFE` bg / `#1E40AF` text | `#312E81` bg / `#C7D2FE` text |
| Report / green | `#DCFCF7` bg / `#166534` text | `#064E3B` bg / `#6EE7B7` text |
| Urgent / red | `#FFEDD5` bg / `#9A3412` text | `#450A0A` bg / `#FCA5A5` text |
| Meeting / orange | `#FFEDD5` bg / `#9A3412` text | `#450A0A` bg / `#FCA5A5` text |
| Travel / amber | `#FEF3C7` bg / `#92400E` text | `#451A03` bg / `#FCD34D` text |

---

## 4. Typography

| Usage | Font | Size | Weight | Notes |
|-------|------|------|--------|-------|
| Section labels | `Geist` / system sans | 11 px | 600 | Uppercase, letter-spacing 0.5 |
| Body / list items | `Geist` / system sans | 13 px | 400 | File names, folder names |
| Button labels | `Geist` / system sans | 12 px | 500 | — |
| Tag chips | `Geist` / system sans | 10–11 px | 500 | — |
| Captions / metadata | `Geist` / system sans | 12 px | 400 | Size, date, secondary info |
| Monospace data | `JetBrains Mono` | 12 px | 400 | Color hex values, code-like labels |
| Chinese fallback | System default Chinese sans | — | — | Use when content is Chinese |

### 4.1 Chinese Localization Mapping

| English | Chinese |
|---------|---------|
| LOCATIONS | 位置 |
| FOLDERS | 文件夹 |
| TAG GROUPS | 标签组 |
| TAG LIBRARY | 标签库 |
| Folder | 文件夹 |
| File | 文件 |
| Search files... | 搜索文件... |
| Tags: | 标签： |
| Name | 名称 |
| Tags | 标签 |
| Size | 大小 |
| Modified | 修改时间 |
| Path | 路径 |
| design | 设计 |
| report | 报告 |
| urgent | 紧急 |
| budget | 预算 |
| meeting | 会议 |
| travel | 旅行 |
| in-progress | 进行中 |
| done | 已完成 |

---

## 5. Components

### 5.1 Primary Button

```
Background: $primary
Text: #FFFFFF (light) / #0F0F10 (dark primary button on dark)
Height: 30 px
Padding: 0 12 px
Corner radius: 6 px
Icon: 14 px, left of label
```

### 5.2 Secondary / Outline Button

```
Background: $surface
Border: 1 px $border
Text: $text-primary
Height: 30 px
Corner radius: 6 px
```

### 5.3 Tag Chip

```
Height: 20–24 px
Padding: 0 8 px
Corner radius: 999 px (pill)
Background: semantic color (see palette)
Text: semantic contrast color
```

### 5.4 List Row

```
Height: 56 px
Padding: 0 16 px
Background: $surface
Bottom border: 1 px $border
Thumbnail: 40 px square, 6 px radius, $background fill
```

### 5.5 Search Bar

```
Width: 220 px
Height: 30 px
Background: $background
Border: 1 px $border
Corner radius: 6 px
Icon: Search 14 px, left
Placeholder: $text-secondary
```

### 5.6 Properties Tray

```
Width: 300 px default
Background: $surface
Left border: 1 px $border
Padding: 16 px
Gap: 16 px
Large thumbnail: fill width × 140 px, 12 px radius
```

---

## 6. Icons

- **Library**: `lucide`
- **Size in sidebars/lists**: 18 px
- **Size in toolbar**: 18 px
- **Size in thumbnails**: 20 px
- **Size in buttons**: 14 px
- **Color default**: `$text-secondary`
- **Color active/selected**: `$primary`

Common icons used:
- `folder-plus`, `folder-open`, `folder`, `image`, `briefcase`, `archive`
- `chevron-right`, `chevron-down`
- `arrow-up`, `arrow-left`, `arrow-right`, `history`, `refresh-cw`
- `plus`, `file-plus`, `search`, `tag`
- `list`, `layout-grid`, `image`, `columns-3`, `calendar`, `map`, `network`
- `trash-2`, `settings`

---

## 7. Exported Assets

All current exports are in `c:\Whale\UI_Design\exports\`:

| File | Description |
|------|-------------|
| `SekfE.png` | 清新专业（浅色）— Chinese light |
| `fhRXq.png` | 深色极客（深色）— Chinese dark |
| `Trgis.png` | Clean Professional (Light - EN) — English light |
| `p1Urg.png` | Dark Geek (Dark - EN) — English dark |
| `i1Oz5V.png` | 设计语言规范 — Design token spec |

---

## 8. Rules for Other Agents

1. **Do not change layout dimensions** unless you update this document.
2. **Always keep light + dark pairs in sync** when adding a new component or screen.
3. **Always provide Chinese + English text** when adding new labels.
4. **Use the token table above** for colors; do not introduce new colors without documenting them.
5. **Prefer `Geist`** for UI text and `JetBrains Mono`** for section labels/data.
6. **Tag chips must remain pill-shaped** (`cornerRadius: 999`).
7. **When in doubt**, reference the Pencil frames by ID listed in section 2.2.

---

## 9. Next Steps (Optional)

- [ ] Add Welcome screen (empty state) in both themes + languages
- [ ] Add Settings dialog design
- [ ] Add Grid / Gallery / Kanban / Matrix view mockups
- [ ] Add right-click context menus
- [ ] Add dialog components (Add Location, Prompt, Advanced Search)
- [ ] Export a CSS variable file for frontend implementation
