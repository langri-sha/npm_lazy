// Require dependencies.
var _ = require('underscore');
var s = require('underscore.string');

var dasherize = s.dasherize.bind(s);

module.exports.configureProgramOptions = function (config, program) {
  var createOption = _.partial(createOption, program);

  _.chain(config)
    .pairs()
    .map(function (pair) {
      var key = pair[0];
      var value = pair[1];

      if (!_.isObject(value)) {
        return dasherize(key);
      } else if (!_.isEmpty(value)) {
        return _.chain(value)
          .keys()
          .map(function (subkey) {
            return dasherize(key).concat('_').concat(dasherize(subkey));
          })
          .value();
      }
    })
    .flatten()
    .compact()
    .each(function (key) {
      program.option('--'.concat(key).concat(' [value]'));
    });
}

module.exports.updateConfiguration = function (config, program) {
  _.chain(config)
    .pairs()
    .each(function (pair) {
      var key = pair[0];
      var value = pair[1];

      if (!_.isObject(value) && program.hasOwnProperty(key)) {
          config[key] = parseOption(config[key], program[key]);
      } else if (!_.isEmpty(value)) {
        _.chain(value)
          .keys()
          .each(function (subkey) {
              var composed = key.concat('_').concat(subkey);

              if (program.hasOwnProperty(composed)) {
                config[key][subkey] =
                  parseOption(config[key][subkey], program[composed]);
              }
          });
      }
    });
}

function parseOption(configDefault, value) {
  if (_.isNumber(configDefault)) {
    return parseInt(value);
  }

  if (_.isBoolean(configDefault)) {
    return value === 'true' || value === true && true || false;
  }

  return value;
}
