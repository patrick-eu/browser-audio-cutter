// Build agent-readable data from the live HTML source (cutter-site), so machines and visitors read the same content.
// Output: src/generated/site.json (pages as Markdown, tool records, help entries) used by the Worker,
// and the inline WebMCP tool data in cutter-site/index.html (between webmcp markers).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';

const ORIGIN = 'https://snipaudio.com';
const here = new URL('.', import.meta.url).pathname;
const SITE = new URL('../../web/', import.meta.url).pathname;
const OUT = new URL('../src/generated/', import.meta.url).pathname;
const PORT = 8795;
fs.mkdirSync(OUT, { recursive: true });

// canonical pages come from the sitemap (the site's own list of indexable pages)
const sitemap = fs.readFileSync(SITE + 'sitemap.xml', 'utf8');
const pages = [...sitemap.matchAll(/<url>\s*<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/g)].map(m => ({ url: m[1], path: new URL(m[1]).pathname, lastmod: m[2] }));
const TOOL_IDS = { '/': 'audio-cutter', '/audio-joiner/': 'audio-joiner', '/bpm-finder/': 'bpm-finder', '/m4a-to-mp3/': 'm4a-to-mp3', '/mp3-to-wav/': 'mp3-to-wav', '/wav-to-mp3/': 'wav-to-mp3' };

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: SITE, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 800));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const out = { origin: ORIGIN, generated_at: new Date().toISOString(), source: 'Generated from the HTML pages listed in /sitemap.xml', pages: [], tools: [], help: [] };

