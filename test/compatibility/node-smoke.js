/* eslint-disable */
// Smoke test for one Node version, executed INSIDE a `node:*` container by
// run.js --node-matrix. Deliberately written in ES5 with callbacks so that it
// also parses on the oldest Node lines we probe.
//
// Prints a single line: COMPAT_SMOKE_RESULT {...json...}

var cp = require('child_process');
var fs = require('fs');
var http = require('http');
var net = require('net');
var path = require('path');

var VERSION = process.env.COMPAT_NPM_LAZY_VERSION || '1.14.0';
var REGISTRY = process.env.COMPAT_REGISTRY || 'https://registry.npmjs.org/';
var PORT = 18080;
var BASE = 'http://127.0.0.1:' + PORT;
var SANDBOX = '/tmp/npm-lazy-smoke';
var CACHE = '/tmp/npm-lazy-cache';
var TARBALL = '/process/-/process-0.11.10.tgz';

var result = {
  node: process.version,
  npm: null,
  install: false,
  metadataUnscoped: false,
  metadataScoped: false,
  externalUrl: false,
  tarball: false,
  corruptRecovery: false,
  serverExit: null,
  error: null,
};

var child = null;

function finish(err) {
  if (err) {
    result.error = err.message || String(err);
  }
  if (child && result.serverExit === null) {
    try {
      child.kill('SIGKILL');
    } catch (e) {}
  }
  process.stdout.write('COMPAT_SMOKE_RESULT ' + JSON.stringify(result) + '\n');
  process.exit(0);
}

function get(url, cb) {
  var req = http.get(url, function (res) {
    var chunks = [];
    res.on('data', function (chunk) {
      chunks.push(chunk);
    });
    res.on('end', function () {
      cb(null, res.statusCode, Buffer.concat(chunks));
    });
  });
  req.setTimeout(60000, function () {
    req.abort();
  });
  req.on('error', function (err) {
    cb(err);
  });
}

function waitForPort(deadline, cb) {
  if (Date.now() > deadline) {
    return cb(new Error('server did not listen on port ' + PORT));
  }
  var socket = net.connect(PORT, '127.0.0.1');
  socket.setTimeout(1000);
  socket.on('connect', function () {
    socket.destroy();
    cb(null);
  });
  socket.on('timeout', function () {
    socket.destroy();
    setTimeout(function () {
      waitForPort(deadline, cb);
    }, 300);
  });
  socket.on('error', function () {
    setTimeout(function () {
      waitForPort(deadline, cb);
    }, 300);
  });
}

function step1Install() {
  try {
    fs.mkdirSync(SANDBOX);
  } catch (e) {}

  fs.writeFileSync(
    path.join(SANDBOX, 'package.json'),
    JSON.stringify({ name: 'smoke', version: '1.0.0', private: true })
  );

  cp.execFile('npm', ['--version'], function (err, stdout) {
    result.npm = err ? null : String(stdout).trim();

    cp.execFile(
      'npm',
      ['install', 'npm_lazy@' + VERSION, '--registry=' + REGISTRY, '--loglevel=error'],
      { cwd: SANDBOX, maxBuffer: 32 * 1024 * 1024, timeout: 420000 },
      function (installErr) {
        if (installErr && !fs.existsSync(path.join(SANDBOX, 'node_modules', 'npm_lazy', 'package.json'))) {
          return finish(new Error('npm install npm_lazy@' + VERSION + ' failed: ' + installErr.message));
        }
        result.install = true;
        step2Start();
      }
    );
  });
}

function step2Start() {
  var script = [
    "var path = require('path');",
    "var base = " + JSON.stringify(path.join(SANDBOX, 'node_modules', 'npm_lazy')) + ";",
    "var config = require(path.join(base, 'config.js'));",
    "var start = require(path.join(base, 'server.js'));",
    "config.cacheDirectory = " + JSON.stringify(CACHE) + ";",
    "config.port = " + PORT + ";",
    "config.host = '127.0.0.1';",
    "config.externalUrl = " + JSON.stringify(BASE) + ";",
    "config.remoteUrl = " + JSON.stringify(REGISTRY) + ";",
    "config.cacheAge = 0;",
    "config.proxy = {};",
    'start(config);',
  ].join('\n');

  var scriptPath = path.join(SANDBOX, 'smoke-server.js');
  fs.writeFileSync(scriptPath, script);

  child = cp.spawn(process.execPath, [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', function () {});
  child.stderr.on('data', function () {});
  child.on('exit', function (code, signal) {
    result.serverExit = { code: code, signal: signal };
  });

  waitForPort(Date.now() + 30000, function (err) {
    if (err) {
      return finish(err);
    }
    step3Metadata();
  });
}

function step3Metadata() {
  get(BASE + '/process', function (err, status, body) {
    if (err) {
      return finish(err);
    }
    if (status !== 200) {
      return finish(new Error('unscoped metadata HTTP ' + status));
    }

    var doc;
    try {
      doc = JSON.parse(body.toString());
    } catch (parseError) {
      return finish(parseError);
    }
    result.metadataUnscoped = Boolean(doc.versions && doc.versions['0.11.10']);
    result.externalUrl = doc.versions['0.11.10'].dist.tarball === BASE + TARBALL;

    get(BASE + '/@sindresorhus%2fis', function (scopedErr, scopedStatus, scopedBody) {
      if (scopedErr) {
        return finish(scopedErr);
      }
      try {
        result.metadataScoped = scopedStatus === 200 && Boolean(JSON.parse(scopedBody.toString()).versions);
      } catch (parseError) {
        result.metadataScoped = false;
      }
      step4Tarball();
    });
  });
}

function step4Tarball() {
  get(BASE + TARBALL, function (err, status, body) {
    if (err) {
      return finish(err);
    }
    result.tarball = status === 200 && body.length > 1000 && body[0] === 0x1f && body[1] === 0x8b;
    step5Corrupt();
  });
}

function step5Corrupt() {
  var meta;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(CACHE, 'meta.json')).toString());
  } catch (err) {
    return finish(err);
  }

  var key = REGISTRY.replace(/\/$/, '') + TARBALL;
  if (!meta[key] || !meta[key].taskResults || !meta[key].taskResults.GET) {
    return finish(new Error('no cache entry for ' + key));
  }

  fs.writeFileSync(meta[key].taskResults.GET.path, 'corrupted-on-purpose');

  get(BASE + TARBALL, function (err, status) {
    setTimeout(function () {
      result.corruptRecovery = !err && status === 200 && result.serverExit === null;
      finish(null);
    }, 500);
  });
}

step1Install();
