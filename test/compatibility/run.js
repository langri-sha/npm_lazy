#!/usr/bin/env node
'use strict';

// npm_lazy registry-client compatibility harness.
//
//   node test/compatibility/run.js
//
// Installs npm_lazy into a throwaway sandbox, starts it against the public
// registry, and drives real npm clients through it. Nothing outside the work
// directory is modified and nothing is published.
//
// Environment:
//   COMPAT_NPM_LAZY_VERSION  npm_lazy version under test        (1.14.0)
//   COMPAT_REGISTRY          upstream registry                  (https://registry.npmjs.org/)
//   COMPAT_WORK_DIR          sandbox location                   (test/compatibility/.work)
//   COMPAT_CLIENT_IMAGES     docker images used as npm clients
//   COMPAT_SKIP_DOCKER=1     skip every docker-backed scenario
//   COMPAT_NODE_IMAGES       docker images for the Node floor matrix
//   COMPAT_NODE_MATRIX=1     also run the Node floor matrix (slow); same as --node-matrix

const fs = require('fs');
const os = require('os');
const path = require('path');

const LazyServer = require('./lib/server');
const stubs = require('./lib/stubs');
const util = require('./lib/util');
const { Report, STATUS } = require('./lib/report');

const CONFIG = {
  npmLazyVersion: process.env.COMPAT_NPM_LAZY_VERSION || '1.14.0',
  registry: process.env.COMPAT_REGISTRY || 'https://registry.npmjs.org/',
  workDir: process.env.COMPAT_WORK_DIR || path.join(__dirname, '.work'),
  skipDocker: process.env.COMPAT_SKIP_DOCKER === '1',
  clientImages: (process.env.COMPAT_CLIENT_IMAGES || 'node:20-alpine,node:22-alpine,node:24-alpine')
    .split(',')
    .map((image) => image.trim())
    .filter(Boolean),
  nodeMatrix: process.argv.includes('--node-matrix') || process.env.COMPAT_NODE_MATRIX === '1',
  nodeMatrixImages: (
    process.env.COMPAT_NODE_IMAGES ||
    'node:8-alpine,node:10-alpine,node:12-alpine,node:18-alpine,node:20-alpine,node:22-alpine,node:24-alpine'
  )
    .split(',')
    .map((image) => image.trim())
    .filter(Boolean),
};

// Small, stable, dependency-light fixtures. `once` pulls `wrappy`, so the
// install exercises transitive resolution as well as direct dependencies.
const FIXTURES = {
  unscoped: { name: 'process', version: '0.11.10', tarballPath: '/process/-/process-0.11.10.tgz' },
  scoped: {
    name: '@sindresorhus/is',
    encoded: '@sindresorhus%2fis',
    version: '8.1.0',
    tarballPath: '/@sindresorhus/is/-/is-8.1.0.tgz',
  },
  transitive: { name: 'once', version: '1.4.0' },
  large: { name: 'express' },
};

const DEPENDENCIES = {
  [FIXTURES.unscoped.name]: FIXTURES.unscoped.version,
  [FIXTURES.scoped.name]: FIXTURES.scoped.version,
  [FIXTURES.transitive.name]: FIXTURES.transitive.version,
};

const report = new Report();

function rimraf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function freshDir(...parts) {
  const target = path.join(CONFIG.workDir, ...parts);
  rimraf(target);
  fs.mkdirSync(target, { recursive: true });
  return target;
}

function writeFixture(dir) {
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'compat-fixture', version: '1.0.0', private: true, dependencies: DEPENDENCIES }, null, 2)
  );
  return dir;
}

function npmEnv(registryUrl, cacheDir) {
  return Object.assign({}, process.env, {
    npm_config_registry: registryUrl,
    npm_config_cache: cacheDir,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_loglevel: 'http',
    // Ignore whatever the operator has in ~/.npmrc so runs are reproducible.
    npm_config_userconfig: path.join(CONFIG.workDir, 'no-such-npmrc'),
    npm_config_globalconfig: path.join(CONFIG.workDir, 'no-such-global-npmrc'),
  });
}

