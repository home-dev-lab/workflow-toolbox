import fs from 'node:fs/promises';
import { join } from 'node:path';

export const engineId = 'wt-rules-on-demand@local';
export const enabledSettings = { enabledPlugins: { [engineId]: true }, pluginConfigs: { [engineId]: { options: { enabled: true } } } };
export async function installFixture(profile, stale = false) {
  const installPath = join(profile, 'plugins', 'cache', 'local', 'wt-rules-on-demand', '1.0.0');
  await fs.mkdir(join(installPath, '.claude-plugin'), { recursive: true });
  await fs.writeFile(join(installPath, '.claude-plugin', 'plugin.json'), '{"name":"wt-rules-on-demand"}');
  await fs.writeFile(join(profile, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { [engineId]: [
    ...(stale ? [{ scope: 'user', installPath: join(profile, 'missing') }] : []), { scope: 'user', installPath },
  ] } }));
}
