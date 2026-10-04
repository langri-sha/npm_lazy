'use strict';

// Supervises a sandboxed npm_lazy server process.
//
// The server itself is started by `server-entry.js`, which is spawned with the
// harness' own Node binary so that "which Node runs npm_lazy" is decided by
// whoever runs the harness.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const util = require('./util');

const ENTRY = path.join(__dirname, '..', 'server-entry.js');

class LazyServer {
  constructor(options) {
    this.sandbox = options.sandbox;
    this.cacheDir = options.cacheDir;
    this.port = options.port;
    this.externalUrl = options.externalUrl || 'http://127.0.0.1:' + options.port;
    this.remoteUrl = options.remoteUrl;
    this.cacheAge = options.cacheAge === undefined ? 0 : options.cacheAge;
    this.httpTimeout = options.httpTimeout || 10000;
    this.maxRetries = options.maxRetries === undefined ? 5 : options.maxRetries;
    this.rejectUnauthorized = options.rejectUnauthorized !== false;
    this.logPath = options.logPath;

    this.child = null;
    this.log = '';
    this.exit = null;
  }

  async start(timeoutMs) {
    fs.mkdirSync(this.cacheDir, { recursive: true });

    const env = Object.assign({}, process.env, {
      COMPAT_SANDBOX: this.sandbox,
      COMPAT_CACHE_DIR: this.cacheDir,
      COMPAT_PORT: String(this.port),
      COMPAT_EXTERNAL_URL: this.externalUrl,
      COMPAT_REMOTE_URL: this.remoteUrl,
      COMPAT_CACHE_AGE: String(this.cacheAge),
      COMPAT_HTTP_TIMEOUT: String(this.httpTimeout),
      COMPAT_MAX_RETRIES: String(this.maxRetries),
      COMPAT_REJECT_UNAUTHORIZED: this.rejectUnauthorized ? 'true' : 'false',
    });

    // npm_lazy picks these up as an upstream proxy; never inherit them.
    delete env.http_proxy;
    delete env.https_proxy;
    delete env.HTTP_PROXY;
    delete env.HTTPS_PROXY;

    this.log = '';
    this.exit = null;
    this.child = spawn(process.execPath, [ENTRY], { env: env, stdio: ['ignore', 'pipe', 'pipe'] });

    const append = (chunk) => {
      this.log += chunk;
      if (this.logPath) {
        fs.appendFileSync(this.logPath, chunk);
      }
    };

    this.child.stdout.on('data', append);
    this.child.stderr.on('data', append);
    this.child.on('exit', (code, signal) => {
      this.exit = { code: code, signal: signal };
    });

    const up = await util.waitForPort(this.port, timeoutMs || 20000);
    if (!up) {
      const log = this.log;
      await this.stop();
      throw new Error('npm_lazy did not start on port ' + this.port + '\n' + log);
    }

    return this;
  }

  get url() {
    return 'http://127.0.0.1:' + this.port;
  }

  get alive() {
    return Boolean(this.child) && this.exit === null;
  }

  // Returns a cursor into the server log so a caller can inspect only the lines
  // a specific scenario produced.
  mark() {
    return this.log.length;
  }

  since(cursor) {
    return this.log.slice(cursor);
  }

  // Upstream fetches npm_lazy actually performed since `cursor`.
  upstreamFetches(cursor) {
    return this.since(cursor)
      .split('\n')
      .map((line) => {
        const match = /\[GET\] (\S+)/.exec(line);
        return match ? match[1] : null;
      })
      .filter(Boolean);
  }

  async stop() {
    if (!this.child || this.exit !== null) {
      this.child = null;
      return;
    }

    const child = this.child;
    const stopped = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');

    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await stopped;
    clearTimeout(timer);
    this.child = null;
  }
}

module.exports = LazyServer;
