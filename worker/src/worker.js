// SnipAudio edge Worker. Static files are still served straight from ../cutter-site; this Worker only runs for
// the 9 page paths (Markdown negotiation + discovery Link header) and for agent resources that have no static file:
// read-only API, MCP, discovery documents, and disabled "under construction" authentication metadata.
// Nothing here stores, logs or forwards request data.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import SITE from './generated/site.json';

const ORIGIN = 'https://snipaudio.com';
const VERSION = SITE.generated_at.slice(0, 10);
const PAGES = new Map(SITE.pages.map(p => [p.path, p]));
const TOOLS = new Map(SITE.tools.map(t => [t.id, t]));
const LINK = '</.well-known/api-catalog>; rel="api-catalog", </openapi.json>; rel="service-desc", </ai/>; rel="service-doc", </.well-known/ai-catalog.json>; rel="describedby"; type="application/json"';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID', 'Access-Control-Expose-Headers': 'Mcp-Session-Id' };

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body, null, 1) + '\n', { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300', ...CORS, ...headers } });
const text = (body, type, headers = {}) => new Response(body, { headers: { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'public, max-age=300', ...CORS, ...headers } });

// ---------- data operations shared by the API, MCP and docs ----------
const toolSummary = t => ({ id: t.id, name: t.name, summary: t.summary, url: t.url, runs_in: t.runs_in, lastmod: t.lastmod });
const toolDetail = t => ({ ...toolSummary(t), title: t.title, description: t.description, how_to: t.how_to, settings: t.settings,
  settings_note: 'Settings and options as the page shows them with default settings; some lists change with other settings (see the help entries).',
  markdown: `${t.url} (request with Accept: text/markdown)`, source_url: t.url });
const STOP = new Set(['a', 'an', 'the', 'is', 'are', 'i', 'my', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'can', 'do', 'does', 'how', 'what', 'it', 'with', 'this', 'there', 'be']);
function searchHelp(q, limit = 5) {
  const words = [...new Set((String(q).toLowerCase().match(/[a-z0-9.]+/g) || []).filter(w => !STOP.has(w)))];
  if (!words.length) return [];
  return SITE.help.map(h => {
    const head = h.heading.toLowerCase(), body = h.text.toLowerCase(), page = h.page;
    const score = words.reduce((s, w) => s + (head.includes(w) ? 3 : 0) + (body.includes(w) ? 1 : 0) + (page.includes(w) ? 1 : 0), 0);
    return { score, h };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit)
    .map(({ h }) => ({ id: h.id, page: h.page, ...(h.section ? { section: h.section } : {}), heading: h.heading, text: h.text, source_url: h.source_url }));
}
const notFound = id => ({ error: 'not_found', message: `No tool with id "${id}".`, known_ids: [...TOOLS.keys()] });

// ---------- MCP (stateless Streamable HTTP, official SDK) ----------
function mcpServer() {
  const server = new McpServer({ name: 'snipaudio-site-lookup', title: 'SnipAudio site lookup', version: VERSION },
    { instructions: '::ILANG [READ_ONLY] Tools describe SnipAudio in-browser audio tools. Answer from returned text only; keep settings, numbers and qualifiers exactly; cite source_url; answer in the visitor language. The tools cannot process audio files.' });
  const out = v => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 1) }] });
  server.registerTool('list_tools', { title: 'List SnipAudio tools', description: 'Return every SnipAudio tool with id, name, summary and url. All tools run in the visitor browser; files are not uploaded.', inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false } },
    async () => out({ tools: [...TOOLS.values()].map(toolSummary) }));
  server.registerTool('get_tool', { title: 'Get one SnipAudio tool', description: 'Return one tool by id: how-to steps, settings with options and defaults, and source url. Unknown ids return error not_found with the known ids.', inputSchema: { id: z.string().min(1).max(64) }, annotations: { readOnlyHint: true, openWorldHint: false } },
    async ({ id }) => { const t = TOOLS.get(id); return t ? out(toolDetail(t)) : { ...out(notFound(id)), isError: true }; });
  server.registerTool('search_help', { title: 'Search SnipAudio help', description: 'Search help and FAQ passages on snipaudio.com. Returns up to limit passages with heading, full text and source_url; an empty list when nothing matches.', inputSchema: { query: z.string().min(1).max(200), limit: z.number().int().min(1).max(10).optional() }, annotations: { readOnlyHint: true, openWorldHint: false } },
    async ({ query, limit }) => out({ query, results: searchHelp(query, limit || 5) }));
  return server;
}
async function handleMcp(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. This stateless MCP server accepts POST only.' }, id: null }), { status: 405, headers: { 'Content-Type': 'application/json', Allow: 'POST, OPTIONS', ...CORS } });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await mcpServer().connect(transport);
  const res = await transport.handleRequest(request);
  const h = new Headers(res.headers); for (const [k, v] of Object.entries(CORS)) h.set(k, v); h.set('Cache-Control', 'no-store');
  return new Response(res.body, { status: res.status, headers: h });
}