function installedPackages(fixtureDir) {
  return Object.keys(DEPENDENCIES)
    .concat(['wrappy'])
    .filter((name) => fs.existsSync(path.join(fixtureDir, 'node_modules', name, 'package.json')));
}

async function hostNpmInstall(label, registryUrl) {
  const fixtureDir = writeFixture(freshDir('fixtures', label));
  const cacheDir = freshDir('npm-cache', label);
  const result = await util.run('npm', ['install'], {
    cwd: fixtureDir,
    env: npmEnv(registryUrl, cacheDir),
    timeout: 300000,
  });

  return Object.assign(result, { fixtureDir: fixtureDir, installed: installedPackages(fixtureDir) });
}

function tarballFetches(fetches) {
  return fetches.filter((url) => url.endsWith('.tgz'));
}

function fail(detail, evidence) {
  return { status: STATUS.FAIL, detail: detail, evidence: evidence };
}

function pass(detail, evidence) {
  return { status: STATUS.PASS, detail: detail, evidence: evidence };
}

// --- setup -----------------------------------------------------------------

async function ensureSandbox() {
  const sandbox = path.join(CONFIG.workDir, 'sandbox');
  const manifest = path.join(sandbox, 'node_modules', 'npm_lazy', 'package.json');

  if (fs.existsSync(manifest)) {
    const installed = JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
    if (installed === CONFIG.npmLazyVersion) {
      return { sandbox: sandbox, reused: true, version: installed };
    }
  }

  rimraf(sandbox);
  fs.mkdirSync(sandbox, { recursive: true });
  fs.writeFileSync(
    path.join(sandbox, 'package.json'),
    JSON.stringify({ name: 'npm-lazy-sandbox', version: '1.0.0', private: true }, null, 2)
  );

  const result = await util.run('npm', ['install', 'npm_lazy@' + CONFIG.npmLazyVersion], {
    cwd: sandbox,
    env: npmEnv(CONFIG.registry, path.join(CONFIG.workDir, 'sandbox-npm-cache')),
    timeout: 600000,
  });

  if (result.code !== 0 || !fs.existsSync(manifest)) {
    throw new Error('sandbox install failed (exit ' + result.code + ')\n' + result.stderr.slice(-2000));
  }

  return {
    sandbox: sandbox,
    reused: false,
    version: JSON.parse(fs.readFileSync(manifest, 'utf8')).version,
    deprecations: (result.stderr.match(/npm warn deprecated [^\n]+/g) || []).length,
  };
}

// --- group A: live registry over TLS ---------------------------------------

