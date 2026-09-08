'use strict';
// @prism/core entry point -- the public, semver'd surface.
module.exports = Object.assign({}, require('./api'), {
  sdk: require('./sdk'),                 // plugin SDK: definePlugin, registerOpcode, testPlugin, ...
  spec: require('./core/spec'),
  plugin: require('./core/plugin'),
  versionInfo: require('./core/version'), // full version + capability object (api.version is the string)
});