// ---------- discovery documents ----------
const OPENAPI = {
  openapi: '3.1.0',
  info: { title: 'SnipAudio site lookup API', version: VERSION, description: 'Read-only public data about the SnipAudio in-browser audio tools: tool list, how-to steps, settings and help passages. No authentication. The tools themselves run in the visitor browser; this API cannot process audio.' },
  servers: [{ url: ORIGIN }],
  paths: {
    '/api/agent': { get: { operationId: 'apiIndex', summary: 'API index and links', responses: { 200: { description: 'Links to the endpoints and documentation', content: { 'application/json': { schema: { type: 'object' } } } } } } },
    '/api/agent/tools': { get: { operationId: 'listTools', summary: 'List all tools', responses: { 200: { description: 'All tools', content: { 'application/json': { schema: { type: 'object', properties: { tools: { type: 'array', items: { $ref: '#/components/schemas/ToolSummary' } } } } } } } } } },
    '/api/agent/tools/{id}': { get: { operationId: 'getTool', summary: 'Get one tool', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', enum: [...TOOLS.keys()] } }],
      responses: { 200: { description: 'Tool detail', content: { 'application/json': { schema: { $ref: '#/components/schemas/ToolDetail' } } } }, 404: { description: 'Unknown id; body lists known_ids', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } } } } },
    '/api/agent/search': { get: { operationId: 'searchHelp', summary: 'Search help and FAQ passages', parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: 200 } }, { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 10, default: 5 } }],
      responses: { 200: { description: 'Matching passages (empty list when nothing matches)', content: { 'application/json': { schema: { type: 'object', properties: { query: { type: 'string' }, results: { type: 'array', items: { $ref: '#/components/schemas/HelpPassage' } } } } } } }, 400: { description: 'Missing or too long q, or bad limit' } } } },
  },
  components: { schemas: {
    ToolSummary: { type: 'object', required: ['id', 'name', 'url'], properties: { id: { type: 'string' }, name: { type: 'string' }, summary: { type: 'string' }, url: { type: 'string', format: 'uri' }, runs_in: { type: 'string' }, lastmod: { type: 'string', format: 'date' } } },
    ToolDetail: { allOf: [{ $ref: '#/components/schemas/ToolSummary' }, { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, how_to: { type: 'array', items: { type: 'string' } }, settings: { type: 'array', items: { type: 'object' } }, settings_note: { type: 'string' }, source_url: { type: 'string', format: 'uri' } } }] },
    HelpPassage: { type: 'object', required: ['id', 'heading', 'text', 'source_url'], properties: { id: { type: 'string' }, page: { type: 'string' }, section: { type: 'string' }, heading: { type: 'string' }, text: { type: 'string' }, source_url: { type: 'string', format: 'uri' } } },
    NotFound: { type: 'object', properties: { error: { const: 'not_found' }, message: { type: 'string' }, known_ids: { type: 'array', items: { type: 'string' } } } },
  } },
};
const API_CATALOG = { linkset: [{ anchor: `${ORIGIN}/api/agent`,
  'service-desc': [{ href: `${ORIGIN}/openapi.json`, type: 'application/vnd.oai.openapi+json' }],
  'service-doc': [{ href: `${ORIGIN}/ai/`, type: 'text/markdown' }] }] };
