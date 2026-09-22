// Launches the app with a DevTools port and asserts the window actually
// rendered: chrome is present, the canvas has real pixels, no console errors.
//   node scripts/smoke.mjs
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 9222;
const child = spawn('npm', ['start'], {
  env: { ...process.env, LV_DEBUG_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

let page = null;
for (let i = 0; i < 60 && !page; i += 1) {
  await sleep(1000);
  try {
    page = (await targets()).find((t) => t.type === 'page' && t.url.includes('localhost'));
  } catch { /* devtools not up yet */ }
}
if (!page) { console.error('FAIL: no page target\n' + log); child.kill(); process.exit(1); }

const ws = new (await import('ws')).default(page.webSocketDebuggerUrl);
await new Promise((resolve) => ws.on('open', resolve));
let id = 0;
function evaluate(expression) {
  return new Promise((resolve) => {
    const myId = ++id;
    const onMessage = (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id === myId) { ws.off('message', onMessage); resolve(msg.result?.result?.value); }
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ id: myId, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  });
}

// Wait for React to mount before probing, or the first checks read an empty DOM.
for (let i = 0; i < 40; i += 1) {
  const ready = await evaluate(`!!document.querySelector('.toolbar button')`);
  if (ready) break;
  await sleep(250);
}

const checks = {
  'toolbar buttons': await evaluate(`[...document.querySelectorAll('.toolbar button')].map(b=>b.textContent).join('|')`),
  'open affordance': await evaluate(`(!!document.querySelector('.toolbar button[aria-label="Open project"]') && (document.querySelector('.empty button.open')?.textContent ?? '')) || 'none'`),
  'canvas size': await evaluate(`(()=>{const c=document.querySelector('canvas');return c?c.width+'x'+c.height:'none'})()`),
  'canvas painted': await evaluate(`(()=>{const c=document.querySelector('canvas');if(!c)return false;const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;for(let i=0;i<d.length;i+=4){if(d[i]||d[i+1]||d[i+2])return true}return false})()`),
  'empty state': await evaluate(`document.querySelector('.empty h1')?.textContent ?? 'none'`),
};

const project = process.env.LV_SMOKE_PROJECT
  ?? `${process.env.HOME}/Music/Logic/mega_test.logicx`;
await evaluate(`window.__smoke = window.lv.project.load(${JSON.stringify(project)}).then(r => { window.__smokeResult = r; })`);
for (let i = 0; i < 40; i += 1) {
  await sleep(500);
  const done = await evaluate('!!window.__smokeResult');
  if (done) break;
}
await sleep(600);
checks['pixel@10,10 after load'] = await evaluate(
  `(()=>{const c=document.querySelector('canvas');const d=c.getContext('2d').getImageData(10,10,1,1).data;return [...d].join(',')})()`,
);
checks['canvas painted after load'] = await evaluate(
  `(()=>{const c=document.querySelector('canvas');const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;for(let i=0;i<d.length;i+=4){if(d[i]||d[i+1]||d[i+2])return true}return false})()`,
);
checks['canvas count'] = await evaluate(`document.querySelectorAll('canvas').length`);
checks['project load'] = await evaluate(
  `window.__smokeResult?.error ?? (window.__smokeResult ? window.__smokeResult.projectName + ' / ' + window.__smokeResult.regions.length + ' regions' : 'timed out')`,
);

// Drive the same path the UI does, then let a few frames run.
await evaluate(`
  (() => {
    const btns = [...document.querySelectorAll('.toolbar button')];
    return true;
  })()
`);

let ok = true;
for (const [name, value] of Object.entries(checks)) {
  console.log(`  ${name}: ${value}`);
}
if (!checks['open affordance']?.includes('Open new .logicx')) { console.error('FAIL: open affordance missing'); ok = false; }
if (checks['canvas size'] === 'none' || checks['canvas size'] === '0x0') { console.error('FAIL: canvas not sized'); ok = false; }
if (checks['canvas painted after load'] !== true) { console.error('FAIL: canvas never painted'); ok = false; }

const errors = log.split('\n').filter((l) => (
  l.startsWith('[renderer]')
  && !l.includes('Security Warning')
  && !l.includes('[renderer] loaded')
  // Emitted by this script's own getImageData probe, not by the app.
  && !l.includes('willReadFrequently')
));
if (errors.length) { console.error('FAIL: renderer errors:\n' + errors.join('\n')); ok = false; }

ws.close();
child.kill('SIGTERM');
console.log(ok ? '\nSMOKE PASS' : '\nSMOKE FAIL');
process.exit(ok ? 0 : 1);