async function groupLiveRegistry(sandbox) {
  const group = 'live-registry';
  const port = await util.freePort();
  const cacheDir = freshDir('cache', 'live');
  const server = new LazyServer({
    sandbox: sandbox,
    cacheDir: cacheDir,
    port: port,
    remoteUrl: CONFIG.registry,
    logPath: path.join(CONFIG.workDir, 'live-registry.log'),
  });

  await server.start();

  try {
    await report.scenario('C02', 'Unscoped package metadata, cold cache', async () => {
      const res = await util.httpGetJson(server.url + '/' + FIXTURES.unscoped.name);
      if (res.status !== 200 || !res.json || !res.json.versions) {
        return fail('HTTP ' + res.status + ', ' + res.bytes + ' bytes');
      }
      if (!res.json.versions[FIXTURES.unscoped.version]) {
        return fail('version ' + FIXTURES.unscoped.version + ' missing from packument');
      }
      return pass(res.bytes + ' bytes, ' + Object.keys(res.json.versions).length + ' versions');
    }, { group });

    await report.scenario('C03', 'Scoped package metadata, cold cache', async () => {
      const res = await util.httpGetJson(server.url + '/' + FIXTURES.scoped.encoded);
      if (res.status !== 200 || !res.json || !res.json.versions) {
        return fail('HTTP ' + res.status + ', ' + res.bytes + ' bytes');
      }
      if (res.json.name !== FIXTURES.scoped.name) {
        return fail('unexpected package name ' + res.json.name);
      }
      return pass(res.bytes + ' bytes, ' + Object.keys(res.json.versions).length + ' versions');
    }, { group });

    await report.scenario('C04', 'external-url rewriting in served metadata', async () => {
      const targets = [
        { url: server.url + '/' + FIXTURES.unscoped.name, expected: server.url + FIXTURES.unscoped.tarballPath, version: FIXTURES.unscoped.version },
        { url: server.url + '/' + FIXTURES.scoped.encoded, expected: server.url + FIXTURES.scoped.tarballPath, version: FIXTURES.scoped.version },
      ];
      const observed = [];

      for (const target of targets) {
        const res = await util.httpGetJson(target.url);
        if (res.status !== 200 || !res.json) {
          return fail('HTTP ' + res.status + ' for ' + target.url);
        }

        const tarballs = Object.keys(res.json.versions).map((v) => res.json.versions[v].dist.tarball);
        const leaked = tarballs.filter((t) => !t.startsWith(server.url + '/'));
        if (leaked.length) {
          return fail(leaked.length + ' tarball URLs still point upstream, e.g. ' + leaked[0]);
        }

        const actual = res.json.versions[target.version].dist.tarball;
        if (actual !== target.expected) {
          return fail('expected ' + target.expected + ', got ' + actual);
        }
        observed.push(actual);
      }

      return pass('all tarball URLs rewritten', { rewritten: observed });
    }, { group });

    await report.scenario('C05', 'Unscoped tarball through the proxy, cold cache', async () => {
      const meta = await util.httpGetJson(server.url + '/' + FIXTURES.unscoped.name);
      const expected = meta.json.versions[FIXTURES.unscoped.version].dist.shasum;
      const res = await util.httpGet(server.url + FIXTURES.unscoped.tarballPath);

      if (res.status !== 200) {
        return fail('HTTP ' + res.status);
      }
      if (res.body[0] !== 0x1f || res.body[1] !== 0x8b) {
        return fail('response is not a gzip stream');
      }
      const actual = util.sha1(res.body);
      if (actual !== expected) {
        return fail('sha1 mismatch: expected ' + expected + ', got ' + actual);
      }
      return pass(res.bytes + ' bytes, sha1 ' + actual + ' matches registry shasum');
    }, { group });

    await report.scenario('C06', 'Scoped tarball through the proxy, cold cache', async () => {
      const meta = await util.httpGetJson(server.url + '/' + FIXTURES.scoped.encoded);
      const expected = meta.json.versions[FIXTURES.scoped.version].dist.shasum;
      const res = await util.httpGet(server.url + FIXTURES.scoped.tarballPath);

      if (res.status !== 200) {
        return fail('HTTP ' + res.status);
      }
      const actual = util.sha1(res.body);
      if (actual !== expected) {
        return fail('sha1 mismatch: expected ' + expected + ', got ' + actual);
      }
      return pass(res.bytes + ' bytes, sha1 ' + actual + ' matches registry shasum');
    }, { group });

    await report.scenario('C07', 'Upstream TLS to ' + CONFIG.registry, async () => {
      const fetches = server.upstreamFetches(0);
      const https = fetches.filter((url) => url.startsWith('https://'));
      if (!https.length) {
        return fail('no https upstream fetches observed');
      }
      if (https.length !== fetches.length) {
        return fail('some upstream fetches were not https: ' + fetches.filter((u) => !u.startsWith('https://')).join(', '));
      }
      return pass(https.length + ' verified https fetches (rejectUnauthorized=true)');
    }, { group });

    let coldCursor = server.mark();
    await report.scenario('C08', 'npm install, cold proxy cache and cold client cache', async () => {
      const cold = freshDir('cache', 'live-cold-marker');
      rimraf(cold);
      const result = await hostNpmInstall('cold', server.url);
      const fetches = server.upstreamFetches(coldCursor);

      if (result.code !== 0) {
        return fail('npm exited ' + result.code + ': ' + result.stderr.slice(-400));
      }
      if (result.installed.length !== 4) {
        return fail('installed ' + result.installed.join(', ') + ' (expected 4 packages)');
      }
      return pass(
        'installed ' + result.installed.join(', ') + '; ' + tarballFetches(fetches).length + ' tarballs pulled upstream'
      );
    }, { group });

    const warmCursor = server.mark();
    await report.scenario('C09', 'npm install, warm proxy cache and cold client cache', async () => {
      const result = await hostNpmInstall('warm', server.url);
      const fetches = server.upstreamFetches(warmCursor);
      const tarballs = tarballFetches(fetches);

      if (result.code !== 0) {
        return fail('npm exited ' + result.code + ': ' + result.stderr.slice(-400));
      }
      if (result.installed.length !== 4) {
        return fail('installed ' + result.installed.join(', '));
      }
      if (tarballs.length !== 0) {
        return fail('refetched ' + tarballs.length + ' tarballs upstream: ' + tarballs.join(', '));
      }
      return pass(
        'no tarball refetched; ' + fetches.length + ' metadata revalidations (cacheAge=0 always revalidates metadata)'
      );
    }, { group });

    await report.scenario('C10', 'npm view for unscoped and scoped packages', async () => {
      const env = npmEnv(server.url, freshDir('npm-cache', 'view'));
      const unscoped = await util.run('npm', ['view', FIXTURES.unscoped.name + '@' + FIXTURES.unscoped.version, 'version'], { env: env, timeout: 120000 });
      const scoped = await util.run('npm', ['view', FIXTURES.scoped.name + '@' + FIXTURES.scoped.version, 'version'], { env: env, timeout: 120000 });

      if (unscoped.code !== 0 || unscoped.stdout.trim() !== FIXTURES.unscoped.version) {
        return fail('npm view ' + FIXTURES.unscoped.name + ' → exit ' + unscoped.code + ' "' + unscoped.stdout.trim() + '"');
      }
      if (scoped.code !== 0 || scoped.stdout.trim() !== FIXTURES.scoped.version) {
        return fail('npm view ' + FIXTURES.scoped.name + ' → exit ' + scoped.code + ' "' + scoped.stdout.trim() + '"');
      }
      return pass('both resolved to the expected version');
    }, { group });

    await report.scenario('C11', 'Abbreviated (corgi) metadata requests', async () => {
      const accept = { accept: 'application/vnd.npm.install-v1+json' };
      const viaProxy = await util.httpGet(server.url + '/' + FIXTURES.large.name, { headers: accept });
      const direct = await util.httpGet(CONFIG.registry + FIXTURES.large.name, { headers: accept });

      if (viaProxy.status !== 200) {
        return fail('HTTP ' + viaProxy.status);
      }

      const ratio = (viaProxy.bytes / direct.bytes).toFixed(2);
      return pass(
        'served, but always as a full packument: ' + viaProxy.bytes + ' bytes vs ' + direct.bytes +
        ' bytes direct (' + ratio + 'x) for ' + FIXTURES.large.name,
        { proxyBytes: viaProxy.bytes, registryBytes: direct.bytes, ratio: Number(ratio) }
      );
    }, { group });

    await report.scenario('C12', 'Registry endpoints proxied uncached (/-/ping, /-/v1/search)', async () => {
      const ping = await util.httpGet(server.url + '/-/ping');
      const search = await util.httpGet(server.url + '/-/v1/search?text=' + FIXTURES.unscoped.name + '&size=1');
      if (ping.status !== 200 || search.status !== 200) {
        return fail('ping HTTP ' + ping.status + ', search HTTP ' + search.status);
      }
      return pass('ping and search pass through to upstream');
    }, { group });

    await report.scenario('C13', 'Unencoded scoped metadata path (/@scope/name)', async () => {
      const res = await util.httpGet(server.url + '/' + FIXTURES.scoped.name);
      if (res.status === 200) {
        return pass('served (HTTP 200)');
      }
      return {
        status: STATUS.XFAIL,
        detail:
          'HTTP ' + res.status + ' — routed as /package/version, so upstream is asked for "' +
          FIXTURES.scoped.name.split('/')[0] + '". The npm CLI uses the %2f-encoded form, so this is not fatal.',
        evidence: { status: res.status, body: res.body.toString('utf8').slice(0, 200) },
      };
    }, { group });

    // Restart with the same cache directory: the point is that a restarted
    // server keeps serving from disk without going back upstream for tarballs.
    await server.stop();
    await server.start();
    const restartCursor = server.mark();

    await report.scenario('C14', 'Cache persistence across a server restart', async () => {
      const result = await hostNpmInstall('restart', server.url);
      const tarballs = tarballFetches(server.upstreamFetches(restartCursor));

      if (result.code !== 0) {
        return fail('npm exited ' + result.code + ': ' + result.stderr.slice(-400));
      }
      if (tarballs.length !== 0) {
        return fail('refetched ' + tarballs.length + ' tarballs after restart: ' + tarballs.join(', '));
      }
      return pass('restarted server served all ' + result.installed.length + ' packages from the persisted cache');
    }, { group });

    await runClientMatrix(server, group);
  } finally {
    await server.stop();
  }
}

