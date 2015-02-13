// Require dependencies.
var config = require('npm_lazy/config');
var pkg = require('./package.json');
var program = require('commander');
var server = require('npm_lazy/server');
var utils = require('./lib/utils');

// Setup program.
program
  .version(pkg.version)
  .usage('[options]')
  .description('Starts a dynamically configured npm_lazy server instance');

// Populate and parse options.
utils.configureProgramOptions(config, program);
program.parse(process.argv);

// Update configuration.
utils.updateConfiguration(config, program);

// Start server.
server(config);
