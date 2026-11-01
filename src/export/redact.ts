import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { SessionData } from './session.ts';

export interface Finding { category: string; location: string; count: number; preview: string }
export interface RedactionOptions { home?: string; cwd?: string; literals?: string[] }

export function redactSession(data: SessionData, options: RedactionOptions = {}): { data: SessionData; findings: Finding[] } {
  const findings: Finding[] = [];
  const literals = [...new Set([...(options.literals ?? []).filter(Boolean), ...[options.cwd, options.home].filter((value): value is string => !!value && value.length > 2)])].sort((a, b) => b.length - a.length);
  function redact(text: string, location: string, key: string): string {
    const counts = new Map<string, number>();
    const record = (category: string) => counts.set(category, (counts.get(category) ?? 0) + 1);
    let result = text;
    const replace = (pattern: RegExp, category: string) => {
      result = result.replace(pattern, () => { record(category); return `[REDACTED ${category.toUpperCase()}]`; });
    };
    if (/^(api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|token|secret|authorization|client[_-]?secret)$/i.test(key) && result) {
      record('credential');
      result = '[REDACTED CREDENTIAL]';
    } else {
      for (const literal of literals) {
        if (!result.includes(literal)) continue;
        const parts = result.split(literal);
        counts.set('custom text or local path', (counts.get('custom text or local path') ?? 0) + parts.length - 1);
        result = parts.join('[REDACTED TEXT]');
      }
      replace(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g, 'private key');
      replace(/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g, 'token');
      replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'authorization');
      replace(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|client[_-]?secret|secret|token)\b["']?\s*[=:]\s*(?:"[^"\n]+"|'[^'\n]+'|[^\s,;<>]+)/gi, 'credential');
      replace(/\bhttps?:\/\/[^\s/@]+:[^\s/@]+@/gi, 'URL credentials');
      replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, 'email');
      replace(/(?:\/(?:home|Users)\/[^\s/"'<>]+|\/root\b|[A-Z]:\\Users\\[^\s\\"'<>]+)/gi, 'home path');
    }
    const start = Math.max(0, result.indexOf('[REDACTED') - 80);
    const preview = (start ? '…' : '') + result.slice(start, start + 240) + (result.length > start + 240 ? '…' : '');
    for (const [category, count] of counts) findings.push({ category, location, count, preview });
    return result;
  }
  const structuralKeys = new Set(['id', 'parentId', 'leafId', 'targetId', 'toolCallId', 'type', 'role', 'mimeType']);
  function walk(value: unknown, location: string, key = ''): unknown {
    if (typeof value === 'string') return structuralKeys.has(key) ? value : redact(value, location, key);
    if (Array.isArray(value)) return value.map((item, index) => walk(item, `${location}[${index}]`));
    if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      return Object.fromEntries(Object.entries(object).map(([name, item]) => [name,
        name === 'data' && object.type === 'image' ? item : walk(item, `${location}.${name}`, name)]));
    }
    return value;
  }
  return { data: walk(data, 'session') as SessionData, findings };
}

export async function reviewRedactions(ctx: ExtensionCommandContext, findings: Finding[]): Promise<boolean> {
  if (!ctx.hasUI) throw new Error('Redaction preview requires an interactive Pi UI.');
  const count = findings.reduce((total, finding) => total + finding.count, 0);
  const save = `Save export with ${count} redaction${count === 1 ? '' : 's'}`;
  const items = findings.map((finding, index) => `${index + 1}. ${finding.category} (${finding.count}) — ${finding.location}`);
  while (true) {
    const choice = await ctx.ui.select(`Redaction preview: ${count} replacements. Heuristic detection; images are not scanned. Select a finding to inspect.`, [save, ...items, 'Cancel export']);
    if (choice === save) return true;
    const index = items.indexOf(choice ?? '');
    if (index < 0) return false;
    const finding = findings[index];
    await ctx.ui.confirm(`${finding.category}: proposed export text`, `${finding.location}\n\n${finding.preview}\n\nDetection is heuristic. Review the saved HTML before sharing; images are not scanned.`);
  }
}