// --- docker client matrix --------------------------------------------------

async function dockerAvailable() {
  if (CONFIG.skipDocker) {
    return false;
  }
  const result = await util.run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 60000 });
  return result.code === 0;
}

async function runClientMatrix(server, group) {
  if (!(await dockerAvailable())) {
    report.skip('C15', 'npm client matrix in docker', CONFIG.skipDocker ? 'COMPAT_SKIP_DOCKER=1' : 'docker unavailable', group);
    return;
  }

  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const gid = typeof process.getgid === 'function' ? process.getgid() : 0;
  let index = 0;

  for (const image of CONFIG.clientImages) {
    index += 1;
    const id = 'C15.' + index;
    const label = 'docker-' + image.replace(/[^a-z0-9]+/gi, '-');

    await report.scenario(id, 'npm client ' + image + ' installs through the proxy', async () => {
      const versionResult = await util.run(
        'docker',
        ['run', '--rm', image, 'sh', '-c', 'node --version && npm --version'],
        { timeout: 600000 }
      );
      if (versionResult.code !== 0) {
        return fail('could not start ' + image + ': ' + versionResult.stderr.slice(-300));
      }
      const versions = versionResult.stdout.trim().split('\n');
      const nodeVersion = (versions[0] || '').trim();
      const npmVersion = (versions[1] || '').trim();
      const fixtureDir = writeFixture(freshDir('fixtures', label));

      const install = await util.run(
        'docker',
        [
          'run', '--rm', '--network=host',
          '--user', uid + ':' + gid,
          '-e', 'HOME=/tmp',
          '-e', 'npm_config_cache=/tmp/npm-cache',
          '-e', 'npm_config_registry=' + server.url,
          '-e', 'npm_config_audit=false',
          '-e', 'npm_config_fund=false',
          '-e', 'npm_config_update_notifier=false',
          '-v', fixtureDir + ':/fixture',
          '-w', '/fixture',
          image,
          'npm', 'install',
        ],
        { timeout: 600000 }
      );

      const installed = installedPackages(fixtureDir);
      const client = 'node ' + nodeVersion + ' / npm ' + npmVersion;
      if (install.code !== 0) {
        return fail(client + ' exited ' + install.code + ': ' + install.stderr.slice(-400));
      }
      if (installed.length !== 4) {
        return fail(client + ' installed ' + installed.join(', '));
      }
      return pass(client + ' installed ' + installed.join(', '), {
        image: image,
        node: nodeVersion,
        npm: npmVersion,
      });
    }, { group });
  }
}

