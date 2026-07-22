import db from './db.js';

const resetTables = [
  'auth_sessions',
  'auth_recovery_events',
  'auth_audit_log',
  'auth_credentials',
  'auth_users',
  'restore_events',
  'media_import_ledger',
  'backup_run_files',
  'backup_runs',
  'pairing_requests',
  'peer_audit_log',
  'authorized_peers',
  'hyper_backup_jobs',
  'rclone_jobs',
  'ssd_backup_configs',
  'container_metrics',
  'media_drives',
  'cache',
  'settings',
];

const seed = db.transaction(() => {
  for (const table of resetTables) db.prepare(`DELETE FROM ${table}`).run();
  db.prepare(`DELETE FROM sqlite_sequence WHERE name IN (${resetTables.map(() => '?').join(', ')})`).run(...resetTables);

  const insertSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  const settings = {
    instance_name: 'RedMan',
    user_name: '',
    ntfy_enabled: 'false',
    browser_notify_enabled: 'false',
    ntfy_server: 'https://ntfy.sh',
    ntfy_topic: '',
    ntfy_auth_type: 'none',
    ntfy_auth_token: '',
    ntfy_username: '',
    ntfy_password: '',
    ntfy_on_job_start: 'true',
    ntfy_on_job_complete: 'true',
    ntfy_on_job_error: 'true',
    ntfy_on_progress: 'false',
    ntfy_progress_interval: '60',
    ntfy_on_drive_attach: 'true',
    ntfy_on_drive_lost: 'true',
    ntfy_on_drive_scan: 'false',
    docker_socket: process.env.DOCKER_HOST || '',
    peer_api_port: '8091',
    peer_api_url: '',
    metrics_poll_interval: '30',
    metrics_retention_hours: '24',
    immich_server_url: '',
    immich_api_key: '',
    media_import_poll_interval: '10',
    discovery_subnets: '',
    timezone: process.env.TZ || 'UTC',
    date_format: 'system',
    time_format: 'system',
    hidden_drives: '[]',
    hidden_remote_drives: '[]',
    run_files_retention_days: '30',
    ssd_allow_empty_source: '0',
    run_history_retention_days: '365',
    peer_audit_retention_days: '30',
    peer_security_audit_retention_days: '365',
    auth_audit_retention_days: '365',
  };
  for (const [key, value] of Object.entries(settings)) insertSetting.run(key, value);
});

seed();
console.log('Database seeded successfully');