// Reviewer-only native Chrome CDP. Synthetic component fixtures, not deployment/device acceptance.
import fs from 'node:fs';
const tabs = await (await fetch('http://127.0.0.1:5489/json/list')).json();
const tab = tabs.find(t => t.type === 'page' && /5490|5488|about:blank/.test(t.url));
if (!tab) throw Error('Isolated reviewer Chrome unavailable');
const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
let seq = 0;
const pending = new Map();
socket.addEventListener('message', event => {
  const data = JSON.parse(event.data);
  if (!data.id) return;
  const item = pending.get(data.id); pending.delete(data.id);
  data.error ? item.reject(data.error) : item.resolve(data.result);
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => (await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
await call('Page.enable');
const results = [];
for (const width of [360, 390, 900, 1280, 1440]) {
  await call('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: false });
  for (const story of ['composer--short', 'command--model-long-names', 'work--thinking-live', 'work--thinking-truncated', 'settings--personal']) {
    await call('Page.navigate', { url: 'http://127.0.0.1:5488/iframe.html?id=' + story + '&viewMode=story' });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate("Boolean(document.getElementById('storybook-root')?.children.length)")) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await evaluate('document.fonts.ready');
    await new Promise(resolve => setTimeout(resolve, 200));
    if (story.startsWith('work--')) await evaluate("(()=>{for(const b of document.querySelectorAll('button')){if(/Working|Worked/.test(b.textContent)&&b.getAttribute('aria-expanded')!=='true')b.click();}return true;})()");
    await new Promise(resolve => setTimeout(resolve, 50));
    if (story.startsWith('work--')) await evaluate("(()=>{for(const b of document.querySelectorAll('button'))if(b.textContent.trim()==='Thinking'&&b.getAttribute('aria-expanded')!=='true')b.click();return true;})()");
    const metrics = await evaluate("(()=>{const controls=[...document.querySelectorAll('button,[cmdk-root]')].map(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {label:e.getAttribute('aria-label')||e.textContent.trim(),x:r.x,y:r.y,width:r.width,height:r.height,color:s.color,background:s.backgroundColor,font:s.fontFamily,visible:r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight};});return {viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,text:document.body.innerText.slice(0,2000),controls};})()");
    const shot = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(new URL(story + '-' + width + '-review.png', import.meta.url), Buffer.from(shot.data, 'base64'));
    results.push({ story, width, ...metrics });
  }
}
fs.writeFileSync(new URL('storybook-review.json', import.meta.url), JSON.stringify({ scope: 'Native Chrome isolated synthetic Storybook fixtures, not physical phone/authenticated server acceptance', capturedAt: new Date().toISOString(), results }, null, 2));
console.log(JSON.stringify(results.map(r => ({ story:r.story,width:r.width,overflow:r.scrollWidth>r.width,thinking:r.controls.filter(c=>c.label==='Thinking').length,send:r.controls.find(c=>c.label==='Send'),picker:r.controls.find(c=>c.label.startsWith('Workspace default')) }))));
socket.close();