try {
  for (const pg of pages) {
    await page.goto(`http://127.0.0.1:${PORT}${pg.path}`, { waitUntil: 'load' });
    await page.waitForTimeout(300);
    const r = await page.evaluate(({ ORIGIN, url }) => {
      const abs = href => { try { const u = new URL(href, url); return u.origin === location.origin ? ORIGIN + u.pathname + u.hash : u.href; } catch { return href; } };
      const clean = s => s.replace(/\s+/g, ' ').trim();
      const visible = el => !(el.hidden || el.closest('[hidden]') || getComputedStyle(el).display === 'none');
      const inline = el => {
        let s = '';
        for (const n of el.childNodes) {
          if (n.nodeType === 3) s += n.textContent;
          else if (n.nodeType === 1 && visible(n) && !['SCRIPT', 'STYLE', 'SVG', 'BUTTON', 'INPUT', 'SELECT', 'CANVAS'].includes(n.tagName.toUpperCase())) {
            if (n.tagName === 'A') { const t = clean(inline(n)); s += t ? `[${t}](${abs(n.getAttribute('href'))})` : ''; }
            else if (n.tagName === 'BR') s += ' ';
            else s += inline(n);
          }
        }
        return s;
      };
      const lines = [];
      const push = s => { if (s) lines.push(s); };
      const field = f => {
        const label = clean(f.querySelector('label')?.childNodes[0]?.textContent || f.querySelector('label')?.textContent || '');
        const sel = f.querySelector('select'), rng = f.querySelector('input[type=range]'), num = f.querySelector('input[type=number]'), chk = f.querySelector('input[type=checkbox]');
        if (sel) return { label, options: [...sel.options].map(o => clean(o.textContent)), default: clean(sel.selectedOptions[0]?.textContent || '') };
        if (rng) return { label, range: `${rng.min} to ${rng.max}, step ${rng.step}`, default: rng.value };
        if (num) return { label, range: [num.min && `min ${num.min}`, num.max && `max ${num.max}`, num.step && `step ${num.step}`].filter(Boolean).join(', '), default: num.value };
        if (chk) return { label: clean(f.textContent), options: ['on', 'off'], default: chk.checked ? 'on' : 'off' };
        return { label };
      };
      const settings = [];
      const walk = el => {
        for (const n of el.children) {
          if (!visible(n)) continue;
          const tag = n.tagName;
          if (['SCRIPT', 'STYLE', 'CANVAS', 'svg', 'BUTTON', 'TEMPLATE'].includes(tag)) continue;
          if (n.matches('nav.tools')) { push('Tools on this site: ' + [...n.querySelectorAll('a.tool')].map(a => `[${clean(a.querySelector('b').textContent)}](${abs(a.getAttribute('href'))})`).join(' · ')); continue; }
          if (/^H[1-6]$/.test(tag)) { push('#'.repeat(+tag[1]) + ' ' + clean(inline(n))); continue; }
          if (tag === 'P' || tag === 'SMALL') { push(clean(inline(n))); continue; }
          if (tag === 'OL' || tag === 'UL') { [...n.children].filter(visible).forEach((li, i) => push(`${tag === 'OL' ? i + 1 + '.' : '-'} ${clean(inline(li))}`)); continue; }
          if (n.id === 'drop') { push(`File input: ${clean(n.querySelector('strong')?.textContent || '')}. ${clean(n.querySelector('.hint')?.textContent || '')}`); continue; }
          if (n.classList.contains('field')) { const f = field(n); settings.push(f); push(`- Setting: ${f.label}${f.options ? ` — options shown with default settings: ${f.options.join(', ')}` : ''}${f.range ? ` — ${f.range}` : ''}${f.default ? ` (default: ${f.default})` : ''}`); continue; }
          if (tag === 'ASIDE') { push(clean(inline(n)).replace(/ ↗/g, '')); continue; }
          if (tag === 'FOOTER') { push('---'); push(clean(inline(n))); continue; }
          if (tag === 'LABEL' && !n.querySelector('input,select')) { push(clean(inline(n))); continue; }
          walk(n);
        }
      };
      const main = document.querySelector('main');
      walk(main);
      // sections: h2 blocks with their h3 subsections and paragraphs, for help entries
      const sections = [];
      let h2 = null, h3 = null;
      for (const n of main.querySelectorAll('h2, h3, section > p, section > ol, section > ul')) {
        if (n.closest('.card') || !visible(n)) continue;
        if (n.tagName === 'H2') { h2 = { heading: clean(n.textContent), text: [], sub: [] }; h3 = null; sections.push(h2); }
        else if (n.tagName === 'H3' && h2) { const link = n.querySelector('a'); h3 = { heading: clean(n.textContent), text: link ? [`Page: ${abs(link.getAttribute('href'))}`] : [] }; h2.sub.push(h3); }
        else if (h2) (h3 || h2).text.push(n.tagName === 'P' ? clean(inline(n)) : [...n.children].map((li, i) => `${n.tagName === 'OL' ? i + 1 + '.' : '-'} ${clean(inline(li))}`).join('\n'));
      }
      const navTile = [...document.querySelectorAll('nav.tools a.tool')].find(a => a.hasAttribute('aria-current'));
      return {
        title: document.title, description: document.querySelector('meta[name=description]')?.content || '',
        h1: clean(document.querySelector('h1')?.textContent || ''), markdown: lines.join('\n\n') + '\n',
        name: navTile ? clean(navTile.querySelector('b').textContent) : null, summary: navTile ? clean(navTile.querySelector('small').textContent) : null,
        settings, sections,
      };
    }, { ORIGIN, url: `http://127.0.0.1:${PORT}${pg.path}` });

    const header = `<!-- Markdown version of ${pg.url} (${r.title}). Generated from the page's HTML; last modified ${pg.lastmod}. -->\n\n`;
    out.pages.push({ path: pg.path, url: pg.url, lastmod: pg.lastmod, title: r.title, description: r.description, h1: r.h1, markdown: header + r.markdown });
    const toolId = TOOL_IDS[pg.path];
    const pageId = toolId || pg.path.replace(/\//g, '') || 'home';
    if (toolId) {
      const how = r.sections.find(s => /^How to/i.test(s.heading));
      out.tools.push({ id: toolId, name: r.name, summary: r.summary, url: pg.url, title: r.title, description: r.description,
        runs_in: 'visitor browser (files are not uploaded)', how_to: how ? how.text.join('\n').split('\n').map(s => s.replace(/^\d+\.\s*/, '')) : [],
        settings: r.settings, lastmod: pg.lastmod, markdown_url: pg.url });
    }
    for (const s of r.sections) {
      const slug = t => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
      if (s.text.length) out.help.push({ id: `${pageId}:${slug(s.heading)}`, page: pageId, heading: s.heading, text: s.text.join('\n'), source_url: pg.url });
      for (const h of s.sub) out.help.push({ id: `${pageId}:${slug(h.heading)}`, page: pageId, section: s.heading, heading: h.heading, text: h.text.join('\n'), source_url: pg.url });
    }
  }
} finally {
  await browser.close();
  server.kill();
}

// duplicate ids would break lookups: fail the build instead
const ids = out.help.map(h => h.id), dup = ids.filter((x, i) => ids.indexOf(x) !== i);
if (dup.length) throw new Error('duplicate help ids: ' + dup.join(', '));
if (out.tools.length !== 6 || out.pages.length !== pages.length) throw new Error(`unexpected counts: tools ${out.tools.length}, pages ${out.pages.length}`);

// Skill artifact: served bytes and digest are computed here, once
const skill = fs.readFileSync(here + 'SKILL.template.md', 'utf8').replace('{{TOOL_LIST}}', out.tools.map(t => `- \`${t.id}\` — ${t.name}: ${t.summary} (${t.url})`).join('\n'));
out.skill = { markdown: skill, digest: 'sha256:' + crypto.createHash('sha256').update(Buffer.from(skill, 'utf8')).digest('hex') };
fs.writeFileSync(OUT + 'site.json', JSON.stringify(out, null, 1));

// inline WebMCP data on the homepage (no extra download for visitors)
const idx = SITE + 'index.html', html = fs.readFileSync(idx, 'utf8');
const data = out.tools.map(t => ({ id: t.id, name: t.name, summary: t.summary, url: t.url, how_to: t.how_to }));
const block = `<!-- webmcp:start -->\n<script>\n${fs.readFileSync(here + 'webmcp.template.js', 'utf8').replace('/*TOOLS*/[]', JSON.stringify(data))}</script>\n<!-- webmcp:end -->`;
const next = html.includes('<!-- webmcp:start -->') ? html.replace(/<!-- webmcp:start -->[\s\S]*?<!-- webmcp:end -->/, block) : html.replace('</body>', block + '\n</body>');
if (next !== html) fs.writeFileSync(idx, next);
console.log(`pages ${out.pages.length}, tools ${out.tools.length}, help entries ${out.help.length}, skill ${out.skill.digest}, homepage ${next !== html ? 'updated' : 'unchanged'}`);