const SERVER_CARD = {
  $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
  name: 'com.snipaudio/site-lookup', title: 'SnipAudio site lookup', version: VERSION,
  description: 'Read-only lookup of SnipAudio in-browser audio tools: tool list, how-to steps, settings and help passages. No authentication.',
  websiteUrl: `${ORIGIN}/ai/`,
  repository: { url: 'https://github.com/patrick-eu/browser-audio-cutter', source: 'github' },
  remotes: [{ type: 'streamable-http', url: `${ORIGIN}/mcp`, supportedProtocolVersions: ['2025-06-18', '2025-03-26'] }],
  // compatibility fields for discovery clients that read the earlier card draft
  serverInfo: { name: 'snipaudio-site-lookup', title: 'SnipAudio site lookup', version: VERSION },
  transport: { type: 'streamable-http', endpoint: `${ORIGIN}/mcp` },
  capabilities: { tools: { listChanged: false } },
  authentication: { required: false },
};
const SKILLS_INDEX = { $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
  skills: [{ name: 'site-lookup', type: 'skill-md', description: 'Look up SnipAudio tools, settings, limits and help answers, and explain how to use them. Read-only.', url: `${ORIGIN}/ai/skills/site-lookup/SKILL.md`, digest: SITE.skill.digest }] };
const AI_CATALOG = { specVersion: '1.0',
  host: { displayName: 'SnipAudio', identifier: 'did:web:snipaudio.com', documentationUrl: `${ORIGIN}/ai/` },
  entries: [
    { identifier: 'urn:air:snipaudio.com:server:site-lookup', displayName: 'SnipAudio site lookup (MCP)', type: 'application/mcp-server-card+json', url: `${ORIGIN}/.well-known/mcp/server-card.json`,
      representativeQueries: ['how do I convert WAV to MP3 in the browser', 'which bitrates can the M4A to MP3 converter use', 'is my audio file uploaded when I cut it', 'how to find the BPM and key of a song'] },
    { identifier: 'urn:air:snipaudio.com:skill:site-lookup', displayName: 'SnipAudio site lookup skill', type: 'text/markdown', url: `${ORIGIN}/ai/skills/site-lookup/SKILL.md`,
      representativeQueries: ['merge several audio files into one MP3', 'what sample rates can I choose when converting MP3 to WAV'] },
    { identifier: 'urn:air:snipaudio.com:api:site-lookup', displayName: 'SnipAudio site lookup API (OpenAPI)', type: 'application/vnd.oai.openapi+json', url: `${ORIGIN}/openapi.json`,
      representativeQueries: ['list the audio tools on snipaudio.com', 'search SnipAudio help for file size limits'] },
  ] };

// ---------- authentication: disclosed construction placeholder (nothing is issued) ----------
const UC = { status: 'under_construction', available: false, capabilities_status: 'planned_contract_only' };
const AS_META = { ...UC, message: 'Coming soon. Authentication is unavailable. The public lookup API and MCP need no authentication.', launch_date: null,
  issuer: ORIGIN, authorization_endpoint: `${ORIGIN}/agent-auth/authorize`, token_endpoint: `${ORIGIN}/agent-auth/token`, jwks_uri: `${ORIGIN}/.well-known/jwks.json`,
  grant_types_supported: ['authorization_code', 'urn:ietf:params:oauth:grant-type:jwt-bearer'], response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], scopes_supported: ['site:read'],
  agent_auth: { ...UC, skill: `${ORIGIN}/auth.md`, register_uri: `${ORIGIN}/agent-auth/register`, claim_uri: `${ORIGIN}/agent-auth/claim`, identity_types_supported: ['anonymous'],
    anonymous: { ...UC, credential_types_supported: ['access_token'] } } };
const PRM = { ...UC, message: 'Coming soon. Existing public lookup remains available without authentication.', launch_date: null,
  resource: ORIGIN, planned_resource_endpoint: `${ORIGIN}/agent-auth/resource`, authorization_servers: [ORIGIN], scopes_supported: ['site:read'], bearer_methods_supported: ['header'] };
