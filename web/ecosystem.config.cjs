// Moved: the panel's pm2 definition now lives beside the daemon's, at the repo
// root, so both services are configured from the same place and there is only
// one definition of the `backup-mgr-web` app.
//
//   pm2 start ecosystem.frontend.cjs        # from the repo root
//
// This file is kept as a re-export so an existing
// `pm2 start web/ecosystem.config.cjs` keeps working.

module.exports = require('../ecosystem.frontend.cjs');
