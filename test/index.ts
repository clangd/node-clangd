import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import tape from 'tape';
import * as tmp from 'tmp-promise';

import * as install from '../src/index';

const assetsRoot = path.resolve(__dirname, '../../test/assets');
const oldClangd = path.join(assetsRoot, 'fake-clangd-5/clangd');
const newClangdV15 = path.join(assetsRoot, 'fake-clangd-15/clangd');
const newClangdV16 = path.join(assetsRoot, 'fake-clangd-16/clangd');
const unversionedClangd = path.join(
  assetsRoot,
  'fake-clangd-unversioned/clangd',
);
const appleClangd = path.join(assetsRoot, 'apple-clangd-5/clangd');
const exactLdd = path.join(assetsRoot, 'ldd/exact');
const oldLdd = path.join(assetsRoot, 'ldd/old');
const newLdd = path.join(assetsRoot, 'ldd/new');
const notGlibcLdd = path.join(assetsRoot, 'ldd/not-glibc');
const missingClangd = path.join(assetsRoot, 'missing/clangd');
const releases = 'http://127.0.0.1:9999/release.json';
const incompatibleReleases = 'http://127.0.0.1:9999/release-incompatible.json';
const wrongUrlReleases = 'http://127.0.0.1:9999/release-wrong-url.json';

// A fake editor that records interactions.
class FakeUI {
  constructor(public readonly storagePath: string) {
    console.log('Storage is', this.storagePath);
  }
  readonly events: string[] = [];
  private event(s: string) {
    console.log(s);
    this.events.push(s);
  }

  clangdPath = oldClangd;

  info(s: string) {
    this.event('info');
    console.log(s);
  }
  error(s: string) {
    this.event('error');
    console.error(s);
  }
  showHelp(msg: string, url: string) {
    this.event('showHelp');
    console.info(msg, url);
  }

  promptReload() {
    this.event('promptReload');
  }
  promptUpdate() {
    this.event('promptUpdate');
  }
  promptInstall() {
    this.event('promptInstall');
  }
  public shouldReuseValue = true;
  async shouldReuse() {
    this.event('shouldReuse');
    return this.shouldReuseValue;
  }

  slow<T>(_title: string, work: Promise<T>) {
    this.event('slow');
    return work;
  }
  progress<T>(
    _title: string,
    _cancel: AbortController | null,
    work: (progress: (fraction: number) => void) => Promise<T>,
  ) {
    this.event('progress');
    return work((fraction) => console.log('progress% ', 100 * fraction));
  }
  localize(message: string, ...args: Array<string | number | boolean>): string {
    let ret = message;
    for (const i in args) {
      ret.replace(`{${i}}`, args[i].toString());
    }
    return ret;
  }
}

function test(
  name: string,
  body: (assert: tape.Test, ui: FakeUI) => Promise<void>,
) {
  tape(name, async (assert) =>
    tmp.withDir(
      async (dir) => {
        const ui = new FakeUI(dir.path);
        return new Promise((resolve, _reject) => {
          const server = http
            .createServer(async (req, res) => {
              console.log('Fake github:', req.method, req.url);
              if (!req.url) {
                res.statusCode = 400;
                res.end();
                return;
              }

              req.resume();

              const {pathname} = new URL(req.url, 'http://localhost');
              const filePath = path.resolve(assetsRoot, '.' + pathname);
              if (!filePath.startsWith(assetsRoot + path.sep)) {
                res.statusCode = 400;
                res.end();
                return;
              }

              try {
                const handle = await fs.promises.open(filePath, 'r');
                const stat = await handle.stat();
                res.setHeader('Content-Length', stat.size);
                const stream = fs.createReadStream(filePath, {
                  fd: handle,
                  autoClose: true,
                });
                stream.on('error', (err: Error) => {
                  res.statusCode = 500;
                  res.end(String(err));
                });
                stream.pipe(res);
              } catch (err) {
                res.statusCode = 500;
                res.end(String(err));
              }
            })
            .listen(9999, '::', async () => {
              console.log('Fake github serving...');
              install.fakeGitHubReleaseURL(releases);
              install.fakeLddCommand(exactLdd);
              try {
                await body(assert, ui);
              } catch (e) {
                assert.fail(e as string);
              }
              console.log('Fake github stopping...');
              server.close();
              resolve();
            });
        });
      },
      {unsafeCleanup: true},
    ),
  );
}