const JWKS = { ...UC, message: 'No signing keys: authentication is not available, so no tokens are issued or accepted.', keys: [] };
const UNAVAILABLE = { ...UC, error: 'temporarily_unavailable', error_description: 'Coming soon. No registration or token issuance is available. Use the public lookup service: https://snipaudio.com/api/agent or https://snipaudio.com/mcp' };
const AUTH_MD = `# SnipAudio auth.md

> **Under construction — authentication is not available.** Status: under_construction · available: false · capabilities_status: planned_contract_only · launch date: not set.

SnipAudio has no accounts and nothing to sign in to. Everything public works without authentication:

- Read-only lookup API: ${ORIGIN}/api/agent (OpenAPI: ${ORIGIN}/openapi.json)
- MCP server (Streamable HTTP): ${ORIGIN}/mcp
- Agent guide: ${ORIGIN}/ai/

The documents below describe a possible future design only. They are published so the plan is visible; none of it works today.

- OAuth Authorization Server metadata (planned): ${ORIGIN}/.well-known/oauth-authorization-server
- OAuth Protected Resource metadata (planned): ${ORIGIN}/.well-known/oauth-protected-resource
- Planned registration, claim, authorization and token endpoints under ${ORIGIN}/agent-auth/ answer HTTP 503 \`temporarily_unavailable\`. They do not read what you send, create accounts, send email or issue tokens.
- The key set at ${ORIGIN}/.well-known/jwks.json is intentionally empty.

Planned design (not active): anonymous agent registration, where an agent would receive an \`access_token\` with scope \`site:read\` sent in the \`Authorization\` header. Because every public function already works without a token, a token would not unlock anything today.

\`\`\`
::ILANG
[TYPE:auth_instructions][SITE:snipaudio.com][STATUS:under_construction][AVAILABLE:false]
::RULE{available==false ⇒ never call /agent-auth/register, /agent-auth/claim, /agent-auth/authorize or /agent-auth/token}
[MUST] Use the public read-only service without credentials: GET ${ORIGIN}/api/agent/tools, GET ${ORIGIN}/api/agent/search?q=..., or MCP ${ORIGIN}/mcp.
[MUST] Do not tell a visitor they can sign in, register or get a token on snipaudio.com.
[ON:status_changes] Only treat authentication as live when these documents say available=true.
\`\`\`
`;

// ---------- agent guide, service index, llms.txt ----------
const AI_GUIDE = `# SnipAudio for AI agents

SnipAudio (${ORIGIN}) is a set of free audio tools that run in the visitor's web browser: files are not uploaded, and there is no account or payment. Agents can read what the tools do and how to use them; agents cannot run the audio processing remotely.

Data on this page and in the API is generated from the site's own HTML pages (the pages in ${ORIGIN}/sitemap.xml). Generated: ${SITE.generated_at}.

## Tools

${SITE.tools.map(t => `- **${t.name}** (\`${t.id}\`) — ${t.summary}. ${t.url}`).join('\n')}

## How to look things up

