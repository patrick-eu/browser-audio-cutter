// WebMCP: lets an AI agent in this browser tab list SnipAudio's tools, read one tool's steps, open a tool page,
// and search the help text on this page. Registers only where the browser provides modelContext; does nothing otherwise.
// Tool data is inline, so visitors download nothing extra.
(() => {
  const mc = document.modelContext || navigator.modelContext;
  if (!mc || typeof mc.registerTool !== 'function') return;
  const TOOLS = /*TOOLS*/[];
  const ORIGIN = 'https://snipaudio.com';
  const ac = new AbortController();
  addEventListener('pagehide', () => ac.abort(), { once: true });
  const text = v => JSON.stringify(v);
  const tools = [
    { name: 'list_audio_tools',
      description: '::ILANG [READ_ONLY] Return every SnipAudio tool: id, name, summary, url. Tools run in the visitor browser; files are not uploaded.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: async () => text({ tools: TOOLS.map(({ id, name, summary, url }) => ({ id, name, summary, url })) }) },
    { name: 'get_audio_tool',
      description: '::ILANG [READ_ONLY] Return one tool by id with its how-to steps and url. [ON:unknown_id] returns error not_found and known ids. For settings, limits and FAQ fetch the tool url with Accept:text/markdown or GET /api/agent/tools/{id}.',
      inputSchema: { type: 'object', properties: { id: { type: 'string', enum: TOOLS.map(t => t.id) } }, required: ['id'], additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: async ({ id } = {}) => { const t = TOOLS.find(x => x.id === id); return text(t ? { ...t, details_api: `${ORIGIN}/api/agent/tools/${t.id}` } : { error: 'not_found', known_ids: TOOLS.map(x => x.id) }); } },
    { name: 'search_page_help',
      description: '::ILANG [READ_ONLY] Search the help and FAQ text on the current page for words in query; return matching questions with answers and source url. [MUST] quote answers with their qualifiers. [ON:no_match] returns an empty list.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['query'], additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: async ({ query = '' } = {}) => {
        const words = String(query).toLowerCase().match(/[a-z0-9]+/g) || [];
        const hits = [];
        for (const h of document.querySelectorAll('main section h3')) {
          let answer = '', n = h.nextElementSibling;
          while (n && !/^H[23]$/.test(n.tagName)) { answer += (answer ? ' ' : '') + n.textContent.trim(); n = n.nextElementSibling; }
          const hay = (h.textContent + ' ' + answer).toLowerCase(), score = words.filter(w => hay.includes(w)).length;
          if (score) hits.push({ score, question: h.textContent.trim(), answer, source_url: ORIGIN + location.pathname });
        }
        return text({ query, results: hits.sort((a, b) => b.score - a.score).slice(0, 5).map(({ score, ...r }) => r) });
      } },
    { name: 'open_audio_tool',
      description: '::ILANG [NAVIGATION] Open a SnipAudio tool page in this tab by id. The visitor then picks files in that page; nothing is uploaded.',
      inputSchema: { type: 'object', properties: { id: { type: 'string', enum: TOOLS.map(t => t.id) } }, required: ['id'], additionalProperties: false },
      execute: async ({ id } = {}) => { const t = TOOLS.find(x => x.id === id); if (!t) return text({ error: 'not_found', known_ids: TOOLS.map(x => x.id) }); location.assign(new URL(t.url).pathname); return text({ opened: t.url }); } },
  ];
  for (const t of tools) { try { const p = mc.registerTool(t, { signal: ac.signal }); if (p && p.catch) p.catch(() => {}); } catch {} }
})();
