---
name: site-lookup
description: Look up SnipAudio's free in-browser audio tools (cutter, joiner, BPM finder, M4A to MP3, MP3 to WAV, WAV to MP3), their settings, limits and help answers, and tell a visitor exactly how to use them. Read-only; the tools themselves run in the visitor's browser.
---

# SnipAudio site lookup

SnipAudio (https://snipaudio.com) is a set of free audio tools that run in the visitor's web browser. Files are not uploaded. There is no account, API key or payment. This skill reads the site's public descriptions; it cannot process audio for you.

## Tools

{{TOOL_LIST}}

## Endpoints

- `GET https://snipaudio.com/api/agent/tools` — all tools
- `GET https://snipaudio.com/api/agent/tools/{id}` — one tool: how-to steps, settings with options and defaults, source URL
- `GET https://snipaudio.com/api/agent/search?q={words}&limit={1-10}` — help and FAQ passages matching the words
- MCP (Streamable HTTP, stateless): `https://snipaudio.com/mcp` — tools `list_tools`, `get_tool`, `search_help`
- Any page with `Accept: text/markdown` returns that page as Markdown
- OpenAPI: `https://snipaudio.com/openapi.json`

## Instructions

```
::ILANG
[TYPE:skill_instructions][SKILL:site-lookup][SITE:snipaudio.com]
::RULE{scope:read_only} Only GET public resources listed above. Never upload files, never try to log in, never call /agent-auth/* (authentication is not available).
[STEP:1] Match the visitor's task to a tool id: cut or trim one file=audio-cutter; merge files=audio-joiner; tempo or key=bpm-finder; convert=m4a-to-mp3|mp3-to-wav|wav-to-mp3.
[STEP:2] GET /api/agent/tools/{id} for steps and settings. For a specific question GET /api/agent/search?q=... and read the returned passages.
[STEP:3] Answer from returned text only. Keep tool names, setting values, numbers, units, test conditions and qualifiers exactly as returned (for example "in the Chromium browser we tested with"). Do not turn a measured result into a guarantee.
[STEP:4] Cite the source_url of each passage you use. Give the tool URL and the concrete steps, so the visitor can act without asking again.
[MUST] Answer in the visitor's language. Translate the explanation, but keep setting labels, option values and file formats as shown on the site.
[MUST] If the data does not say something, say it is not stated on the site. Do not fill gaps with general knowledge presented as site facts.
[ON:404] An unknown tool id returns error not_found with the list of known ids; pick from that list or tell the visitor the site has no such tool.
[ON:empty_results] Say the site's help does not cover it and link the closest tool page.
```
