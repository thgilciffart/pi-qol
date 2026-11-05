import { SettingsManager } from '@earendil-works/pi-coding-agent';

type Settings = ReturnType<SettingsManager['getGlobalSettings']>;

/** Native picker setters write to this memory store until the user saves. */
export function createPluginDraft(settings: SettingsManager) {
  const initial = { global: settings.getGlobalSettings(), project: settings.getProjectSettings() };
  const stored = { global: JSON.stringify(initial.global), project: JSON.stringify(initial.project) };
  const draft = SettingsManager.fromStorage({
    withLock(scope, update) {
      const next = update(stored[scope]);
      if (next !== undefined) stored[scope] = next;
    },
  }, { projectTrusted: settings.isProjectTrusted() });

  const current = () => ({ global: draft.getGlobalSettings(), project: draft.getProjectSettings() });
  return {
    settings: draft,
    changed: () => JSON.stringify(current()) !== JSON.stringify(initial),
    async save(cwd: string, agentDir: string): Promise<void> {
      await draft.flush();
      // Re-read before saving so unrelated settings edited elsewhere survive.
      const target = SettingsManager.create(cwd, agentDir, { projectTrusted: draft.isProjectTrusted() });
      const loadErrors = target.drainErrors();
      if (loadErrors.length) throw new Error(loadErrors.map(({ error }) => error.message).join('\n'));
      const values = current();
      for (const scope of ['global', 'project'] as const) {
        const next: Settings = values[scope];
        if (JSON.stringify(next.extensions) !== JSON.stringify(initial[scope].extensions)) {
          if (scope === 'global') target.setExtensionPaths(next.extensions ?? []);
          else target.setProjectExtensionPaths(next.extensions ?? []);
        }
        if (JSON.stringify(next.packages) !== JSON.stringify(initial[scope].packages)) {
          if (scope === 'global') target.setPackages(next.packages ?? []);
          else target.setProjectPackages(next.packages ?? []);
        }
      }
      await target.flush();
      const errors = target.drainErrors();
      if (errors.length) throw new Error(errors.map(({ error }) => error.message).join('\n'));
    },
  };
}