// Test the actual installation, typically the clangd.install command.

test('install', async (assert, ui) => {
  await install.installLatest(ui);

  const installedClangd = path.join(
    ui.storagePath,
    'install',
    '10.0',
    'fake-clangd-10',
    'clangd',
  );
  assert.true(
    fs.existsSync(installedClangd),
    `Extracted clangd exists: ${installedClangd}`,
  );
  assert.equal(ui.clangdPath, installedClangd);
  assert.deepEqual(ui.events, [
    /*download*/ 'progress',
    /*extract*/ 'slow',
    'promptReload',
  ]);
});

test('install: no binary for platform', async (assert, ui) => {
  install.fakeGitHubReleaseURL(incompatibleReleases);
  await install.installLatest(ui);

  const installedClangd = path.join(
    ui.storagePath,
    'install',
    '10.0',
    'fake-clangd-10',
    'clangd',
  );
  assert.false(
    fs.existsSync(installedClangd),
    `Extracted clangd exists: ${installedClangd}`,
  );
  assert.true(
    ui.clangdPath.endsWith('fake-clangd-5/clangd'),
    'clangdPath unmodified',
  );
  assert.deepEqual(ui.events, ['showHelp']);
});

test('install: wrong url', async (assert, ui) => {
  install.fakeGitHubReleaseURL(wrongUrlReleases);
  await install.installLatest(ui);

  const installedClangd = path.join(
    ui.storagePath,
    'install',
    '10.0',
    'fake-clangd-10',
    'clangd',
  );
  assert.false(
    fs.existsSync(installedClangd),
    `Extracted clangd exists: ${installedClangd}`,
  );
  assert.true(
    ui.clangdPath.endsWith('fake-clangd-5/clangd'),
    'clangdPath unmodified',
  );
  assert.deepEqual(ui.events, [
    /*download*/ 'progress',
    /*download-fails*/ 'showHelp',
  ]);
});

if (os.platform() == 'linux') {
  test('install: new glibc', async (assert, ui) => {
    install.fakeLddCommand(newLdd);
    await install.installLatest(ui);

    assert.deepEqual(ui.events, ['progress', 'slow', 'promptReload']);
  });

  test('install: old glibc', async (assert, ui) => {
    install.fakeLddCommand(oldLdd);
    await install.installLatest(ui);

    assert.deepEqual(ui.events, ['showHelp'], 'not installed due to old glibc');
  });

  test('install: unknown glibc', async (assert, ui) => {
    install.fakeLddCommand(notGlibcLdd);
    await install.installLatest(ui);

    // Installed. It may not work, but also maybe our detection just failed.
    assert.deepEqual(ui.events, ['progress', 'slow', 'promptReload']);
  });
}

test('install: reuse existing install', async (assert, ui) => {
  const existing = path.join(ui.storagePath, 'install', '10.0', 'weird-dir');
  await fs.promises.mkdir(existing, {recursive: true});
  const existingClangd = path.join(existing, 'clangd');
  await fs.promises.writeFile(existingClangd, '');

  ui.shouldReuseValue = true;
  await install.installLatest(ui);

  const installedClangd = path.join(
    ui.storagePath,
    'install',
    '10.0',
    'fake-clangd-10',
    'clangd',
  );
  assert.false(fs.existsSync(installedClangd), 'Not extracted');
  assert.true(fs.existsSync(existingClangd), 'Not erased');
  assert.equal(existingClangd, ui.clangdPath, 'clangdPath is existing install');
  assert.deepEqual(ui.events, ['shouldReuse', 'promptReload']);
});

