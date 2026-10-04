// Reviewer-only diagnostic. Native Chrome CDP, no Playwright, synthetic API.
// This verifies production browser/client behavior; it does not prove Worker,
// provider, authentication, deployment or physical-phone acceptance.
import fs from 'node:fs';
const tabs = await (await fetch('http://127.0.0.1:5489/json/list')).json();
const tab = tabs.find(t => t.type === 'page' && (t.url.includes('5490') || t.url.includes('5488') || t.url === 'about:blank'));
if (!tab) throw Error('Isolated review Chrome page unavailable');
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map();
ws.addEventListener('message', e => {
  const d = JSON.parse(e.data);
  if (!d.id) return;
  const p = pending.get(d.id);
  pending.delete(d.id);
  d.error ? p.reject(d.error) : p.resolve(d.result);
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => (await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (expression, timeout = 8000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await evaluate(expression)) return;
    await wait(50);
  }
  throw Error('Timed out: ' + expression);
};
function mock() {
  const originalFetch = window.fetch.bind(window), now = new Date().toISOString();
  const state = window.__otisReview = { calls: [], messages: [], chat: null, sendCount: 0 };
  // Synthetic client transport only. Real Worker SSE is verified separately.
  window.EventSource = class extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    close() {}
  };
  const chat = { id: 'review-chat', workspace_id: 'review-ws', author_user_id: 'review-user', author_display_name: 'Review User', title: 'Synthetic conversation', model_override: null, thinking_override: null, is_archived: false, activity_cursor: 0, created_at: now, updated_at: now, last_activity_at: now };
  if (new URLSearchParams(location.search).get('chat') === chat.id) { state.chat = chat; state.listReleased = true; state.messages = Array.from({length:80},(_,i)=>({id:'seed-'+i,workspace_id:'review-ws',chat_id:chat.id,author_user_id:'review-user',author_kind:'member',channel:'web',client_message_id:null,content_text:'Synthetic historical note '+i+' with enough content to create a genuinely long transcript.',run_id:null,sequence:i+1,created_at:now,updated_at:now})); }
  const model = { command_key: 'synthetic-model', display_name: 'Synthetic test model', provider: 'opencode_go', native_audio_supported: false, voice_available: false, available: true, is_current: true, is_default: true, thinking: { state: 'supported', current_choice_id: null, effective_choice_id: null, is_default: true, choices: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] } };
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  window.fetch = async (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!u.pathname.startsWith('/api/')) return originalFetch(input, init);
    const method = init.method || 'GET', body = init.body ? JSON.parse(init.body) : null;
    state.calls.push({ path: u.pathname, search: u.search, method, body, time: performance.now() });
    if (u.pathname === '/api/me') return json({ user: { id: 'review-user', display_name: 'Review User' }, workspaces: [{ id: 'review-ws', name: 'Synthetic workspace', role: 'owner' }] });
    if (u.pathname === '/api/commands') return json({ commands: [] });
    if (u.pathname.endsWith('/models')) return json({ models: [model], current_command_key: model.command_key, default_command_key: model.command_key });
    if (u.pathname.endsWith('/chats')) {
      if (method === 'POST') { state.chat = chat; return json({ chat }, 201); }
      if (state.chat && !state.listReleased) return new Promise(resolve => { window.__releaseReviewList = () => { state.listReleased = true; resolve(json({ chats: [chat] })); }; });
      return json({ chats: state.chat ? [chat] : [] });
    }
    if (u.pathname.endsWith('/review-chat')) return json({ chat, is_author: true });
    if (u.pathname.endsWith('/messages')) {
      if (method === 'POST') {
        state.sendCount++;
        if (state.sendCount === 1) return new Promise(resolve => { window.__acceptReviewSend = () => resolve(json({message_id:'review-accepted',run_id:'review-run',acceptance_sequence:81},202)); });
        let saved = state.messages.find(m => m.client_message_id === body.client_message_id);
        if (!saved) {
          saved = { id: 'review-msg-' + state.sendCount, workspace_id: 'review-ws', chat_id: chat.id, author_user_id: 'review-user', author_display_name: 'Review User', author_kind: 'member', channel: 'web', inbound_message_id: 'review-in', client_message_id: body.client_message_id, content_text: body.text, media_id: null, run_id: null, sequence: state.messages.length + 1, created_at: now, updated_at: now };
          state.messages.push(saved);
        }
        return json({ message_id: saved.id, run_id: 'review-run', acceptance_sequence: saved.sequence }, 202);
      }
      return json({ messages: state.messages, next_before_sequence: null });
    }
    if (u.pathname.endsWith('/clarifications')) return json({ clarifications: [] });
    if (u.pathname.endsWith('/activity')) {
      if (u.searchParams.get('stream') === 'sse') return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(': synthetic fixture\n\n')); init.signal?.addEventListener('abort', () => { try { c.close(); } catch {} }); } }), { headers: { 'content-type': 'text/event-stream' } });
      return json({ activities: [], latest_cursor: 0, has_more: false });
    }
    if (u.pathname.endsWith('/review-run')) return json({ run: { id: 'review-run', workspace_id: 'review-ws', chat_id: chat.id, status: 'succeeded', error_code: null, error_message: null }, status: 'succeeded', steps: [], actions: [], activities: [], sources: [], pending_clarification: null });
    return json({ error: { code: 'synthetic_unhandled', message: 'Unmocked synthetic path' } }, 404);
  };
}

const result={scope:'Native Chrome production App with synthetic delayed acceptance, not server evidence'};
try{
await call('Page.enable');
await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
await call('Storage.clearDataForOrigin',{origin:'http://127.0.0.1:5490',storageTypes:'indexeddb,local_storage'});
await evaluate('sessionStorage.clear()');
await call('Page.addScriptToEvaluateOnNewDocument',{source:'('+mock.toString()+')()'});
await call('Page.navigate',{url:'http://127.0.0.1:5490/?workspace=review-ws&chat=review-chat'});
await until("document.querySelectorAll('.otis-turn__bubble').length>=80");
await evaluate("document.querySelector('textarea').focus()");
await call('Input.insertText',{text:'Synthetic delayed-ack scroll probe'});
await until("document.querySelector('button[aria-label=Send]')?.disabled===false");
await evaluate("document.querySelector('button[aria-label=Send]').click()");
await until('window.__otisReview.sendCount===1');
await wait(200);
await evaluate("(()=>{const e=document.querySelector('.otis-transcript');e.scrollTop=200;e.dispatchEvent(new Event('scroll'));return true;})()");
await wait(200);
result.before=await evaluate("document.querySelector('.otis-transcript').scrollTop");
await evaluate('window.__acceptReviewSend()');
await wait(500);
result.after=await evaluate("document.querySelector('.otis-transcript').scrollTop");
result.preserved=Math.abs(result.after-result.before)<5;
result.max=await evaluate("(()=>{const e=document.querySelector('.otis-transcript');return e.scrollHeight-e.clientHeight;})()");
}catch(e){result.error=String(e);}finally{
fs.writeFileSync('plans/008-browser-evidence/delayed-ack-scroll.json',JSON.stringify(result,null,2));
console.log(JSON.stringify(result));ws.close();
}
