import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getPackageDir, type ExtensionContext, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { applyLiveTheme, readExportColors } from './theme.ts';

// Pi does not expose an HTML-export hook or export this helper from its public API.
// Keep internal exporter/theme integration here so template/API changes are easy to adapt.
export async function nativeExport(pi: ExtensionAPI, ctx: ExtensionContext, outputPath: string): Promise<void> {
  const moduleUrl = pathToFileURL(join(getPackageDir(), 'dist/core/export-html/index.js')).href;
  const { exportSessionToHtml } = await import(moduleUrl);
  const themeUrl = pathToFileURL(join(getPackageDir(), 'dist/modes/interactive/theme/theme.js')).href;
  const { getThemeExportColors } = await import(themeUrl);
  const exportColors = await readExportColors(ctx.ui.theme, getThemeExportColors(ctx.ui.theme.name));
  await exportSessionToHtml(ctx.sessionManager, {
    systemPrompt: ctx.getSystemPrompt(),
    tools: pi.getAllTools(),
  }, { outputPath });
  await writeFile(outputPath, applyLiveTheme(await readFile(outputPath, 'utf8'), ctx.ui.theme, exportColors));
}