test('install: overwrite existing install', async (assert, ui) => {
  const existing = path.join(ui.storagePath, 'install', '10.0', 'weird-dir');
  await fs.promises.mkdir(existing, {recursive: true});
  const existingClangd = path.join(existing, 'clangd');
  await fs.promises.writeFile(existingClangd, '');

  ui.shouldReuseValue = false;
  await install.installLatest(ui);

  const installedClangd = path.join(
    ui.storagePath,
    'install',
    '10.0',
    'fake-clangd-10',
    'clangd',
  );
  assert.true(fs.existsSync(installedClangd), 'Extracted');
  assert.false(fs.existsSync(existingClangd), 'Erased');
  assert.equal(installedClangd, ui.clangdPath, 'clangdPath is new install');
  assert.deepEqual(ui.events, [
    'shouldReuse',
    /*download*/ 'progress',
    /*extract*/ 'slow',
    'promptReload',
  ]);
});

// Test the update check, typically the clangd.update command.
// This doesn't actually install anything (editors must call install()).

test('update: from 5 to 10', async (assert, ui) => {
  ui.clangdPath = oldClangd;
  await install.checkUpdates(true, ui);

  assert.deepEqual(ui.events, ['promptUpdate']);
});

test('update: from 15 to 10', async (assert, ui) => {
  ui.clangdPath = newClangdV15;
  await install.checkUpdates(true, ui);

  assert.deepEqual(ui.events, [/*up-to-date*/ 'info']);
});

test('update: from 16 to 10', async (assert, ui) => {
  ui.clangdPath = newClangdV16;
  await install.checkUpdates(true, ui);

  assert.deepEqual(ui.events, [/*up-to-date*/ 'info']);
});

test('update: from apple to 10', async (assert, ui) => {
  ui.clangdPath = appleClangd;
  await install.checkUpdates(true, ui);

  assert.deepEqual(ui.events, [/*cant-compare*/ 'error']);
});

// Test the generic on-startup flow which:
//   - locates configured clangd if available
//   - suggests installing it if missing, and checks for updates if present
// This handles lots of permutations but never installs anything, either.

test('prepare: no clangd installed', async (assert, ui) => {
  ui.clangdPath = missingClangd;
  const status = await install.prepare(ui, true);
  await status.background;

  assert.equal(status.clangdPath, null);
  assert.deepEqual(ui.events, ['promptInstall']);
});

test('prepare: not installed, unavailable', async (assert, ui) => {
  ui.clangdPath = missingClangd;
  install.fakeGitHubReleaseURL(incompatibleReleases);
  const status = await install.prepare(ui, true);
  await status.background;

  assert.equal(status.clangdPath, null);
  assert.deepEqual(ui.events, ['showHelp']);
});

test('prepare: old clangd installed', async (assert, ui) => {
  ui.clangdPath = oldClangd;
  const status = await install.prepare(ui, true);
  await status.background;

  assert.equal(status.clangdPath, oldClangd);
  assert.deepEqual(ui.events, ['promptUpdate']);
});

test('prepare: updates disabled', async (assert, ui) => {
  ui.clangdPath = oldClangd;
  const status = await install.prepare(ui, false);
  await status.background;

  assert.equal(status.clangdPath, oldClangd);
  assert.deepEqual(ui.events, []);
});

test('prepare: old clangd installed, new unavailable', async (assert, ui) => {
  ui.clangdPath = oldClangd;
  install.fakeGitHubReleaseURL(incompatibleReleases);
  const status = await install.prepare(ui, true);
  await status.background;

  assert.equal(status.clangdPath, oldClangd);
  assert.deepEqual(ui.events, []);
});

test('prepare: new clangd installed', async (assert, ui) => {
  ui.clangdPath = newClangdV15;
  const status = await install.prepare(ui, true);
  await status.background;

  assert.deepEqual(ui.events, []); // unsolicited, so no "up-to-date" message.
});

test('prepare: unversioned clangd installed', async (assert, ui) => {
  ui.clangdPath = unversionedClangd;
  const status = await install.prepare(ui, true);
  await status.background;
  // We assume any custom-installed clangd is desired.
  assert.deepEqual(ui.events, []);
});
