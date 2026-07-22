import { realpathSync } from 'node:fs';
import { isWithinPrefix } from '../middleware/validation.js';

export function resolveAllowedBrowsePath(requestedPath, roots, sensitiveRoots = []) {
  const realPath = realpathSync(requestedPath);
  const denied = sensitiveRoots.some(root => {
    try {
      return isWithinPrefix(realPath, realpathSync(root));
    } catch {
      return false;
    }
  });
  if (denied) throw new Error('Path is sensitive and cannot be browsed');

  for (const root of roots) {
    try {
      const realRoot = realpathSync(root.path);
      if (isWithinPrefix(realPath, realRoot)) return { path: realPath, root: realRoot };
    } catch { /* unavailable root */ }
  }
  throw new Error('Path is outside allowed roots');
}