import assert from 'node:assert/strict';
import test from 'node:test';

import { detectProviders } from '../src/detect.js';

function fakeFs(existingPaths, overrides = {}) {
  const paths = new Set(existingPaths);
  const metadata = new Map(Object.entries(overrides));
  return {
    constants: { R_OK: 4, X_OK: 1 },
    existsSync: (candidate) => paths.has(candidate),
    statSync(candidate) {
      if (!paths.has(candidate)) throw new Error('ENOENT');
      const type = metadata.get(candidate)?.type
        ?? (candidate.endsWith('.claude-code-docs') ? 'directory' : 'file');
      return {
        isDirectory: () => type === 'directory',
        isFile: () => type === 'file',
      };
    },
    accessSync(candidate, mode) {
      if (!paths.has(candidate)) throw new Error('ENOENT');
      const entry = metadata.get(candidate) ?? {};
      if (mode === 4 && entry.readable === false) throw new Error('EACCES');
      if (mode === 1 && entry.executable === false) throw new Error('EACCES');
    },
  };
}

test('detects every available provider', () => {
  const env = {
    HOME: '/home/tester',
    PATH: '/usr/local/bin:/usr/bin',
    BRAVE_API_KEY: 'brave-secret',
    EXA_API_KEY: 'exa-secret',
  };
  const fs = fakeFs([
    '/home/tester/.claude-code-docs',
    '/home/tester/.claude-code-docs/docs_manifest.json',
    '/usr/local/bin/opencode',
  ]);

  assert.deepEqual(detectProviders(env, fs), {
    mirror: { available: true, path: '/home/tester/.claude-code-docs' },
    brave: { available: true },
    exa: { available: true },
    opencode: { available: true, path: '/usr/local/bin/opencode' },
  });
});

test('accepts BRAVE_SEARCH_API_KEY when the primary key is absent', () => {
  const providers = detectProviders(
    {
      HOME: '/home/tester',
      PATH: '',
      BRAVE_SEARCH_API_KEY: 'alternate-secret',
    },
    fakeFs([]),
  );

  assert.deepEqual(providers.brave, { available: true });
});

test('rejects a whitespace-only BRAVE_API_KEY', () => {
  const providers = detectProviders(
    { HOME: '/home/tester', PATH: '', BRAVE_API_KEY: '   ' },
    fakeFs([]),
  );

  assert.deepEqual(providers.brave, {
    available: false,
    reason: 'BRAVE_API_KEY or BRAVE_SEARCH_API_KEY is not set to a non-empty value',
  });
});

test('reports every unavailable provider with a reason', () => {
  const providers = detectProviders(
    { HOME: '/home/tester', PATH: '/usr/bin' },
    fakeFs(['/home/tester/.claude-code-docs']),
  );

  assert.deepEqual(providers, {
    mirror: {
      available: false,
      reason: 'Claude Code documentation mirror manifest was not found',
    },
    brave: {
      available: false,
      reason: 'BRAVE_API_KEY or BRAVE_SEARCH_API_KEY is not set to a non-empty value',
    },
    exa: {
      available: false,
      reason: 'EXA_API_KEY is not set to a non-empty value',
    },
    opencode: {
      available: false,
      reason: 'opencode was not found on PATH',
    },
  });
});

test('requires both the mirror directory and manifest', () => {
  const providers = detectProviders(
    { HOME: '/home/tester' },
    fakeFs(['/home/tester/.claude-code-docs/docs_manifest.json']),
  );

  assert.equal(providers.mirror.available, false);
  assert.match(providers.mirror.reason, /mirror directory/i);
});

test('reports missing HOME and PATH without throwing', () => {
  const providers = detectProviders({}, fakeFs([]));

  assert.deepEqual(providers.mirror, {
    available: false,
    reason: 'HOME is not set to a non-empty value',
  });
  assert.deepEqual(providers.opencode, {
    available: false,
    reason: 'PATH is not set to a non-empty value',
  });
});

