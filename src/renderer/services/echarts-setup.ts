import * as echarts from 'echarts/core';
import {
  BarChart,
  HeatmapChart,
  SunburstChart,
  TreeChart,
  TreemapChart,
} from 'echarts/charts';
import {
  GraphicComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components';
import { CanvasRenderer, SVGRenderer } from 'echarts/renderers';

// `echarts-wordcloud` is the odd one out: it ships as a side-effect-only
// module that calls `echarts.registerLayout(...)` on import. The series
// type `wordCloud` lives in `echarts/charts` (registered via `use(...)`
// below), but the actual wordcloud LAYOUT algorithm is in
// `echarts-wordcloud` and must be loaded separately. The import must come
// AFTER the `echarts/core` import so its `registerLayout` call lands on a
// live namespace — placing it before would route to `undefined`.
import 'echarts-wordcloud';

// Register once at module load. Idempotent — multiple importers share the
// same registration. Each call adds to echarts' internal registry; nothing
// in here is destructive.
//
// Charts used across Whale:
//  - TagCloudView:    `wordCloud` (via echarts-wordcloud layout) + `heatmap`
//  - FolderVizView:   `treemap` + `sunburst` + `tree` (tree/radial modes)
//                      + `graphic` (center-label overlay)
//  - CalendarView:    `bar` (12 month preview in YearView)
//
// Renderers:
//  - CanvasRenderer is the default for everything except CalendarView, which
//    opts in to SVG via `opts.renderer: 'svg'`. Registering both is cheap
//    (~60 KB) and removes a "which-renderer" coupling.
echarts.use([
  BarChart,
  HeatmapChart,
  SunburstChart,
  TreeChart,
  TreemapChart,
  GraphicComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapComponent,
  CanvasRenderer,
  SVGRenderer,
]);

export { echarts };
