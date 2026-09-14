// Real WebMCP check in Chromium with the WebMCP blink feature: tools registered on load, executed through document.modelContext.executeTool.
import { chromium } from 'playwright';
const BASE = (process.argv[2] || 'http://127.0.0.1:8796').replace(/\/$/, '');
const b = await chromium.launch({ args: ['--enable-blink-features=WebMCP'] });
const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
const reqs = []; p.on('request', r => reqs.push(r.url().replace(BASE, '')));
await p.goto(BASE + '/', { waitUntil: 'load' });
const r = await p.evaluate(async () => {
  const mc = document.modelContext, tools = await mc.getTools();
  const run = async (name, input) => { const t = tools.find(x => x.name === name); try { return JSON.parse(await mc.executeTool(t, JSON.stringify(input))); } catch (e) { return { thrown: String(e) }; } };
  return {
    names: tools.map(t => t.name), schema: tools.find(t => t.name === 'get_audio_tool')?.inputSchema,
    list: await run('list_audio_tools', {}), get: await run('get_audio_tool', { id: 'bpm-finder' }), unknown: await run('get_audio_tool', { id: 'nope' }),
    search: await run('search_page_help', { query: 'mp3 without re-encoding' }), empty: await run('search_page_help', { query: 'zzqxv' }),
  };
});
console.log('registered:', r.names.join(', '));
console.log('input schema get_audio_tool:', typeof r.schema === 'string' ? r.schema.slice(0, 160) : JSON.stringify(r.schema)?.slice(0, 160));
console.log('list_audio_tools:', r.list.tools?.map(t => t.id).join(','));
console.log('get_audio_tool bpm-finder:', r.get.name, '|', r.get.how_to?.length, 'steps |', r.get.url);
console.log('get_audio_tool nope:', JSON.stringify(r.unknown).slice(0, 160));
console.log('search_page_help:', r.search.results?.[0]?.question, '->', r.search.results?.[0]?.answer.slice(0, 80));
console.log('search_page_help no match:', JSON.stringify(r.empty));
const before = reqs.length;
const nav = await p.evaluate(async () => { const mc = document.modelContext, t = (await mc.getTools()).find(x => x.name === 'open_audio_tool'); mc.executeTool(t, JSON.stringify({ id: "wav-to-mp3" })); return 'called'; });
await p.waitForURL('**/wav-to-mp3/', { timeout: 10000 }).catch(() => {});
console.log('open_audio_tool:', nav, '->', p.url().replace(BASE, ''));
// ordinary page still works without the flag: cutter loads a file and shows the editor
const b2 = await chromium.launch(), p2 = await b2.newPage();
const e2 = []; p2.on('pageerror', e => e2.push(e.message));
await p2.goto(BASE + '/'); await p2.setInputFiles('#file', '/root/projects/WEB-AD/test/cutter/saw-stereo.wav');
await p2.waitForSelector('#editor:not([hidden])', { timeout: 15000 }).then(() => console.log('normal browser: cutter loads file, editor shown')).catch(e => console.log('normal browser: editor not shown', e.message));
console.log('page errors:', JSON.stringify(errs), JSON.stringify(e2));
await b.close(); await b2.close();
