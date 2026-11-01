export interface ExportEntry {
  id: string;
  parentId?: string | null;
  type: string;
  timestamp?: string;
  message?: {
    role: string;
    content: string | { type: string; [key: string]: unknown }[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}
export interface SessionData {
  header?: Record<string, unknown>;
  entries: ExportEntry[];
  leafId?: string | null;
  [key: string]: unknown;
}
const dataPattern = /(<script\s+id="session-data"\s+type="application\/json">)([A-Za-z0-9+/=\s]+)(<\/script>)/;

export function readSessionData(html: string): SessionData {
  const match = dataPattern.exec(html);
  if (!match) throw new Error('Unsupported Pi session data. Update pi-better-export.');
  const data = JSON.parse(Buffer.from(match[2], 'base64').toString('utf8'));
  if (!Array.isArray(data.entries)) throw new Error('Invalid Pi session data.');
  return data;
}
export function writeSessionData(html: string, data: SessionData): string {
  if (!dataPattern.test(html)) throw new Error('Unsupported Pi session data.');
  const encoded = Buffer.from(JSON.stringify(data)).toString('base64');
  return html.replace(dataPattern, (_match, start: string, _data: string, end: string) => start + encoded + end);
}

export function conversationOnly(data: SessionData): SessionData {
  const byId = new Map(data.entries.map(entry => [entry.id, entry]));
  const branch: ExportEntry[] = [];
  const visited = new Set<string>();
  let current = data.leafId ? byId.get(data.leafId) : undefined;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    branch.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  let parentId: string | null = null;
  const entries: ExportEntry[] = [];
  for (const entry of branch) {
    const message = entry.message;
    if (entry.type !== 'message' || !message || !['user', 'assistant'].includes(message.role)) continue;
    const content = typeof message.content === 'string' ? message.content : message.content
      .filter(block => block.type === 'text' || block.type === 'image')
      .map(block => block.type === 'text' ? { type: 'text', text: block.text } : { type: 'image', data: block.data, mimeType: block.mimeType });
    if (!content.length) continue;
    const cleanMessage: NonNullable<ExportEntry['message']> = { role: message.role, content };
    for (const key of ['timestamp', 'model', 'provider', 'api', 'usage', 'stopReason']) {
      if (message[key] !== undefined) cleanMessage[key] = message[key];
    }
    entries.push({ type: 'message', id: entry.id, parentId, timestamp: entry.timestamp, message: cleanMessage });
    parentId = entry.id;
  }
  if (!entries.length) throw new Error('No user or assistant conversation to export on the active branch.');
  const header = Object.fromEntries(['type', 'version', 'id', 'timestamp'].filter(key => data.header?.[key] !== undefined).map(key => [key, data.header![key]]));
  return { header, entries, leafId: parentId };
}
