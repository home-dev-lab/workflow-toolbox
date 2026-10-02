import { join, resolve } from 'node:path';

// Default rollback inputs: both the directory under a config root and the
// filenames discovered within it. Judge output guards consume these same rules.
export const rollbackInputLocations = [
  { segments: ['plugins', 'store'], namePattern: /^wt-rules-on-demand[_-].*\.json$/ },
  { segments: ['plugins', 'data', 'wt-rules-on-demand', 'quality'], namePattern: /^compliance-verdicts-archive-\d+-\d+\.jsonl$/ },
  // Store keys moved out of an over-budget store (sessions, served, health), read back by every reader.
  { segments: ['plugins', 'data', 'wt-rules-on-demand', 'quality'], namePattern: /^rod-store-archive-\d+-\d+\.json$/ }
];

export const rollbackStoreDirectory = (configDir) => join(configDir, ...rollbackInputLocations[0].segments);
export const rollbackArchiveDirectory = (configDir) => resolve(configDir, ...rollbackInputLocations[1].segments);
