import { join, resolve } from 'node:path';

// Default rollback inputs: both the directory under a config root and the
// filenames discovered within it. Judge output guards consume these same rules.
export const rollbackInputLocations = [
  { segments: ['plugins', 'store'], namePattern: /^wt-rules-on-demand[_-].*\.json$/ },
  { segments: ['plugins', 'data', 'wt-rules-on-demand', 'quality'], namePattern: /^compliance-verdicts-archive-\d+-\d+\.jsonl$/ }
];

export const rollbackStoreDirectory = (configDir) => join(configDir, ...rollbackInputLocations[0].segments);
export const rollbackArchiveDirectory = (configDir) => resolve(configDir, ...rollbackInputLocations[1].segments);
