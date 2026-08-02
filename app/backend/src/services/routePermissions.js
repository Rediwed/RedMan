export const PERMISSIONS = Object.freeze({
  PUBLIC: 'public',
  READ: 'read',
  SELF: 'account:self',
  OPERATE: 'operate',
  RESTORE: 'restore',
  DOCKER_MUTATE: 'docker:mutate',
  SETTINGS: 'settings',
  SECRETS: 'secrets',
  PEERS: 'peers',
  DISCOVERY: 'discovery',
  ACCOUNTS: 'accounts',
});

const policy = (methods, pattern, permission) => ({
  methods: new Set(methods),
  pattern,
  permission,
});

export const API_ROUTE_POLICIES = Object.freeze([
  policy(['GET'], /^\/auth\/status$/, PERMISSIONS.PUBLIC),
  policy(['POST'], /^\/auth\/(?:bootstrap|login|recover)$/, PERMISSIONS.PUBLIC),
  policy(['GET'], /^\/auth\/session$/, PERMISSIONS.SELF),
  policy(['POST'], /^\/auth\/(?:logout|password)$/, PERMISSIONS.SELF),
  policy(['GET', 'POST'], /^\/auth\/(?:users|audit)$/, PERMISSIONS.ACCOUNTS),
  policy(['PUT'], /^\/auth\/users\/\d+$/, PERMISSIONS.ACCOUNTS),
  policy(['POST'], /^\/auth\/users\/\d+\/revoke-sessions$/, PERMISSIONS.ACCOUNTS),
  policy(['GET'], /^\/health\/details$/, PERMISSIONS.READ),
  policy(['GET'], /^\/ssd-backup\/(?:shares|browse|configs|runs)\/?$/, PERMISSIONS.READ),
  policy(['GET'], /^\/ssd-backup\/configs\/\d+$/, PERMISSIONS.READ),
  policy(['GET'], /^\/ssd-backup\/runs\/\d+(?:\/progress)?$/, PERMISSIONS.READ),
  policy(['GET'], /^\/ssd-backup\/configs\/\d+\/(?:snapshots|browse|download)$/, PERMISSIONS.READ),
  policy(['GET'], /^\/ssd-backup\/verification-runs\/\d+$/, PERMISSIONS.READ),
  policy(['POST', 'PUT'], /^\/ssd-backup\/configs(?:\/\d+)?$/, PERMISSIONS.OPERATE),
  policy(['DELETE'], /^\/ssd-backup\/configs\/\d+$/, PERMISSIONS.OPERATE),
  policy(['POST'], /^\/ssd-backup\/(?:configs\/\d+\/(?:run|prune|verify-versions)|runs\/\d+\/cancel|verification-runs\/\d+\/cancel)$/, PERMISSIONS.OPERATE),
  policy(['POST'], /^\/ssd-backup\/configs\/\d+\/restore$/, PERMISSIONS.RESTORE),

  policy(['GET'], /^\/hyper-backup\/(?:jobs|runs|remote-browse|remote-roots|remote-shares)\/?$/, PERMISSIONS.READ),
  policy(['GET'], /^\/hyper-backup\/(?:jobs|runs)\/\d+(?:\/progress)?$/, PERMISSIONS.READ),
  policy(['POST', 'PUT'], /^\/hyper-backup\/jobs(?:\/\d+)?$/, PERMISSIONS.OPERATE),
  policy(['DELETE'], /^\/hyper-backup\/jobs\/\d+$/, PERMISSIONS.OPERATE),
  policy(['POST'], /^\/hyper-backup\/(?:jobs\/\d+\/run|runs\/\d+\/cancel|test-connection)$/, PERMISSIONS.OPERATE),

  policy(['GET'], /^\/rclone\/(?:remotes|jobs|runs|providers)\/?$/, PERMISSIONS.READ),
  policy(['GET'], /^\/rclone\/remote\/[^/]+\/ls$/, PERMISSIONS.READ),
  policy(['GET'], /^\/rclone\/(?:jobs|runs)\/\d+(?:\/progress)?$/, PERMISSIONS.READ),
  policy(['GET'], /^\/rclone\/remotes\/[^/]+\/config$/, PERMISSIONS.SECRETS),
  policy(['POST', 'PUT', 'DELETE'], /^\/rclone\/remotes(?:\/[^/]+)?$/, PERMISSIONS.SETTINGS),
  policy(['POST'], /^\/rclone\/remotes\/[^/]+\/test$/, PERMISSIONS.SETTINGS),
  policy(['POST', 'PUT'], /^\/rclone\/jobs(?:\/\d+)?$/, PERMISSIONS.OPERATE),
  policy(['DELETE'], /^\/rclone\/jobs\/\d+$/, PERMISSIONS.OPERATE),
  policy(['POST'], /^\/rclone\/(?:jobs\/\d+\/run|runs\/\d+\/cancel)$/, PERMISSIONS.OPERATE),

  policy(['GET'], /^\/docker\/(?:status|containers)\/?$/, PERMISSIONS.READ),
  policy(['GET'], /^\/docker\/containers\/[^/]+\/(?:stats|metrics)$/, PERMISSIONS.READ),
  policy(['POST'], /^\/docker\/containers\/[^/]+\/(?:start|stop|restart)$/, PERMISSIONS.DOCKER_MUTATE),

  policy(['GET'], /^\/media-import\/(?:drives|runs|status)\/?$/, PERMISSIONS.READ),
  policy(['GET'], /^\/media-import\/drives\/(?:known|\d+)$/, PERMISSIONS.READ),
  policy(['GET'], /^\/media-import\/drives\/\d+\/scan$/, PERMISSIONS.READ),
  policy(['GET'], /^\/media-import\/runs\/\d+(?:\/(?:progress|files))?$/, PERMISSIONS.READ),
  policy(['PUT'], /^\/media-import\/drives\/\d+$/, PERMISSIONS.OPERATE),
  policy(['POST'], /^\/media-import\/(?:drives\/\d+\/(?:scan|import|eject)|runs\/\d+\/cancel|test-immich)$/, PERMISSIONS.OPERATE),

  policy(['GET', 'PUT'], /^\/settings\/?$/, PERMISSIONS.SETTINGS),
    policy(['GET'], /^\/settings\/public$/, PERMISSIONS.READ),
  policy(['GET', 'POST'], /^\/settings\/(?:ntfy-test|browser-notify-test|ssh\/(?:status|generate|authorize-localhost|test)|db\/(?:backup|backup-all|backups|recovery-scan|recovery-info|restore))$/, PERMISSIONS.SETTINGS),
  policy(['GET'], /^\/settings\/notifications\/stream$/, PERMISSIONS.READ),

  policy(['GET', 'POST'], /^\/peers\/?$/, PERMISSIONS.PEERS),
  policy(['GET'], /^\/peers\/(?:connectivity|audit-log\/all|pair\/(?:incoming|history|status\/\d+)|\d+|\d+\/audit-log)$/, PERMISSIONS.PEERS),
  policy(['POST', 'PUT', 'DELETE'], /^\/peers\/(?:\d+|\d+\/regenerate-key|pair|pair\/sync|pair\/\d+(?:\/(?:accept|decline))?)$/, PERMISSIONS.PEERS),

  policy(['GET'], /^\/overview\/summary$/, PERMISSIONS.READ),
  policy(['GET'], /^\/filesystem\/(?:browse|roots)$/, PERMISSIONS.READ),
  policy(['GET', 'POST'], /^\/discovery\/(?:subnets|peers|immich|clear-cache)$/, PERMISSIONS.DISCOVERY),
  policy(['GET'], /^\/upgrade-readiness\/?$/, PERMISSIONS.READ),
  policy(['POST'], /^\/upgrade-readiness\/(?:backup|remediate|host-plan|final-config)$/, PERMISSIONS.SETTINGS),

  // Heartbeat ingest is mounted before this middleware and carries its own
  // per-job token, so it deliberately has no entry here.
  policy(['GET'], /^\/external-jobs\/?$/, PERMISSIONS.READ),
  policy(['GET'], /^\/external-jobs\/(?:runs|\d+)$/, PERMISSIONS.READ),
  policy(['PUT', 'DELETE'], /^\/external-jobs\/\d+$/, PERMISSIONS.OPERATE),
  // Creating a job mints its first token, so it is held to the same bar as
  // regenerating one rather than treated as routine configuration.
  policy(['POST'], /^\/external-jobs\/?$/, PERMISSIONS.SECRETS),
  policy(['POST'], /^\/external-jobs\/\d+\/regenerate-token$/, PERMISSIONS.SECRETS),
]);

export function getRoutePermission(method, pathname) {
  const normalizedPath = pathname.startsWith('/api/') ? pathname.slice(4) : pathname;
  const match = API_ROUTE_POLICIES.find(entry => entry.methods.has(method.toUpperCase()) && entry.pattern.test(normalizedPath));
  return match?.permission || null;
}

export function authorizeApiRoute(req, res, next) {
  const pathname = new URL(req.originalUrl || req.url, 'http://redman.local').pathname;
  const permission = getRoutePermission(req.method, pathname);
  if (!permission) {
    return res.status(403).json({ error: 'Route has no authorization policy' });
  }
  if (
    permission === PERMISSIONS.PUBLIC ||
    req.user?.role === 'admin' ||
    (req.user?.role === 'viewer' && [PERMISSIONS.READ, PERMISSIONS.SELF].includes(permission))
  ) {
    req.permission = permission;
    return next();
  }
  return res.status(403).json({ error: 'Insufficient permission' });
}
