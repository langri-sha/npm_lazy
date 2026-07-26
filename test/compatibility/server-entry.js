'use strict';

// Boots npm_lazy from the harness sandbox with a fully explicit configuration.
// Spawned by lib/server.js; never meant to be run by hand.

const path = require('path');

const sandbox = process.env.COMPAT_SANDBOX;
if (!sandbox) {
  throw new Error('COMPAT_SANDBOX is required');
}

const modulePath = path.join(sandbox, 'node_modules', 'npm_lazy');
const config = require(path.join(modulePath, 'config.js'));
const start = require(path.join(modulePath, 'server.js'));

config.cacheDirectory = process.env.COMPAT_CACHE_DIR;
config.port = Number(process.env.COMPAT_PORT);
config.host = '127.0.0.1';
config.externalUrl = process.env.COMPAT_EXTERNAL_URL;
config.remoteUrl = process.env.COMPAT_REMOTE_URL;
config.cacheAge = Number(process.env.COMPAT_CACHE_AGE);
config.httpTimeout = Number(process.env.COMPAT_HTTP_TIMEOUT);
config.maxRetries = Number(process.env.COMPAT_MAX_RETRIES);
config.rejectUnauthorized = process.env.COMPAT_REJECT_UNAUTHORIZED !== 'false';
config.proxy = {};
config.loggingOpts.logToConsole = true;
config.loggingOpts.logToFile = false;

start(config);