// --- group B: upstream outage against a warm cache -------------------------

async function groupOutage(sandbox) {
  const group = 'upstream-outage';
  const stub = await stubs.startUpstreamStub(CONFIG.registry);
  const port = await util.freePort();
  const server = new LazyServer({
    sandbox: sandbox,
    cacheDir: freshDir('cache', 'outage'),
    port: port,
    remoteUrl: stub.url,
    httpTimeout: 5000,
    maxRetries: 2,
    logPath: path.join(CONFIG.workDir, 'upstream-outage.log'),
  });

  await server.start();

  try {
    await report.scenario('C16', 'Warm the cache through a local upstream stub', async () => {
      const result = await hostNpmInstall('outage-warm', server.url);
      if (result.code !== 0) {
        return fail('npm exited ' + result.code + ': ' + result.stderr.slice(-400));
      }
      return pass('cached ' + result.installed.length + ' packages via ' + stub.url);
    }, { group });

    stub.setMode('outage');

    await report.scenario('C17', 'Metadata served from cache while upstream is down', async () => {
      const unscoped = await util.httpGetJson(server.url + '/' + FIXTURES.unscoped.name, { timeout: 120000 });
      const scoped = await util.httpGetJson(server.url + '/' + FIXTURES.scoped.encoded, { timeout: 120000 });

      if (unscoped.status !== 200 || !unscoped.json || !unscoped.json.versions) {
        return fail('unscoped metadata HTTP ' + unscoped.status);
      }
      if (scoped.status !== 200 || !scoped.json || !scoped.json.versions) {
        return fail('scoped metadata HTTP ' + scoped.status);
      }
      return pass('both packuments served from disk after upstream retries were exhausted');
    }, { group });

    await report.scenario('C18', 'Tarballs served from cache while upstream is down', async () => {
      const unscoped = await util.httpGet(server.url + FIXTURES.unscoped.tarballPath, { timeout: 120000 });
      const scoped = await util.httpGet(server.url + FIXTURES.scoped.tarballPath, { timeout: 120000 });

      if (unscoped.status !== 200 || scoped.status !== 200) {
        return fail('unscoped HTTP ' + unscoped.status + ', scoped HTTP ' + scoped.status);
      }
      return pass('served ' + unscoped.bytes + ' and ' + scoped.bytes + ' bytes from disk');
    }, { group });

    await report.scenario('C19', 'npm install with a cold client cache while upstream is down', async () => {
      const result = await hostNpmInstall('outage-install', server.url);
      if (result.code !== 0) {
        return fail('npm exited ' + result.code + ': ' + result.stderr.slice(-500));
      }
      if (result.installed.length !== 4) {
        return fail('installed ' + result.installed.join(', '));
      }
      return pass('installed ' + result.installed.join(', ') + ' with upstream unreachable');
    }, { group });
  } finally {
    await server.stop();
    await stub.close();
  }
}