test('rejects an opencode directory and a non-executable binary', () => {
  const directory = detectProviders(
    { PATH: '/bin' },
    fakeFs(['/bin/opencode'], { '/bin/opencode': { type: 'directory' } }),
  );
  const nonExecutable = detectProviders(
    { PATH: '/bin' },
    fakeFs(['/bin/opencode'], { '/bin/opencode': { executable: false } }),
  );

  assert.equal(directory.opencode.available, false);
  assert.equal(nonExecutable.opencode.available, false);
});

test('rejects a mirror whose manifest is not a readable regular file', () => {
  const paths = [
    '/home/tester/.claude-code-docs',
    '/home/tester/.claude-code-docs/docs_manifest.json',
  ];
  const wrongType = detectProviders(
    { HOME: '/home/tester' },
    fakeFs(paths, {
      '/home/tester/.claude-code-docs/docs_manifest.json': { type: 'directory' },
    }),
  );
  const unreadable = detectProviders(
    { HOME: '/home/tester' },
    fakeFs(paths, {
      '/home/tester/.claude-code-docs/docs_manifest.json': { readable: false },
    }),
  );

  assert.equal(wrongType.mirror.available, false);
  assert.equal(unreadable.mirror.available, false);
});

test('finds the mirror from USERPROFILE on win32 and normalizes a trailing slash', () => {
  const providers = detectProviders(
    { USERPROFILE: 'C:\\Users\\tester/' },
    fakeFs([
      'C:\\Users\\tester\\.claude-code-docs',
      'C:\\Users\\tester\\.claude-code-docs\\docs_manifest.json',
    ]),
    { platform: 'win32' },
  );

  assert.deepEqual(providers.mirror, {
    available: true,
    path: 'C:\\Users\\tester\\.claude-code-docs',
  });
});

test('falls back to HOMEDRIVE and HOMEPATH for the win32 mirror', () => {
  const providers = detectProviders(
    { HOMEDRIVE: 'D:', HOMEPATH: '\\Profiles\\tester' },
    fakeFs([
      'D:\\Profiles\\tester\\.claude-code-docs',
      'D:\\Profiles\\tester\\.claude-code-docs\\docs_manifest.json',
    ]),
    { platform: 'win32' },
  );

  assert.deepEqual(providers.mirror, {
    available: true,
    path: 'D:\\Profiles\\tester\\.claude-code-docs',
  });
});

test('splits a real win32 PATH and resolves opencode through PATHEXT', () => {
  const providers = detectProviders(
    {
      PATH: 'C:\\tools;C:\\Program Files\\x',
      PATHEXT: '.EXE;.cmd',
    },
    fakeFs(['C:\\Program Files\\x\\opencode.cmd']),
    { platform: 'win32' },
  );

  assert.deepEqual(providers.opencode, {
    available: true,
    path: 'C:\\Program Files\\x\\opencode.cmd',
  });
});

test('uses the standard win32 PATHEXT when PATHEXT is unset', () => {
  const providers = detectProviders(
    { PATH: 'C:\\tools' },
    fakeFs(['C:\\tools\\opencode.CMD']),
    { platform: 'win32' },
  );

  assert.deepEqual(providers.opencode, {
    available: true,
    path: 'C:\\tools\\opencode.CMD',
  });
});

test('does not ask win32 for an executable access mode', () => {
  const fs = fakeFs([
    'C/opencode',
    'C:\\tools\\opencode.CMD',
  ]);
  const accessModes = [];
  const accessSync = fs.accessSync;
  fs.accessSync = (candidate, mode) => {
    accessModes.push(mode);
    accessSync(candidate, mode);
  };

  const providers = detectProviders(
    { PATH: 'C:\\tools', PATHEXT: '.CMD' },
    fs,
    { platform: 'win32' },
  );

  assert.equal(accessModes.includes(fs.constants.X_OK), false);
  assert.equal(providers.opencode.available, true);
});

test('names every home variable consulted when win32 has no home directory', () => {
  const providers = detectProviders({}, fakeFs([]), { platform: 'win32' });

  assert.deepEqual(providers.mirror, {
    available: false,
    reason: 'HOME, USERPROFILE, or HOMEDRIVE and HOMEPATH are not set to non-empty values',
  });
});