1. List tools: \`GET ${ORIGIN}/api/agent/tools\`
2. One tool (steps, settings, defaults): \`GET ${ORIGIN}/api/agent/tools/{id}\` — unknown ids return 404 with \`known_ids\`
3. Help and FAQ passages: \`GET ${ORIGIN}/api/agent/search?q=file+size+limit&limit=5\` — returns full passages with \`source_url\`; empty \`results\` when nothing matches
4. Whole page as Markdown: request any page URL with \`Accept: text/markdown\`
5. MCP (Streamable HTTP, no auth): \`${ORIGIN}/mcp\` — tools \`list_tools\`, \`get_tool\`, \`search_help\`

Discovery: OpenAPI ${ORIGIN}/openapi.json · API catalog ${ORIGIN}/.well-known/api-catalog · MCP server card ${ORIGIN}/.well-known/mcp/server-card.json · Agent skill ${ORIGIN}/ai/skills/site-lookup/SKILL.md · AI catalog ${ORIGIN}/.well-known/ai-catalog.json

## Limits of this data

- Measured numbers on the site (lengths, memory, timings) come from the site's own tests and are stated with their test conditions. They are not guarantees for every device or browser.
- Some setting lists change with other settings (for example WAV to MP3 bitrates depend on sample rate and channels); the help passages explain how.
- Authentication is not available (see ${ORIGIN}/auth.md). Nothing on the site needs it.

## Instructions for agents

\`\`\`
::ILANG
[TYPE:agent_guide][SITE:snipaudio.com][MODE:read_only]
[STEP:1] Map the visitor task to a tool id (${SITE.tools.map(t => t.id).join(' | ')}).
[STEP:2] Read the tool record and search help for the specific question.
[STEP:3] Compose the answer from returned text. Preserve tool names, setting labels, option values, numbers, units, dates and qualifiers exactly.
[STEP:4] Cite the source_url you used and give the tool URL plus concrete steps, so the visitor does not need a follow-up question.
[MUST] Answer in the visitor's language; keep on-site labels and values as written.
[MUST] Unknown or unstated facts remain unknown: say the site does not state it.
[NEVER] Claim the site uploads, stores or processes files on a server; claim accounts, sign-in or paid plans exist.
\`\`\`
`;
const INDEX_ILANG = `::ILANG
[TYPE:service_index][SITE:snipaudio.com][VERSION:${VERSION}][MODE:read_only][AUTH:none]
::SERVICE{id:site-lookup-api, protocol:https-json, openapi:${ORIGIN}/openapi.json, base:${ORIGIN}/api/agent}
::SERVICE{id:site-lookup-mcp, protocol:mcp-streamable-http, endpoint:${ORIGIN}/mcp, card:${ORIGIN}/.well-known/mcp/server-card.json}
::SERVICE{id:site-lookup-skill, protocol:agent-skill, url:${ORIGIN}/ai/skills/site-lookup/SKILL.md, index:${ORIGIN}/.well-known/agent-skills/index.json}
::SERVICE{id:page-markdown, protocol:http-content-negotiation, accept:text/markdown, pages:${ORIGIN}/sitemap.xml}
::DOC{guide:${ORIGIN}/ai/, catalog:${ORIGIN}/.well-known/api-catalog, ai_catalog:${ORIGIN}/.well-known/ai-catalog.json, auth:${ORIGIN}/auth.md (under_construction, available=false)}
[MUST] Read-only. Tools run in the visitor browser; no service here processes audio files.
`;
const LLMS = `# SnipAudio

> Free audio tools that run in your web browser: cut, join, find BPM and key, and convert M4A, MP3 and WAV. Files are not uploaded.

Agent guide with API and MCP details: ${ORIGIN}/ai/ · Every page below is also available as Markdown with \`Accept: text/markdown\`.

## Tools

${SITE.tools.map(t => `- [${t.name}](${t.url}): ${t.summary}`).join('\n')}

## About

${SITE.pages.filter(p => !SITE.tools.some(t => t.url === p.url)).map(p => `- [${p.h1}](${p.url}): ${p.description || p.title}`).join('\n')}
`;

// ---------- request handling ----------
function wantsMarkdown(accept) {
  if (!accept) return false;
  const q = type => { let best = -1; for (const part of accept.split(',')) { const [t, ...params] = part.trim().toLowerCase().split(';'); if (t === type || (type === 'text/html' && (t === 'text/*' || t === '*/*'))) { const qp = params.map(s => s.trim()).find(s => s.startsWith('q=')); const v = qp ? parseFloat(qp.slice(2)) : 1; if (t === type) return v; best = Math.max(best, v * 0.99); } } return best; };
  const md = q('text/markdown');
  return md > 0 && md >= q('text/html');
}
const headOnly = (req, res) => req.method === 'HEAD' ? new Response(null, { status: res.status, headers: res.headers }) : res;