// --- group C: upstream certificate verification ----------------------------

async function groupTls(sandbox) {
  const group = 'upstream-tls';
  const registry = await stubs.startSelfSignedRegistry(CONFIG.workDir);

  if (!registry) {
    report.skip('C20', 'Self-signed upstream is rejected by default', 'openssl unavailable', group);
    report.skip('C21', 'rejectUnauthorized=false accepts a self-signed upstream', 'openssl unavailable', group);
    return;
  }

  const strictPort = await util.freePort();
  const strict = new LazyServer({
    sandbox: sandbox,
    cacheDir: freshDir('cache', 'tls-strict'),
    port: strictPort,
    remoteUrl: registry.url,
    httpTimeout: 5000,
    maxRetries: 1,
    rejectUnauthorized: true,
    logPath: path.join(CONFIG.workDir, 'tls-strict.log'),
  });

  const laxPort = await util.freePort();
  const lax = new LazyServer({
    sandbox: sandbox,
    cacheDir: freshDir('cache', 'tls-lax'),
    port: laxPort,
    remoteUrl: registry.url,
    httpTimeout: 5000,
    maxRetries: 1,
    rejectUnauthorized: false,
    logPath: path.join(CONFIG.workDir, 'tls-lax.log'),
  });

  try {
    await strict.start();
    await report.scenario('C20', 'Self-signed upstream is rejected by default', async () => {
      const res = await util.httpGet(strict.url + '/tlsprobe', { timeout: 60000 });
      if (res.status === 200) {
        return fail('npm_lazy accepted a self-signed upstream certificate');
      }
      const rejected = /self.signed|SELF_SIGNED|unable to verify/i.test(strict.log);
      return pass('HTTP ' + res.status + (rejected ? '; upstream certificate rejected' : ''));
    }, { group });

    await lax.start();
    await report.scenario('C21', 'rejectUnauthorized=false accepts a self-signed upstream', async () => {
      const res = await util.httpGetJson(lax.url + '/tlsprobe', { timeout: 60000 });
      if (res.status !== 200 || !res.json) {
        return fail('HTTP ' + res.status);
      }
      const tarball = res.json.versions['1.0.0'].dist.tarball;
      if (!tarball.startsWith(lax.url + '/')) {
        return fail('tarball URL not rewritten: ' + tarball);
      }
      return pass('served and rewritten to ' + tarball);
    }, { group });
  } finally {
    await strict.stop();
    await lax.stop();
    await registry.close();
  }
}

