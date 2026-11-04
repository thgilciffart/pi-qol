import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUILTIN_MODULES, EXTERNAL_COLORS, defaultConfig, loadConfig, resolveItems, saveConfig, validateConfig,
} from '../../src/status-line/config.ts';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pi-qol-status-line-'));
}

describe('status line settings', () => {
  test('defaults list every built-in module and are valid', () => {
    const config = defaultConfig();
    expect(config.items.map(item => item.id)).toEqual([...BUILTIN_MODULES]);
    expect(validateConfig(config)).toEqual(config);
    expect(config.enabled).toBe(true);
    expect(config.colorMode).toBe('colorful');
  });

  test('rejects malformed values with clear messages', () => {
    const cases: [unknown, RegExp][] = [
      [[], /JSON object/],
      [{ version: 2 }, /unsupported version/],
      [{ enabled: 'yes' }, /"enabled" must be true or false/],
      [{ enabled: null }, /"enabled" must be true or false/],
      [{ colorMode: null }, /colorful, theme, mono/],
      [{ showNewExtensionStatuses: null }, /must be true or false/],
      [{ items: null }, /"items" must be an array/],
      [{ colorMode: 'rainbow' }, /colorful, theme, mono/],
      [{ items: {} }, /"items" must be an array/],
      [{ items: [{ id: 'bogus' }] }, /not a built-in module/],
      [{ items: [{ id: 'extension:' }] }, /not a built-in module/],
      [{ items: [{ id: 'separator:0' }] }, /not a built-in module/],
      [{ items: [{ id: 'separator:abc' }] }, /not a built-in module/],
      [{ items: [{ id: 'separator:1' }, { id: 'separator:1' }] }, /more than once/],
      [{ items: [{ id: 'model' }, { id: 'model' }] }, /more than once/],
      [{ items: [{ id: 'model', row: 0 }] }, /positive safe integer/],
      [{ items: [{ id: 'model', row: -1 }] }, /positive safe integer/],
      [{ items: [{ id: 'model', row: 1.5 }] }, /positive safe integer/],
      [{ items: [{ id: 'model', row: Number.MAX_SAFE_INTEGER + 1 }] }, /positive safe integer/],
      [{ items: [{ id: 'model', side: 'center' }] }, /side must be "left" or "right"/],
      [{ items: [{ id: 'model', side: null }] }, /side must be "left" or "right"/],
      [{ items: [{ id: 'model', enabled: 1 }] }, /enabled must be true or false/],
      [{ items: [{ id: 'model', color: 'red' }] }, /only supported for external modules/],
      [{ items: [{ id: 'separator:1', color: 'red' }] }, /only supported for external modules/],
      [{ items: [{ id: 'extension:test', color: null }] }, /color must be one of/],
      [{ items: [{ id: 'extension:test', color: 'neon' }] }, /color must be one of/],
      [{ items: [{ id: 'extension:test', color: 'toString' }] }, /color must be one of/],
    ];
    for (const [value, message] of cases) expect(() => validateConfig(value)).toThrow(message);
  });

  test('counts restored built-ins toward the module limit', () => {
    const items = Array.from({ length: 200 }, (_, index) => ({ id: `extension:plugin-${index}` }));
    expect(() => validateConfig({ items })).toThrow(/including built-in modules/);
    const config = validateConfig({ items: items.slice(0, 190) });
    expect(validateConfig(config)).toEqual(config);
  });

  test('saves external colour choices and retains them when a status disappears or returns', async () => {
    const dir = await tempDir();
    try {
      const config = defaultConfig();
      for (const color of Object.keys(EXTERNAL_COLORS) as (keyof typeof EXTERNAL_COLORS)[]) {
        config.items.push({ id: `extension:${color}`, row: 3, side: 'right', enabled: false, color });
      }
      const path = join(dir, 'status-line.json');
      await saveConfig(path, config);
      const loaded = await loadConfig(path);
      expect(loaded).toEqual({ status: 'ok', config });
      expect(resolveItems(loaded.config, [])).toEqual(config.items);
      expect(resolveItems(loaded.config, ['red', 'new']).slice(0, config.items.length)).toEqual(config.items);
      expect(resolveItems(loaded.config, ['new']).at(-1)?.color).toBeUndefined();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('keeps extension ids distinct from built-ins and appends missing built-ins', () => {
    const config = validateConfig({ items: [{ id: 'extension:model', enabled: false, row: 1 }, { id: 'cwd', row: 2 }] });
    expect(config.items[0]).toEqual({ id: 'extension:model', enabled: false, row: 1 });
    expect(config.items[1]).toEqual({ id: 'cwd', enabled: true, row: 2 });
    expect(config.items.filter(item => item.id === 'model')).toHaveLength(1);
    expect(config.items).toHaveLength(BUILTIN_MODULES.length + 1);
  });

  test('missing files use defaults; malformed files are reported and left untouched', async () => {
    const dir = await tempDir();
    try {
      const path = join(dir, 'status-line.json');
      expect(await loadConfig(path)).toEqual({ status: 'missing', config: defaultConfig() });
      await writeFile(path, '{ not json');
      const broken = await loadConfig(path);
      expect(broken.status).toBe('invalid');
      expect(broken.status === 'invalid' && broken.error).toMatch(/invalid JSON/);
      expect(await readFile(path, 'utf8')).toBe('{ not json');
      await writeFile(path, JSON.stringify({ colorMode: 'neon' }));
      const invalid = await loadConfig(path);
      expect(invalid.status === 'invalid' && invalid.error).toMatch(/colorMode/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('saves atomically into a new directory and can back up an invalid file first', async () => {
    const dir = await tempDir();
    try {
      const path = join(dir, 'nested', 'status-line.json');
      const config = { ...defaultConfig(), colorMode: 'mono' as const };
      expect(await saveConfig(path, config)).toBeUndefined();
      expect(await loadConfig(path)).toEqual({ status: 'ok', config });
      await writeFile(path, 'broken');
      const backup = await saveConfig(path, defaultConfig(), { backupExisting: true });
      expect(backup).toBeDefined();
      expect(await readFile(backup!, 'utf8')).toBe('broken');
      expect((await loadConfig(path)).status).toBe('ok');
      expect((await readdir(join(dir, 'nested'))).filter(name => name.endsWith('.tmp'))).toEqual([]);
      await expect(saveConfig(path, { ...defaultConfig(), colorMode: 'x' as never })).rejects.toThrow(/colorMode/);
      expect((await loadConfig(path)).status).toBe('ok');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('discovers new extension keys, keeps hidden and absent keys in order', () => {
    const config = defaultConfig();
    config.items.unshift({ id: 'extension:gone', enabled: true, row: 1 });
    config.items.push({ id: 'extension:hidden', enabled: false, row: 2 });
    const items = resolveItems(config, ['zeta', 'hidden', 'alpha']);
    expect(items[0]!.id).toBe('extension:gone');
    expect(items.slice(-3)).toEqual([
      { id: 'extension:hidden', enabled: false, row: 2 },
      { id: 'extension:alpha', enabled: true, row: 2 },
      { id: 'extension:zeta', enabled: true, row: 2 },
    ]);
    expect(resolveItems({ ...config, showNewExtensionStatuses: false }, ['new']).at(-1))
      .toEqual({ id: 'extension:new', enabled: false, row: 2 });
    expect(config.items.some(item => item.id === 'extension:alpha')).toBe(false);
  });

  test('preserves side and order through saving while older settings remain valid', async () => {
    const dir = await tempDir();
    try {
      const old = validateConfig({ items: [{ id: 'model', row: 1 }] });
      expect(old.items[0].side ?? 'left').toBe('left');
      const config = validateConfig({ items: [
        { id: 'extension:missing', row: 2, side: 'right', enabled: false },
        { id: 'thinking', row: 1, side: 'right' },
        { id: 'model', row: 1, side: 'right' },
        { id: 'cwd', row: 1, side: 'left' },
      ] });
      const path = join(dir, 'status-line.json');
      await saveConfig(path, config);
      expect(await loadConfig(path)).toEqual({ status: 'ok', config });
      expect(resolveItems(config, ['new']).slice(0, 4)).toEqual(config.items.slice(0, 4));
      expect(resolveItems(config, ['new']).at(-1)?.side ?? 'left').toBe('left');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('optional separator items round-trip without being added to default or older settings', async () => {
    const dir = await tempDir();
    try {
      const config = defaultConfig();
      expect(config.items.some(item => item.id.startsWith('separator:'))).toBe(false);
      expect(validateConfig(config)).toEqual(config);
      config.items.splice(1, 0, { id: 'separator:1', enabled: true, row: 1 });
      config.items.push({ id: 'separator:2', enabled: false, row: 2, side: 'right' });
      const path = join(dir, 'status-line.json');
      await saveConfig(path, config);
      expect(await loadConfig(path)).toEqual({ status: 'ok', config });
      expect(resolveItems(config, ['plugin']).filter(item => item.id.startsWith('separator:'))).toHaveLength(2);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('saves arbitrary positive row numbers without creating empty rows', async () => {
    const dir = await tempDir();
    try {
      const config = defaultConfig();
      config.items.forEach((item, index) => { item.row = index + 3; });
      config.items.push({ id: 'separator:1', row: 1000, side: 'right', enabled: true });
      const path = join(dir, 'status-line.json');
      await saveConfig(path, config);
      expect(await loadConfig(path)).toEqual({ status: 'ok', config });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
