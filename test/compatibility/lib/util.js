'use strict';

// Dependency-free helpers shared by the compatibility harness.

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const net = require('net');
const { spawn } = require('child_process');

const DEFAULT_HTTP_TIMEOUT = 60000;
const DEFAULT_RUN_TIMEOUT = 300000;

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

// Minimal HTTP(S) GET that always resolves with a buffered body so callers can
// assert on both status and payload size.
function httpGet(url, options) {
  const opts = options || {};
  const timeout = opts.timeout || DEFAULT_HTTP_TIMEOUT;
  const transport = url.startsWith('https:') ? https : http;

  return new Promise(function (resolve, reject) {
    const req = transport.get(
      url,
      {
        headers: Object.assign({ 'user-agent': 'npm_lazy-compat-harness' }, opts.headers),
        rejectUnauthorized: opts.rejectUnauthorized !== false,
      },
      function (res) {
        const chunks = [];
        res.on('data', function (chunk) {
          chunks.push(chunk);
        });
        res.on('end', function () {
          const body = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, body: body, bytes: body.length });
        });
      }
    );

    req.setTimeout(timeout, function () {
      req.destroy(new Error('HTTP request timed out after ' + timeout + 'ms: ' + url));
    });
    req.on('error', reject);
  });
}

async function httpGetJson(url, options) {
  const res = await httpGet(url, options);
  let json = null;
  let parseError = null;
  try {
    json = JSON.parse(res.body.toString('utf8'));
  } catch (err) {
    parseError = err;
  }
  return Object.assign({}, res, { json: json, parseError: parseError });
}

// Runs a command, always resolving. Callers decide what a non-zero exit means.
function run(command, args, options) {
  const opts = options || {};
  const timeout = opts.timeout || DEFAULT_RUN_TIMEOUT;

  return new Promise(function (resolve) {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(function () {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);

    child.stdout.on('data', function (chunk) {
      stdout += chunk;
    });
    child.stderr.on('data', function (chunk) {
      stderr += chunk;
    });
    child.on('error', function (err) {
      clearTimeout(timer);
      resolve({ code: -1, stdout: stdout, stderr: stderr + '\n' + err.message, timedOut: timedOut });
    });
    child.on('close', function (code) {
      clearTimeout(timer);
      resolve({ code: code, stdout: stdout, stderr: stderr, timedOut: timedOut });
    });
  });
}

// Asks the OS for an unused TCP port and releases it immediately. Racy in
// principle, fine for a single-machine harness and far better than hardcoding.
function freePort() {
  return new Promise(function (resolve, reject) {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', function () {
      const port = server.address().port;
      server.close(function () {
        resolve(port);
      });
    });
  });
}

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 20000);

  while (Date.now() < deadline) {
    const reachable = await new Promise(function (resolve) {
      const socket = net.connect({ port: port, host: '127.0.0.1' });
      socket.setTimeout(1000);
      socket.on('connect', function () {
        socket.destroy();
        resolve(true);
      });
      socket.on('timeout', function () {
        socket.destroy();
        resolve(false);
      });
      socket.on('error', function () {
        resolve(false);
      });
    });

    if (reachable) {
      return true;
    }
    await sleep(200);
  }

  return false;
}

function sha1(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

module.exports = {
  DEFAULT_HTTP_TIMEOUT: DEFAULT_HTTP_TIMEOUT,
  freePort: freePort,
  httpGet: httpGet,
  httpGetJson: httpGetJson,
  run: run,
  sha1: sha1,
  sleep: sleep,
  waitForPort: waitForPort,
};
