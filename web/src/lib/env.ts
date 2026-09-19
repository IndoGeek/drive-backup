import path from 'node:path';
import { panelDir } from './panel';

export function checkoutRoot(): string {
  return (
    process.env.BACKUP_MGR_CHECKOUT || process.env.BACKUP_MGR_ROOT || path.resolve(panelDir(), '..')
  );
}