// --- group D: known defects ------------------------------------------------

async function groupKnownDefects(sandbox) {
  const group = 'known-defects';
  const port = await util.freePort();
  const cacheDir = freshDir('cache', 'corrupt');
  const server = new LazyServer({
    sandbox: sandbox,
    cacheDir: cacheDir,
    port: port,
    remoteUrl: CONFIG.registry,
    logPath: path.join(CONFIG.workDir, 'known-defects.log'),
  });

  await server.start();

  try {
    await report.scenario('C22', 'Recovery from a corrupted cached tarball', async () => {
      const first = await util.httpGet(server.url + FIXTURES.unscoped.tarballPath);
      if (first.status !== 200) {
        return fail('could not prime the cache: HTTP ' + first.status);
      }

      const meta = JSON.parse(fs.readFileSync(path.join(cacheDir, 'meta.json'), 'utf8'));
      const key = CONFIG.registry.replace(/\/$/, '') + FIXTURES.unscoped.tarballPath;
      const entry = meta[key] && meta[key].taskResults && meta[key].taskResults.GET;
      if (!entry) {
        return fail('no cache entry for ' + key);
      }

      fs.writeFileSync(entry.path, 'corrupted-on-purpose');

      let status = null;
      let requestError = null;
      try {
        const res = await util.httpGet(server.url + FIXTURES.unscoped.tarballPath, { timeout: 60000 });
        status = res.status;
      } catch (err) {
        requestError = err.message;
      }

      await util.sleep(500);

      if (server.alive && status === 200) {
        return pass('corrupt entry detected and refetched');
      }

      const crash = /ERR_INVALID_ARG_TYPE[\s\S]*?at Cache\.junk[^\n]*/.exec(server.log);
      return {
        status: STATUS.XFAIL,
        detail:
          'server process exited (' + JSON.stringify(server.exit) + ') instead of refetching; ' +
          'Cache.junk() calls fs.unlink() without a callback, which throws on Node >= 10',
        evidence: {
          request: requestError || ('HTTP ' + status),
          exit: server.exit,
          stack: crash ? crash[0] : server.log.slice(-1200),
        },
      };
    }, { group });
  } finally {
    await server.stop();
  }
}

// --- optional: Node floor matrix -------------------------------------------

