// pm2 only parses a file as an ecosystem config when the FILENAME matches
// `*.config.{js,cjs,mjs,json}` (or `ecosystem.{js,cjs}`). This file exists for
// that reason alone — the actual definition lives in ./ecosystem.frontend.cjs.
//
//   pm2 start ecosystem.frontend.config.cjs        # the panel (web frontend)
//   pm2 start ecosystem.config.cjs                 # the daemon (Rust)
//   pm2 start ecosystem.frontend.config.cjs ecosystem.config.cjs   # both
//
// Do not add settings here; edit ecosystem.frontend.cjs.

module.exports = require('./ecosystem.frontend.cjs');
