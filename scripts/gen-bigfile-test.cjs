/**
 * Throwaway generator: creates a folder of test files with controlled modified
 * timestamps so the Calendar perspective can be exercised with a realistic,
 * spread-out dataset (busy days >3 entries → +N popover; varied times-of-day
 * → week timeline; prev-month padding → month grid boundary).
 *
 * Run: `node scripts/gen-bigfile-test.cjs` (safe to re-run; overwrites).
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'Test', '大文件测试');
fs.mkdirSync(root, { recursive: true });

const topics = [
  '周报', '会议纪要', '设计稿', '数据导出', '调研笔记',
  '需求文档', '代码片段', '截图', '待办清单', '项目复盘',
];
const exts = ['.md', '.txt', '.json', '.csv', '.log', '.html'];

// [YYYY-MM-DD, count, hours?]
// hours (optional) spread the day's files across specific hours for the
// week-timeline view; default = a morning/midday spread.
const days = [
  ['2026-06-25', 2],
  ['2026-06-28', 1],
  ['2026-06-30', 3], // prev-month padding in the July grid
  ['2026-07-01', 4],
  ['2026-07-02', 2], // "today" (app date)
  ['2026-07-03', 1],
  ['2026-07-05', 2],
  ['2026-07-08', 6, [9, 11, 14, 16, 19, 22]], // busy + time-spread
  ['2026-07-10', 1],
  ['2026-07-12', 3],
  ['2026-07-15', 5, [10, 13, 15, 17, 20]], // busy
  ['2026-07-18', 2],
  ['2026-07-20', 1],
  ['2026-07-22', 4], // busy
  ['2026-07-25', 2],
  ['2026-07-28', 3],
  ['2026-07-31', 1000], // stress: very busy day → big +N badge + virtualized 1000-entry popover
];

let n = 0;
const summary = {};
for (const [date, count, hours] of days) {
  for (let i = 0; i < count; i++) {
    const topic = topics[n % topics.length];
    const ext = exts[n % exts.length];
    const name = `${date}_${topic}-${i + 1}${ext}`;
    const p = path.join(root, name);
    fs.writeFileSync(p, `${topic} ${i + 1} — ${date}\n大文件测试占位内容。\n`);
    // Cycle within working hours (8..22) so any count — incl. the 50-file
    // stress day — produces valid hours (the old `8 + i*3` overflowed past 23).
    const hh = hours ? hours[i] : 8 + (i % 15);
    const mm = (n * 7) % 60;
    const d = new Date(`${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`);
    fs.utimesSync(p, d, d);
    n++;
  }
  summary[date] = count;
}

console.log(`Created ${n} files under ${path.relative(process.cwd(), root) || root}`);
console.log('Per-day counts (days >3 exercise the +N popover):');
for (const [d, c] of Object.entries(summary).sort()) {
  console.log(`  ${d}: ${c}${c > 3 ? '  ← +N' : ''}`);
}
