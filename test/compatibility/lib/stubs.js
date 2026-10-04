'use strict';

// Local upstream stubs used to make outage and TLS behaviour deterministic
// without touching the machine's network configuration.

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { URL } = require('url');

const util = require('./util');

// A pass-through registry in front of the real one. Flipping it to `outage`
// keeps the upstream URL (and therefore every npm_lazy cache key) identical
// while making upstream unreachable, which is exactly what a registry outage
// looks like to a warm cache.
async function startUpstreamStub(remoteUrl) {
  const port = await util.freePort();
  let mode = 'proxy';

  const server = http.createServer(function (req, res) {
    if (mode === 'outage') {
      req.socket.destroy();
      return;
    }

    const target = new URL(req.url, remoteUrl);
    const headers = Object.assign({}, req.headers, { host: target.host });
    delete headers['accept-encoding'];

    const upstream = https.request(
      target,
      { method: req.method, headers: headers },
      function (upstreamRes) {
        res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        upstreamRes.pipe(res);
      }
    );

    upstream.on('error', function (err) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream stub failure: ' + err.message }));
    });

    req.pipe(upstream);
  });

  await new Promise(function (resolve, reject) {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  return {
    port: port,
    url: 'http://127.0.0.1:' + port + '/',
    setMode: function (next) {
      mode = next;
    },
    close: function () {
      return new Promise(function (resolve) {
        server.close(resolve);
        server.closeAllConnections();
      });
    },
  };
}

// A self-signed HTTPS registry that answers every path with a valid packument.
// Used to prove whether npm_lazy actually verifies upstream certificates.
async function startSelfSignedRegistry(workDir) {
  const certDir = path.join(workDir, 'tls');
  const keyPath = path.join(certDir, 'key.pem');
  const certPath = path.join(certDir, 'cert.pem');

  fs.mkdirSync(certDir, { recursive: true });

  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    const result = await util.run(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', keyPath,
        '-out', certPath,
        '-days', '2',
        '-subj', '/CN=127.0.0.1',
        '-addext', 'subjectAltName=IP:127.0.0.1',
      ],
      { timeout: 60000 }
    );

    if (result.code !== 0) {
      return null;
    }
  }

  const packument = {
    name: 'tlsprobe',
    'dist-tags': { latest: '1.0.0' },
    versions: {
      '1.0.0': {
        name: 'tlsprobe',
        version: '1.0.0',
        dist: {
          shasum: '0000000000000000000000000000000000000000',
          tarball: 'https://registry.npmjs.org/tlsprobe/-/tlsprobe-1.0.0.tgz',
        },
      },
    },
  };

  const port = await util.freePort();
  const server = https.createServer(
    { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
    function (req, res) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(packument));
    }
  );

  await new Promise(function (resolve, reject) {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  return {
    port: port,
    url: 'https://127.0.0.1:' + port + '/',
    close: function () {
      return new Promise(function (resolve) {
        server.close(resolve);
        server.closeAllConnections();
      });
    },
  };
}

module.exports = {
  startSelfSignedRegistry: startSelfSignedRegistry,
  startUpstreamStub: startUpstreamStub,
};