async function groupNodeMatrix() {
  const group = 'node-matrix';

  if (!(await dockerAvailable())) {
    report.skip('C23', 'Node version matrix', CONFIG.skipDocker ? 'COMPAT_SKIP_DOCKER=1' : 'docker unavailable', group);
    return;
  }

  let index = 0;
  for (const image of CONFIG.nodeMatrixImages) {
    index += 1;

    await report.scenario('C23.' + index, 'npm_lazy on ' + image, async () => {
      const result = await util.run(
        'docker',
        [
          'run', '--rm',
          '-e', 'COMPAT_NPM_LAZY_VERSION=' + CONFIG.npmLazyVersion,
          '-e', 'COMPAT_REGISTRY=' + CONFIG.registry,
          '-v', path.join(__dirname, 'node-smoke.js') + ':/node-smoke.js:ro',
          image,
          'node', '/node-smoke.js',
        ],
        { timeout: 600000 }
      );

      const match = /COMPAT_SMOKE_RESULT (\{[\s\S]*?\})\s*$/m.exec(result.stdout);
      if (!match) {
        return fail('no smoke result from ' + image + ': ' + (result.stderr || result.stdout).slice(-300), {
          stdout: result.stdout.slice(-2000),
          stderr: result.stderr.slice(-2000),
        });
      }

      const smoke = JSON.parse(match[1]);
      const core = ['install', 'metadataUnscoped', 'metadataScoped', 'externalUrl', 'tarball'];
      const broken = core.filter((step) => !smoke[step]);

      if (broken.length) {
        return fail(smoke.node + ': ' + broken.join(', ') + ' failed', smoke);
      }
      return pass(
        smoke.node + ': serving works; corrupt-cache recovery ' +
          (smoke.corruptRecovery ? 'works' : 'crashes the server'),
        smoke
      );
    }, { group });
  }
}

// --- main ------------------------------------------------------------------

async function main() {
  fs.mkdirSync(CONFIG.workDir, { recursive: true });

  report.setMeta('harnessNode', process.version);
  report.setMeta('platform', os.platform() + ' ' + os.arch() + ' ' + os.release());
  report.setMeta('registry', CONFIG.registry);
  report.setMeta('npmLazyVersion', CONFIG.npmLazyVersion);

  const npmVersion = await util.run('npm', ['--version'], { timeout: 60000 });
  report.setMeta('hostNpm', npmVersion.stdout.trim());

  process.stdout.write(
    'npm_lazy compatibility harness\n' +
    '  npm_lazy      ' + CONFIG.npmLazyVersion + '\n' +
    '  harness node  ' + process.version + '\n' +
    '  host npm      ' + npmVersion.stdout.trim() + '\n' +
    '  registry      ' + CONFIG.registry + '\n' +
    '  work dir      ' + CONFIG.workDir + '\n\n'
  );

  let sandbox = null;
  await report.scenario('C01', 'Install npm_lazy@' + CONFIG.npmLazyVersion + ' on Node ' + process.version, async () => {
    const result = await ensureSandbox();
    sandbox = result.sandbox;
    return pass(
      result.reused
        ? 'reused sandbox at ' + result.sandbox
        : 'installed ' + result.version + ' (' + result.deprecations + ' deprecation warnings)'
    );
  }, { group: 'setup' });

  if (!sandbox) {
    report.printSummary();
    process.exitCode = 1;
    return;
  }

  await groupLiveRegistry(sandbox);
  await groupOutage(sandbox);
  await groupTls(sandbox);
  await groupKnownDefects(sandbox);

  if (CONFIG.nodeMatrix) {
    await groupNodeMatrix();
  } else {
    report.skip('C23', 'Node version matrix', 'run with --node-matrix to include it', 'node-matrix');
  }

  const jsonPath = path.join(CONFIG.workDir, 'results.json');
  report.write(jsonPath);
  report.printSummary();
  process.stdout.write('\nResults written to ' + jsonPath + '\n');

  process.exitCode = report.failed ? 1 : 0;
}

main().catch(function (err) {
  process.stderr.write('harness error: ' + (err && err.stack ? err.stack : err) + '\n');
  process.exitCode = 1;
});