async function servePage(request, env, page) {
  if (wantsMarkdown(request.headers.get('Accept'))) {
    return headOnly(request, new Response(page.markdown, { headers: { 'Content-Type': 'text/markdown; charset=utf-8', Vary: 'Accept', Link: LINK, 'Content-Location': page.url, 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' } }));
  }
  const res = await env.ASSETS.fetch(request);
  const h = new Headers(res.headers);
  h.append('Vary', 'Accept');
  if (res.ok) h.set('Link', LINK);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

async function route(request, env) {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  const page = PAGES.get(path);
  if (page) return servePage(request, env, page);

  if (path === '/mcp' || path === '/mcp/') return handleMcp(request);
  if (path.startsWith('/agent-auth/') || path === '/agent-auth') return new Response(JSON.stringify(UNAVAILABLE, null, 1) + '\n', { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '86400', 'X-Robots-Tag': 'noindex', ...CORS } });
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (method !== 'GET' && method !== 'HEAD') return env.ASSETS.fetch(request);

  let res = null;
  switch (path) {
    case '/.well-known/api-catalog': res = json(API_CATALOG, 200, { 'Content-Type': 'application/linkset+json; charset=utf-8' }); break;
    case '/.well-known/mcp/server-card.json': case '/mcp/server-card': res = json(SERVER_CARD); break;
    case '/.well-known/agent-skills/index.json': res = json(SKILLS_INDEX); break;
    case '/.well-known/ai-catalog.json': res = json(AI_CATALOG); break;
    case '/.well-known/oauth-authorization-server': res = json(AS_META, 200, { 'X-Robots-Tag': 'noindex' }); break;
    case '/.well-known/oauth-protected-resource': res = json(PRM, 200, { 'X-Robots-Tag': 'noindex' }); break;
    case '/.well-known/jwks.json': res = json(JWKS, 200, { 'X-Robots-Tag': 'noindex' }); break;
    case '/auth.md': res = text(AUTH_MD, 'text/markdown', { 'X-Robots-Tag': 'noindex' }); break;
    case '/openapi.json': res = json(OPENAPI, 200, { 'Content-Type': 'application/vnd.oai.openapi+json; charset=utf-8' }); break;
    case '/ai': res = Response.redirect(`${url.origin}/ai/`, 301); break;
    case '/ai/': res = text(AI_GUIDE, 'text/markdown', { 'X-Robots-Tag': 'noindex', Link: LINK }); break;
    case '/ai/index.ilang': res = text(INDEX_ILANG, 'text/plain', { 'X-Robots-Tag': 'noindex' }); break;
    case '/ai/skills/site-lookup/SKILL.md': res = new Response(SITE.skill.markdown, { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'X-Robots-Tag': 'noindex', ...CORS } }); break;
    case '/llms.txt': res = text(LLMS, 'text/plain', { 'X-Robots-Tag': 'noindex' }); break;
    case '/api/agent': case '/api/agent/': res = json({ name: 'SnipAudio site lookup API', version: VERSION, read_only: true, authentication: 'none',
      endpoints: { tools: `${ORIGIN}/api/agent/tools`, tool: `${ORIGIN}/api/agent/tools/{id}`, search: `${ORIGIN}/api/agent/search?q={words}&limit={1-10}` }, openapi: `${ORIGIN}/openapi.json`, docs: `${ORIGIN}/ai/`, mcp: `${ORIGIN}/mcp` }); break;
    case '/api/agent/tools': res = json({ tools: [...TOOLS.values()].map(toolSummary) }); break;
    case '/api/agent/search': {
      const q = url.searchParams.get('q'), limitRaw = url.searchParams.get('limit'), limit = limitRaw === null ? 5 : Number(limitRaw);
      if (!q || q.length > 200) res = json({ error: 'bad_request', message: 'Query parameter q is required (1-200 characters).' }, 400);
      else if (!Number.isInteger(limit) || limit < 1 || limit > 10) res = json({ error: 'bad_request', message: 'limit must be an integer from 1 to 10.' }, 400);
      else res = json({ query: q, results: searchHelp(q, limit) });
      break;
    }
    default: {
      const m = path.match(/^\/api\/agent\/tools\/([^/]+)\/?$/);
      if (m) { const id = decodeURIComponent(m[1]), t = TOOLS.get(id); res = t ? json(toolDetail(t)) : json(notFound(id), 404); }
      else if (path.startsWith('/api/agent/')) res = json({ error: 'not_found', message: 'Unknown API path.', docs: `${ORIGIN}/openapi.json` }, 404);
    }
  }
  if (res) return headOnly(request, res);
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    try { return await route(request, env); }
    catch (e) { return new Response(JSON.stringify({ error: 'internal_error' }), { status: 500, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }); }
  },
};
