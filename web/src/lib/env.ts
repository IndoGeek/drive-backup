import path from 'node:path';
import { panelDir } from './panel';

/**
 * Panel-level paths only.
 *
 * An instance's own paths (config.yml, logs, pm2 home) belong to a Linux user and
 * live on the Instance object instead — see ./instance.ts. `BACKUP_MGR_ROOT` is
 * still honoured as an alias for the checkout so existing deployments keep
 * working after the multi-user migration.
 */
export function checkoutRoot(): string {
  return (
    process.env.BACKUP_MGR_CHECKOUT || process.env.BACKUP_MGR_ROOT || path.resolve(panelDir(), '..')
  );
}
