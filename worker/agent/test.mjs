// End-to-end checks for the agent resources. Usage: node agent/test.mjs [base] (default http://127.0.0.1:8796)
// Prints one line per check and exits non-zero if any fail.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import crypto from 'node:crypto';

const BASE = (process.argv[2] || 'http://127.0.0.1:8796').replace(/\/$/, '');
const PAGES = ['/', '/audio-joiner/', '/bpm-finder/', '/m4a-to-mp3/', '/mp3-to-wav/', '/wav-to-mp3/', '/about/', '/privacy/', '/contact/'];
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };
const get = async (path, headers = {}, init = {}) => { const r = await fetch(BASE + path, { headers, redirect: 'manual', ...init }); const body = await r.text(); return { r, body, type: r.headers.get('content-type') || '' }; };
const asJson = s => { try { return JSON.parse(s); } catch { return null; } };

// pages: HTML by default, Markdown on request, no cache contamination either way
for (const p of PAGES) {
  const h1 = await get(p);
  const md = await get(p, { Accept: 'text/markdown' });
  const h2 = await get(p, { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' });
  const md2 = await get(p, { Accept: 'text/markdown, text/html;q=0.5' });
  check(`page ${p} html`, h1.r.status === 200 && h1.type.startsWith('text/html') && /<html/i.test(h1.body) && h1.r.headers.get('vary')?.toLowerCase().includes('accept'), `${h1.r.status} ${h1.type} vary=${h1.r.headers.get('vary')}`);
  check(`page ${p} markdown`, md.r.status === 200 && md.type.startsWith('text/markdown') && /^# /m.test(md.body) && !/<html/i.test(md.body) && md.body.length > 300, `${md.type} ${md.body.length} chars, first heading "${(md.body.match(/^# .*/m) || [''])[0]}"`);
  check(`page ${p} html after markdown`, h2.type.startsWith('text/html') && /<html/i.test(h2.body));
  check(`page ${p} markdown preferred over html q=0.5`, md2.type.startsWith('text/markdown'));
  if (p === '/') check('homepage Link header', /rel="api-catalog"/.test(h1.r.headers.get('link') || '') && /rel="service-desc"/.test(h1.r.headers.get('link') || ''), h1.r.headers.get('link'));
}

// discovery documents: status, media type, parse, links resolve
const docs = [
  ['/.well-known/api-catalog', 'application/linkset+json'], ['/openapi.json', 'application/vnd.oai.openapi+json'], ['/.well-known/mcp/server-card.json', 'application/json'],
  ['/.well-known/agent-skills/index.json', 'application/json'], ['/.well-known/ai-catalog.json', 'application/json'], ['/.well-known/oauth-authorization-server', 'application/json'],
  ['/.well-known/oauth-protected-resource', 'application/json'], ['/.well-known/jwks.json', 'application/json'], ['/auth.md', 'text/markdown'], ['/ai/', 'text/markdown'],
  ['/ai/index.ilang', 'text/plain'], ['/ai/skills/site-lookup/SKILL.md', 'text/markdown'], ['/llms.txt', 'text/plain'], ['/robots.txt', 'text/plain'], ['/sitemap.xml', 'application/xml'],
];
const D = {};
for (const [path, type] of docs) {
  const x = await get(path);
  D[path] = x;
  check(`doc ${path}`, x.r.status === 200 && x.type.startsWith(type) && !/<html/i.test(x.body), `${x.r.status} ${x.type}`);
}
const catalog = asJson(D['/.well-known/api-catalog'].body);
check('api-catalog linkset anchor + service-desc + service-doc', catalog?.linkset?.[0]?.anchor && catalog.linkset[0]['service-desc']?.[0]?.href && catalog.linkset[0]['service-doc']?.[0]?.href);
check('ai-catalog CORS *', D['/.well-known/ai-catalog.json'].r.headers.get('access-control-allow-origin') === '*');
const ard = asJson(D['/.well-known/ai-catalog.json'].body);
check('ai-catalog entries have exactly one of url/data', ard?.entries?.length && ard.entries.every(e => ('url' in e) !== ('data' in e)));
const card = asJson(D['/.well-known/mcp/server-card.json'].body);
check('server card fields', card?.name && card?.version && card?.remotes?.[0]?.url && card?.serverInfo?.name && card?.transport?.endpoint && card?.capabilities?.tools, JSON.stringify({ name: card?.name, endpoint: card?.transport?.endpoint }));
const skills = asJson(D['/.well-known/agent-skills/index.json'].body);
const skill = D['/ai/skills/site-lookup/SKILL.md'];
const served = 'sha256:' + crypto.createHash('sha256').update(Buffer.from(await (await fetch(BASE + '/ai/skills/site-lookup/SKILL.md')).arrayBuffer())).digest('hex');
check('skill digest matches served bytes', skills?.skills?.[0]?.digest === served, `${skills?.skills?.[0]?.digest} vs ${served}`);
check('skill front matter name/description', /^---\nname: site-lookup\ndescription: .+\n---\n/.test(skill.body));
const as = asJson(D['/.well-known/oauth-authorization-server'].body), prm = asJson(D['/.well-known/oauth-protected-resource'].body);
check('auth docs disclose construction', as?.available === false && prm?.available === false && as?.status === 'under_construction' && asJson(D['/.well-known/jwks.json'].body)?.keys?.length === 0);
check('PRM authorization_servers match AS issuer; resource is origin', prm?.authorization_servers?.[0] === as?.issuer && prm?.resource === 'https://snipaudio.com');
check('auth.md H1 contains auth.md', /^# .*auth\.md/m.test(D['/auth.md'].body));
check('robots Content-Signal', /Content-Signal: search=yes, ai-input=yes, ai-train=no/.test(D['/robots.txt'].body));

// construction endpoints: 503, no-store, nothing issued
for (const [path, method] of [['/agent-auth/register', 'POST'], ['/agent-auth/token', 'POST'], ['/agent-auth/authorize', 'GET'], ['/agent-auth/claim', 'POST'], ['/agent-auth/resource', 'GET']]) {
  const x = await get(path, { 'Content-Type': 'application/json' }, { method, ...(method === 'POST' ? { body: '{"email":"test@example.com"}' } : {}) });
  const j = asJson(x.body);
  check(`${method} ${path} 503 temporarily_unavailable`, x.r.status === 503 && j?.error === 'temporarily_unavailable' && x.r.headers.get('cache-control') === 'no-store' && !x.r.headers.get('set-cookie') && !x.r.headers.get('location'), `${x.r.status}`);
}

// REST API: known, unknown, edge cases; public (no auth challenge)
const tools = await get('/api/agent/tools');
const tj = asJson(tools.body);
check('api tools list', tools.r.status === 200 && tj?.tools?.length === 6 && !tools.r.headers.get('www-authenticate'), tj?.tools?.map(t => t.id).join(','));
const one = asJson((await get('/api/agent/tools/wav-to-mp3')).body);
check('api tool detail has steps + settings + source_url', one?.how_to?.length >= 3 && one?.settings?.some(s => s.label === 'Sample rate') && one?.source_url === 'https://snipaudio.com/wav-to-mp3/');
const miss = await get('/api/agent/tools/flac-to-mp3');
check('api unknown tool 404 with known_ids', miss.r.status === 404 && asJson(miss.body)?.known_ids?.length === 6);
const s1 = asJson((await get('/api/agent/search?q=' + encodeURIComponent('Which WAV files work?'))).body);
check('api search finds WAV formats passage', s1?.results?.[0]?.id === 'wav-to-mp3:which-wav-files-work' && /64-bit float/.test(s1.results[0].text), s1?.results?.map(r => r.id).slice(0, 3).join(','));
const s2 = asJson((await get('/api/agent/search?q=zzqxv')).body);
check('api search no match -> empty results', Array.isArray(s2?.results) && s2.results.length === 0);
check('api search missing q -> 400', (await get('/api/agent/search')).r.status === 400);
check('api search limit 11 -> 400', (await get('/api/agent/search?q=mp3&limit=11')).r.status === 400);
const s3 = asJson((await get('/api/agent/search?q=bpm%20half%20time&limit=2')).body);
check('api search qualifier kept (half/double time passage)', s3?.results?.length <= 2 && s3.results.some(r => r.id === 'bpm-finder:half-time-and-double-time'), s3?.results?.map(r => r.id).join(','));

// MCP: real lifecycle through the official client
try {
  const client = new Client({ name: 'snipaudio-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(BASE + '/mcp')));
  const info = client.getServerVersion();
  check('mcp initialize', info?.name === 'snipaudio-site-lookup', JSON.stringify(info));
  const list = await client.listTools();
  check('mcp tools/list', ['list_tools', 'get_tool', 'search_help'].every(n => list.tools.some(t => t.name === n)), list.tools.map(t => t.name).join(','));
  const r1 = JSON.parse((await client.callTool({ name: 'get_tool', arguments: { id: 'mp3-to-wav' } })).content[0].text);
  check('mcp get_tool known', r1.id === 'mp3-to-wav' && r1.how_to.length > 0);
  const r2 = await client.callTool({ name: 'get_tool', arguments: { id: 'nope' } });
  check('mcp get_tool unknown -> isError + known_ids', r2.isError === true && JSON.parse(r2.content[0].text).known_ids.length === 6);
  const r3 = JSON.parse((await client.callTool({ name: 'search_help', arguments: { query: 'is my song uploaded', limit: 3 } })).content[0].text);
  check('mcp search_help', r3.results.length > 0 && r3.results.length <= 3 && r3.results.every(r => r.source_url.startsWith('https://snipaudio.com/')), r3.results.map(r => r.id).join(','));
  await client.close();
} catch (e) { check('mcp lifecycle', false, e.message); }
const mget = await get('/mcp');
check('mcp GET -> 405 (stateless POST only)', mget.r.status === 405);

// static assets untouched
const js = await get('/lame.min.js');
check('static asset served without Link header', js.r.status === 200 && !js.r.headers.get('link'));
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
