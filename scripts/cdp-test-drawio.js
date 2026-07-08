// Click sample.drawio, then verify inner drawio iframe renders.
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
  // 1) Click on the main page
  const pages = await getPages();
  const main = pages.find((p) => p.type === 'page');
  const wsMain = new WebSocket(main.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  function send(ws, method, params = {}) {
    return new Promise((resolve, reject) => {
      const reqId = ++id;
      pending.set(reqId, { resolve, reject });
      ws.send(JSON.stringify({ id: reqId, method, params }));
    });
  }
  function attach(ws) {
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }
  attach(wsMain);
  await new Promise((r) => wsMain.on('open', r));
  await send(wsMain, 'Runtime.enable');
  const click = await send(wsMain, 'Runtime.evaluate', {
    expression: `(function(){
      const all = Array.from(document.querySelectorAll('*'));
      const target = all.find(el => {
        const t = (el.textContent || '').trim();
        return t === 'sample.drawio' || t.startsWith('sample.drawio');
      });
      if (!target) return 'NOT_FOUND';
      let row = target;
      for (let i = 0; i < 8; i++) {
        if (!row) break;
        const cls = row.className?.toString() || '';
        if (cls.includes('ListItem') || cls.includes('Cell') || cls.includes('row') || cls.includes('EntryCard')) break;
        row = row.parentElement;
      }
      if (!row) return 'NO_ROW';
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
      return 'CLICKED';
    })()`,
    returnByValue: true,
  });
  console.log('[click]', click.result.value);

  // 2) Wait for the drawio outer iframe to appear
  let drawio = null;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    const fresh = await getPages();
    drawio = fresh.find((p) => p.type === 'iframe' && p.url.includes('drawio-editor/index.html'));
    if (drawio) break;
  }
  if (!drawio) { console.log('drawio iframe never appeared'); process.exit(1); }
  console.log('[drawio outer]', drawio.url);

  // 3) Wait for drawio to fully initialize
  await new Promise(r => setTimeout(r, 10000));

  // 4) Connect to drawio outer and inspect inner iframe
  const wsD = new WebSocket(drawio.webSocketDebuggerUrl);
  attach(wsD);
  await new Promise((r) => wsD.on('open', r));
  await send(wsD, 'Runtime.enable');
  const r = await send(wsD, 'Runtime.evaluate', {
    expression: `(function(){
      const inner = document.querySelector('iframe.drawio-iframe');
      if (!inner) return JSON.stringify({err: 'no inner iframe'});
      try {
        const cd = inner.contentDocument;
        const cw = inner.contentWindow;
        return JSON.stringify({
          origin: cw.origin,
          isSecureContext: cw.isSecureContext,
          title: cd.title,
          bodyClass: cd.body.className,
          hasGeEditor: !!cd.querySelector('.geEditor'),
          hasSidebar: !!cd.querySelector('.geSidebar'),
          hasGraph: !!cd.querySelector('.geDiagramContainer, .mxGraph, svg'),
          svgCount: cd.querySelectorAll('svg').length,
          shapeCount: cd.querySelectorAll('rect, ellipse, path').length,
        });
      } catch(e) { return JSON.stringify({err: e.message}); }
    })()`,
    returnByValue: true,
  });
  console.log('[inner]', r.result.value);
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
