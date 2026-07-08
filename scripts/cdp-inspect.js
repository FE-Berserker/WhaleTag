// Properly attach to the drawio iframe target and inspect it.
const WebSocket = require('ws');
const http = require('http');

function getPages() {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 9222, path: '/json' }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

(async () => {
  const pages = await getPages();
  const main = pages.find((p) => p.type === 'page');
  const drawioPage = pages.find((p) => p.type === 'iframe');
  if (!drawioPage) { console.log('no iframe target'); process.exit(1); }
  console.log('[iframe]', drawioPage.url, 'wsUrl:', drawioPage.webSocketDebuggerUrl);

  // Connect DIRECTLY to the iframe's WebSocket (no need for attachToTarget)
  const ws = new WebSocket(drawioPage.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const reqId = ++id;
      pending.set(reqId, { resolve, reject });
      ws.send(JSON.stringify({ id: reqId, method, params }));
    });
  }
  const networkLog = [];
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      const args = (msg.params.args || []).map((a) => a.value !== undefined ? a.value : (a.description || a.type)).join(' ');
      console.log(`[drawio ${msg.params.type}]`, args);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const e = msg.params.exceptionDetails;
      console.log(`[drawio exception] ${e.text}`);
      console.log('  url:', e.url, 'line:', e.lineNumber, 'col:', e.columnNumber);
      if (e.exception) console.log('  →', (e.exception.description || e.exception.value || '').slice(0, 500));
    } else if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry;
      console.log(`[drawio log.${e.level}] ${e.text}`);
    } else if (msg.method === 'Network.responseReceived') {
      const r = msg.params.response;
      console.log(`[drawio net ${r.status}] ${r.url.slice(0, 140)}`);
    } else if (msg.method === 'Network.loadingFailed') {
      const e = msg.params;
      console.log(`[drawio net.fail] ${e.errorText} (canceled=${e.canceled})`);
    }
  });
  await new Promise((r) => ws.on('open', r));
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');

  // Wait a moment for the page to settle
  await new Promise(r => setTimeout(r, 1500));

  // 1) Get the actual HTML
  const html = await send('Runtime.evaluate', {
    expression: 'document.documentElement.outerHTML',
    returnByValue: true,
  });
  console.log('[html length]', html.result.value.length);
  console.log('[html]', html.result.value.slice(0, 3000));

  // 2) Check what scripts the page knows about
  const resources = await send('Runtime.evaluate', {
    expression: `(function(){
      const scripts = Array.from(document.scripts).map(s => ({src: s.src, defer: s.defer, type: s.type, complete: s.dataset.complete}));
      const styles = Array.from(document.querySelectorAll('link[rel=stylesheet]')).map(l => l.href);
      const metas = Array.from(document.querySelectorAll('meta[http-equiv]')).map(m => ({name: m.getAttribute('http-equiv'), content: (m.content||'').slice(0, 300)}));
      const root = document.getElementById('root');
      return JSON.stringify({ scriptCount: scripts.length, scripts, styleCount: styles.length, styles, metas, rootExists: !!root, rootChildren: root?.children.length || 0, readyState: document.readyState, bodyText: (document.body?.innerText||'').slice(0,200) });
    })()`,
    returnByValue: true,
  });
  console.log('[resources]', resources.result.value);

  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
