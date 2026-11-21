import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  __internals,
  copyProfileSnapshot,
  isExpectationMismatch,
  mutateWebProfile,
  mutateWebProfileExpected,
  profileSnapshotIdentity,
  psLstart,
  recoverWebProfile,
  replaceProfileFromSnapshot,
  webProfileIdentity,
  type RepairJournal,
} from './profile-repair.js';

const {
  JOURNAL_NAME,
  JOURNAL_SCHEMA,
  MARKER_NAME,
  bytesFingerprint,
  captureProfileIdentity,
  identityFingerprint,
  phaseRecordPath,
  readDurablePhase,
  removeJournalRecords,
  repairPaths,
  updateJournal,
  withExtension,
  writeNewJournal,
} = __internals;

function scratchHome(name: string): string {
  const root = path.join(os.tmpdir(), `dsh-desktop-profile-repair-${process.pid}-${name}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  return path.join(root, 'home');
}

function seedProfile(home: string): void {
  const profile = path.join(home, 'profiles/web');
  fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(profile, 'custom/nested'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'package.json'), '{"name":"original"}\n');
  fs.writeFileSync(path.join(profile, 'pnpm-lock.yaml'), 'original-lock\n');
  fs.writeFileSync(path.join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n');
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '[]\n');
  fs.writeFileSync(path.join(profile, 'node_modules/original'), 'keep\n');
  fs.writeFileSync(path.join(profile, 'custom/nested/value'), 'preserved\n');
}

function completeShadow(shadowHome: string, name: string): void {
  const profile = path.join(shadowHome, 'profiles/web');
  fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'package.json'), `{"name":"${name}"}\n`);
  for (const [file, content] of [
    ['pnpm-workspace.yaml', 'packages:\n  - .\n'],
    ['cordis.patch.yml', '[]\n'],
  ] as const) {
    if (!fs.existsSync(path.join(profile, file))) {
      fs.writeFileSync(path.join(profile, file), content);
    }
  }
}

function cleanup(home: string): void {
  fs.rmSync(path.dirname(home), { recursive: true, force: true });
}

function staleJournal(overrides: Partial<RepairJournal> & { id: string }): RepairJournal {
  return {
    schema: JOURNAL_SCHEMA,
    ownerPid: 0xffff_ffff,
    ownerLstart: 'stale',
    createdUnixMs: 1,
    phase: 'prepared',
    hadOriginal: false,
    realProfile: '',
    shadowProfile: '',
    backupProfile: '',
    targets: [],
    originalIdentity: null,
    homePatchIdentity: null,
    ...overrides,
  };
}

function failure(body: () => void): string {
  try {
    body();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new assert.AssertionError({ message: 'expected a failure' });
}

test('commits a complete staged profile', () => {
  const home = scratchHome('commit');
  seedProfile(home);
  fs.writeFileSync(path.join(home, 'cordis.patch.yml'), '- id: home-layer\n');
  mutateWebProfile(home, [], (shadowHome, hadOriginal) => {
    assert.ok(hadOriginal);
    const profile = path.join(shadowHome, 'profiles/web');
    assert.ok(!fs.existsSync(path.join(profile, 'node_modules')));
    assert.equal(
      fs.readFileSync(path.join(profile, 'custom/nested/value'), 'utf8'),
      'preserved\n',
    );
    assert.equal(
      fs.readFileSync(path.join(shadowHome, 'cordis.patch.yml'), 'utf8'),
      '- id: home-layer\n',
    );
    completeShadow(shadowHome, 'repaired');
    fs.writeFileSync(path.join(profile, 'node_modules/repaired'), 'ready\n');
  });

  const profile = path.join(home, 'profiles/web');
  assert.match(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'), /repaired/);
  assert.ok(fs.statSync(path.join(profile, 'node_modules/repaired')).isFile());
  assert.ok(!fs.existsSync(path.join(profile, 'node_modules/original')));
  assert.equal(
    fs.readFileSync(path.join(home, 'cordis.patch.yml'), 'utf8'),
    '- id: home-layer\n',
  );
  assert.ok(!fs.existsSync(path.join(home, JOURNAL_NAME)));
  cleanup(home);
});

test('validates all desktop-owned manifest and link targets', () => {
  const home = scratchHome('managed-targets');
  const sourceRoot = `${home}.desktop-owned-sources`;
  const packages = [
    'dsh-desktop-bridge',
    'dsh-compaction-hierarchical',
    'dsh-model-image-input',
  ];
  const sources = packages.map((packageName) => {
    const source = path.join(sourceRoot, packageName);
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'package.json'), `{"name":"${packageName}"}\n`);
    return source;
  });
  const targets = packages.map(
    (packageName, index) => [packageName, sources[index] as string] as const,
  );
  mutateWebProfile(home, targets, (shadowHome) => {
    completeShadow(shadowHome, 'managed-targets');
    const profile = path.join(shadowHome, 'profiles/web');
    fs.writeFileSync(
      path.join(profile, 'package.json'),
      '{"name":"managed-targets","dependencies":{"dsh-desktop-bridge":"link:bridge","dsh-compaction-hierarchical":"link:compaction","dsh-model-image-input":"link:model-image-input"}}\n',
    );
    for (const [index, packageName] of packages.entries()) {
      fs.symlinkSync(
        sources[index] as string,
        path.join(profile, 'node_modules', packageName),
        'dir',
      );
    }
  });

  for (const [index, packageName] of packages.entries()) {
    assert.equal(
      fs.realpathSync.native(path.join(home, 'profiles/web/node_modules', packageName)),
      fs.realpathSync.native(sources[index] as string),
    );
  }
  cleanup(home);
  fs.rmSync(sourceRoot, { recursive: true, force: true });
});

test('failed mutation leaves the real profile untouched', () => {
  const home = scratchHome('rollback');
  seedProfile(home);
  const error = failure(() =>
    mutateWebProfile(home, [], (shadowHome) => {
      completeShadow(shadowHome, 'partial');
      throw new Error('simulated install failure');
    }),
  );

  assert.match(error, /simulated install failure/);
  const profile = path.join(home, 'profiles/web');
  assert.match(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'), /original/);
  assert.ok(fs.statSync(path.join(profile, 'node_modules/original')).isFile());
  assert.ok(!fs.existsSync(path.join(home, JOURNAL_NAME)));
  cleanup(home);
});

test('external manifest change aborts the commit', () => {
  const home = scratchHome('compare-and-swap');
  seedProfile(home);
  const real = path.join(home, 'profiles/web/package.json');
  const error = failure(() =>
    mutateWebProfile(home, [], (shadowHome) => {
      completeShadow(shadowHome, 'candidate');
      fs.writeFileSync(real, '{"name":"terminal-change"}\n');
    }),
  );
  assert.match(error, /changed outside/);
  assert.match(fs.readFileSync(real, 'utf8'), /terminal-change/);
  cleanup(home);
});

test('external home patch change aborts the commit', () => {
  const home = scratchHome('home-patch-compare-and-swap');
  seedProfile(home);
  const patch = path.join(home, 'cordis.patch.yml');
  fs.writeFileSync(patch, '- id: original-home-layer\n');
  const error = failure(() =>
    mutateWebProfile(home, [], (shadowHome) => {
      completeShadow(shadowHome, 'candidate');
      fs.writeFileSync(patch, '- id: terminal-change\n');
    }),
  );
  assert.match(error, /home cordis\.patch\.yml changed outside/);
  assert.match(
    fs.readFileSync(path.join(home, 'profiles/web/package.json'), 'utf8'),
    /original/,
  );
  assert.equal(fs.readFileSync(patch, 'utf8'), '- id: terminal-change\n');
  cleanup(home);
});

test('external node_modules change aborts the commit', () => {
  const home = scratchHome('node-modules-compare-and-swap');
  seedProfile(home);
  const realEntry = path.join(home, 'profiles/web/node_modules/terminal-change');
  const error = failure(() =>
    mutateWebProfile(home, [], (shadowHome) => {
      completeShadow(shadowHome, 'candidate');
      fs.writeFileSync(realEntry, 'new dependency state\n');
    }),
  );
  assert.match(error, /changed outside/);
  assert.ok(fs.statSync(realEntry).isFile());
  cleanup(home);
});

test('initializes a missing profile in the shadow home', () => {
  const home = scratchHome('new');
  mutateWebProfile(home, [], (shadowHome, hadOriginal) => {
    assert.ok(!hadOriginal);
    completeShadow(shadowHome, 'new');
  });
  assert.ok(fs.statSync(path.join(home, 'profiles/web/package.json')).isFile());
  cleanup(home);
});

test('stale journal restores the backup before new work', () => {
  const home = scratchHome('recovery');
  fs.mkdirSync(home, { recursive: true });
  const id = '999-1';
  const paths = repairPaths(home, 'web', id);
  fs.mkdirSync(paths.backup, { recursive: true });
  fs.writeFileSync(path.join(paths.backup, 'package.json'), '{"name":"original"}\n');
  const originalIdentity = identityFingerprint(captureProfileIdentity(paths.backup));
  completeShadow(paths.shadowHome, 'partial');
  writeNewJournal(
    paths.journal,
    staleJournal({
      id,
      phase: 'originalMoved',
      hadOriginal: true,
      realProfile: paths.profile,
      shadowProfile: paths.shadowProfile,
      backupProfile: paths.backup,
      originalIdentity,
    }),
  );

  recoverWebProfile(home);
  assert.match(
    fs.readFileSync(path.join(paths.profile, 'package.json'), 'utf8'),
    /original/,
  );
  assert.ok(!fs.existsSync(paths.backup));
  assert.ok(!fs.existsSync(paths.shadowHome));
  assert.ok(!fs.existsSync(paths.journal));
  cleanup(home);
});

test('rolling-back phase restores original after candidate move', () => {
  const home = scratchHome('rolling-back');
  fs.mkdirSync(home, { recursive: true });
  const id = '999-6';
  const paths = repairPaths(home, 'web', id);
  fs.mkdirSync(paths.backup, { recursive: true });
  fs.writeFileSync(path.join(paths.backup, 'package.json'), '{"name":"original"}\n');
  const originalIdentity = identityFingerprint(captureProfileIdentity(paths.backup));
  completeShadow(paths.shadowHome, 'candidate');
  writeNewJournal(
    paths.journal,
    staleJournal({
      id,
      phase: 'rollingBack',
      hadOriginal: true,
      realProfile: paths.profile,
      shadowProfile: paths.shadowProfile,
      backupProfile: paths.backup,
      originalIdentity,
    }),
  );

  recoverWebProfile(home);
  assert.match(
    fs.readFileSync(path.join(paths.profile, 'package.json'), 'utf8'),
    /original/,
  );
  assert.ok(!fs.existsSync(paths.shadowHome));
  assert.ok(!fs.existsSync(paths.journal));
  cleanup(home);
});

test('promoted marker finishes an interrupted commit', () => {
  const home = scratchHome('promoted');
  fs.mkdirSync(home, { recursive: true });
  const id = '999-2';
  const paths = repairPaths(home, 'web', id);
  completeShadow(paths.shadowHome, 'candidate');
  fs.writeFileSync(path.join(paths.shadowProfile, MARKER_NAME), `${id}\n`);
  fs.mkdirSync(path.dirname(paths.profile), { recursive: true });
  fs.renameSync(paths.shadowProfile, paths.profile);
  fs.mkdirSync(paths.backup, { recursive: true });
  fs.writeFileSync(path.join(paths.backup, 'package.json'), '{"name":"original"}\n');
  const originalIdentity = identityFingerprint(captureProfileIdentity(paths.backup));
  writeNewJournal(
    paths.journal,
    staleJournal({
      id,
      phase: 'originalMoved',
      hadOriginal: true,
      realProfile: paths.profile,
      shadowProfile: paths.shadowProfile,
      backupProfile: paths.backup,
      originalIdentity,
    }),
  );

  recoverWebProfile(home);
  assert.match(
    fs.readFileSync(path.join(paths.profile, 'package.json'), 'utf8'),
    /candidate/,
  );
  assert.ok(!fs.existsSync(path.join(paths.profile, MARKER_NAME)));
  assert.ok(!fs.existsSync(paths.backup));
  assert.ok(!fs.existsSync(paths.journal));
  cleanup(home);
});

test('changed home patch rolls back an interrupted promotion', () => {
  const home = scratchHome('promoted-home-patch-change');
  seedProfile(home);
  const patch = path.join(home, 'cordis.patch.yml');
  const originalPatch = Buffer.from('- id: original-home-layer\n');
  fs.writeFileSync(patch, originalPatch);
  const id = '999-7';
  const paths = repairPaths(home, 'web', id);
  const originalIdentity = identityFingerprint(captureProfileIdentity(paths.profile));
  fs.renameSync(paths.profile, paths.backup);
  completeShadow(paths.shadowHome, 'candidate');
  fs.writeFileSync(path.join(paths.shadowProfile, MARKER_NAME), `${id}\n`);
  fs.renameSync(paths.shadowProfile, paths.profile);
  writeNewJournal(
    paths.journal,
    staleJournal({
      id,
      phase: 'shadowPromoted',
      hadOriginal: true,
      realProfile: paths.profile,
      shadowProfile: paths.shadowProfile,
      backupProfile: paths.backup,
      originalIdentity,
      homePatchIdentity: bytesFingerprint(originalPatch),
    }),
  );
  fs.writeFileSync(patch, '- id: terminal-change\n');

  recoverWebProfile(home);
  assert.match(
    fs.readFileSync(path.join(paths.profile, 'package.json'), 'utf8'),
    /original/,
  );
  assert.equal(fs.readFileSync(patch, 'utf8'), '- id: terminal-change\n');
  assert.ok(!fs.existsSync(paths.backup));
  assert.ok(!fs.existsSync(paths.journal));
  cleanup(home);
});

test('checked mutation rejects a profile changed after backup', () => {
  const home = scratchHome('approved-cas');
  seedProfile(home);
  const expected = webProfileIdentity(home);
  assert.ok(expected !== null);
  fs.writeFileSync(
    path.join(home, 'profiles/web/package.json'),
    '{"name":"terminal-change"}\n',
  );

  let closureRan = false;
  const error = failure(() =>
    mutateWebProfileExpected(home, [], { identity: expected }, () => {
      closureRan = true;
    }),
  );
  assert.ok(isExpectationMismatch(error));
  assert.ok(!closureRan);
  assert.match(
    fs.readFileSync(path.join(home, 'profiles/web/package.json'), 'utf8'),
    /terminal-change/,
  );
  cleanup(home);
});

test('missing expectation rejects a profile created after inspection', () => {
  const home = scratchHome('fresh-home-race');
  seedProfile(home);
  let closureRan = false;
  const error = failure(() =>
    mutateWebProfileExpected(home, [], 'missing', () => {
      closureRan = true;
    }),
  );
  assert.ok(isExpectationMismatch(error));
  assert.ok(!closureRan);
  cleanup(home);
});

test('restores a configuration snapshot through the same transaction', () => {
  const home = scratchHome('snapshot-restore');
  seedProfile(home);
  const snapshot = path.join(path.dirname(home), 'saved/web');
  copyProfileSnapshot(path.join(home, 'profiles/web'), snapshot);
  const expected = profileSnapshotIdentity(snapshot);
  fs.writeFileSync(
    path.join(home, 'profiles/web/package.json'),
    '{"name":"desktop-mutated"}\n',
  );

  mutateWebProfile(home, [], (shadowHome, hadOriginal) => {
    assert.ok(hadOriginal);
    const profile = path.join(shadowHome, 'profiles/web');
    replaceProfileFromSnapshot(snapshot, profile);
    fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true });
  });

  assert.equal(profileSnapshotIdentity(path.join(home, 'profiles/web')), expected);
  assert.ok(fs.statSync(path.join(home, 'profiles/web/node_modules')).isDirectory());
  cleanup(home);
});

test('marker without journal fails loud', () => {
  const home = scratchHome('orphan-marker');
  seedProfile(home);
  const marker = path.join(home, 'profiles/web', MARKER_NAME);
  fs.writeFileSync(marker, '999-4\n');
  assert.match(failure(() => recoverWebProfile(home)), /without a journal/);
  assert.ok(fs.statSync(marker).isFile());
  cleanup(home);
});

test('phase and marker conflict preserves every path', () => {
  const home = scratchHome('phase-conflict');
  fs.mkdirSync(home, { recursive: true });
  const id = '999-5';
  const paths = repairPaths(home, 'web', id);
  completeShadow(paths.shadowHome, 'candidate');
  fs.writeFileSync(path.join(paths.shadowProfile, MARKER_NAME), `${id}\n`);
  fs.mkdirSync(path.dirname(paths.profile), { recursive: true });
  fs.renameSync(paths.shadowProfile, paths.profile);
  writeNewJournal(
    paths.journal,
    staleJournal({
      id,
      phase: 'prepared',
      realProfile: paths.profile,
      shadowProfile: paths.shadowProfile,
      backupProfile: paths.backup,
    }),
  );

  assert.match(failure(() => recoverWebProfile(home)), /ambiguous/);
  assert.ok(fs.statSync(paths.profile).isDirectory());
  assert.ok(fs.statSync(paths.journal).isFile());
  cleanup(home);
});

test('phase updates keep the primary journal parseable', () => {
  const home = scratchHome('append-only-phase');
  fs.mkdirSync(home, { recursive: true });
  const id = '999-6';
  const paths = repairPaths(home, 'web', id);
  const journal = staleJournal({
    id,
    phase: 'prepared',
    realProfile: paths.profile,
    shadowProfile: paths.shadowProfile,
    backupProfile: paths.backup,
  });
  writeNewJournal(paths.journal, journal);
  const primary = fs.readFileSync(paths.journal);

  journal.phase = 'originalMoved';
  updateJournal(paths.journal, journal);
  const unpublished = withExtension(
    phaseRecordPath(paths.journal, id, 'shadowPromoted'),
    `phase.${process.pid}.tmp`,
  );
  fs.writeFileSync(unpublished, 'partial phase record');

  assert.deepEqual(fs.readFileSync(paths.journal), primary);
  const parsed = JSON.parse(fs.readFileSync(paths.journal, 'utf8')) as RepairJournal;
  assert.equal(readDurablePhase(paths.journal, parsed), 'originalMoved');
  removeJournalRecords(paths.journal);
  cleanup(home);
});

test('live journal blocks a second mutation', () => {
  const home = scratchHome('live-owner');
  fs.mkdirSync(home, { recursive: true });
  const pid = process.pid;
  const id = '999-3';
  const paths = repairPaths(home, 'web', id);
  const ownerLstart = psLstart(pid);
  assert.ok(ownerLstart !== null, 'test process has a start token');
  writeNewJournal(
    paths.journal,
    staleJournal({
      id,
      ownerPid: pid,
      ownerLstart,
      realProfile: paths.profile,
      shadowProfile: paths.shadowProfile,
      backupProfile: paths.backup,
    }),
  );
  assert.match(failure(() => recoverWebProfile(home)), /already owned/);
  fs.unlinkSync(paths.journal);
  cleanup(home);
});
