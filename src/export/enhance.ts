import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
let assets: Promise<string> | undefined;

async function loadAssets(): Promise<string> {
  const dist = dirname(require.resolve('katex'));
  const [js, css, math, license, viewer, printCss] = await Promise.all([
    readFile(join(dist, 'katex.min.js'), 'utf8'),
    readFile(join(dist, 'katex.min.css'), 'utf8'),
    readFile(new URL('./math.js', import.meta.url), 'utf8'),
    readFile(join(dist, '..', 'LICENSE'), 'utf8'),
    readFile(new URL('./viewer.js', import.meta.url), 'utf8'),
    readFile(new URL('./print.css', import.meta.url), 'utf8'),
  ]);
  // Keep WOFF2 only, and embed fonts so exports work offline as a single file.
  let fontCss = css.replace(/src:([^;]+);/g, (rule, sources: string) => {
    const woff2 = sources.split(',').find((source) => source.includes('.woff2'));
    return woff2 ? `src:${woff2};` : rule;
  });
  for (const match of [...fontCss.matchAll(/url\((fonts\/[^)]+)\)/g)]) {
    const data = await readFile(join(dist, match[1]));
    fontCss = fontCss.replace(match[0], `url(data:font/woff2;base64,${data.toString('base64')})`);
  }
  // Escape script terminators so bundled source cannot end an HTML script element.
  const script = `/*! KaTeX license:\n${license}\n*/\n${js}\n${math}\n${viewer}`.replace(/<\/script/gi, '<\\/script');
  return `<style id="pi-better-export">${fontCss}\n${printCss}\n.katex-display{overflow-x:auto;overflow-y:hidden;padding:.25em 0}.katex{font-size:1.1em}.better-export-math[data-display]{display:block;cursor:pointer}.better-export-math:focus-visible{outline:2px solid currentColor;outline-offset:4px}.better-export-copy-status{position:fixed;bottom:1rem;right:1rem;z-index:1000;background:#222;color:#fff;border-radius:6px;padding:.6rem 1rem;font:14px sans-serif}.better-export-copy-status:empty{display:none}</style>\n<script>${script}</script>\n`;
}

export async function enhanceHtml(html: string): Promise<string> {
  if (html.includes('id="pi-better-export"')) return html;
  // Install the Markdown extension after Pi's bundled libraries but before its viewer.
  // Fail explicitly if Pi changes this integration point; never silently lose math.
  const anchor = html.indexOf('marked.use(');
  const scriptStart = html.lastIndexOf('<script', anchor);
  if (anchor < 0 || scriptStart < 0 || html.indexOf('</script>', scriptStart) < anchor) {
    throw new Error('Unsupported Pi HTML template: cannot locate Markdown initialization. Update pi-better-export.');
  }
  assets ??= loadAssets().catch((error) => { assets = undefined; throw error; });
  const bundle = await assets;
  return html.slice(0, scriptStart) + bundle + html.slice(scriptStart);
}
