import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const compose = readFileSync(resolve(root, 'docker-compose.yml'), 'utf8');
const dockerignore = readFileSync(resolve(root, '.dockerignore'), 'utf8');
const deploy = readFileSync(resolve(root, 'deploy.sh'), 'utf8');
const unraid = readFileSync(resolve(root, 'unraid/redman.xml'), 'utf8');
const prePush = readFileSync(resolve(root, 'pre-push.sh'), 'utf8');
const proxyMiddleware = readFileSync(resolve(root, 'app/backend/src/middleware/auth.js'), 'utf8');

assert.doesNotMatch(compose, /PROXY_AUTO_PROVISION_ROLE=admin/);
assert.match(dockerignore, /^\.redman-deploy-profiles\.sh$/m);
assert.match(compose, /REDMAN_PUBLIC_ORIGIN=\$\{REDMAN_PUBLIC_ORIGIN:\?/);
assert.match(compose, /TRUSTED_PROXIES=\$\{TRUSTED_PROXIES:\?/);
assert.match(compose, /REDMAN_HOST_AUTHORIZED_KEYS_PATH:\?/);
assert.match(compose, /REDMAN_DATA_PATH:\?/);
assert.match(compose, /REDMAN_STORAGE_PATH:\?/);
assert.match(compose, /REDMAN_WEB_PORT:-8090/);
assert.match(compose, /REDMAN_PEER_BIND:\?Set the private host address/);
assert.match(compose, /REDMAN_PEER_PUBLISHED_PORT:-8091/);
assert.match(compose, /REDMAN_STORAGE_ROOTS=\$\{REDMAN_STORAGE_PATH\},\$\{REDMAN_MEDIA_PATH\}/);
assert.doesNotMatch(compose, /\/mnt\/user:|\/boot\/config\/shares:/);
assert.match(compose, /PROXY_AUTO_PROVISION_ROLE=\$\{PROXY_AUTO_PROVISION_ROLE:-\}/);
assert.match(compose, /profiles: \["docker-monitoring"\]/);
assert.doesNotMatch(compose, /depends_on:[\s\S]*docker-socket-proxy/);
assert.match(compose, /DOCKER_HOST=\$\{DOCKER_HOST:-\}/);
assert.match(compose, /DOCKER_CONTROL_HOST=\$\{DOCKER_CONTROL_HOST:-\}/);
assert.match(compose, /mem_limit: \$\{REDMAN_MEMORY_LIMIT:-1536m\}/);
assert.match(compose, /memswap_limit: \$\{REDMAN_MEMORY_SWAP_LIMIT:-2048m\}/);
assert.match(compose, /cpus: \$\{REDMAN_CPU_LIMIT:-2\}/);
assert.match(compose, /pids_limit: \$\{REDMAN_PIDS_LIMIT:-256\}/);
assert.match(compose, /docker-socket-proxy:[\s\S]*?mem_limit: 128m[\s\S]*?pids_limit: 32[\s\S]*?\n  docker-control-proxy:/);
assert.match(compose, /docker-control-proxy:[\s\S]*?mem_limit: 128m[\s\S]*?pids_limit: 32[\s\S]*?\n  redman:/);
assert.match(compose, /docker-socket-proxy:[\s\S]*?target: docker-api-proxy[\s\S]*?REDMAN_DOCKER_PROXY_MODE=read[\s\S]*?\n  docker-control-proxy:/);
assert.match(compose, /docker-control-proxy:[\s\S]*?target: docker-api-proxy[\s\S]*?REDMAN_DOCKER_PROXY_MODE=control[\s\S]*?\n  redman:/);
assert.doesNotMatch(compose, /CONTAINERS=|POST=|ALLOW_RESTARTS=/);
assert.doesNotMatch(unraid, /Name="DOCKER_HOST"[\s\S]*Required="true"/);
assert.doesNotMatch(unraid, /Name="DOCKER_CONTROL_HOST"[\s\S]*Required="true"/);
assert.doesNotMatch(unraid, /Name="PROXY_AUTO_PROVISION_ROLE"[\s\S]*?Default="admin"/);
assert.doesNotMatch(unraid, /Name="Peer API Port"/);
assert.match(unraid, /does not publish the unauthenticated pairing\/peer port/);
assert.match(unraid, /Name="REDMAN_PUBLIC_ORIGIN"/);
assert.match(unraid, /Name="TRUSTED_PROXIES"/);
assert.match(unraid, /Target="\/host-ssh\/authorized_keys"/);
assert.match(unraid, /Name="REDMAN_STORAGE_ROOTS"/);
assert.match(unraid, /Name="REDMAN_MEDIA_ROOT"/);
assert.match(unraid, /<ExtraParams>--security-opt=no-new-privileges:true --cap-drop=ALL --cap-add=DAC_READ_SEARCH --memory=1536m --memory-swap=2048m --cpus=2 --pids-limit=256<\/ExtraParams>/);
assert.match(deploy, /read_existing_env AUTH_MODE/);
assert.match(deploy, /read_existing_env REDMAN_PUBLIC_ORIGIN/);
assert.match(deploy, /read_existing_env TRUSTED_PROXIES/);
assert.match(deploy, /Cannot verify container state/);
assert.match(deploy, /Cannot query active jobs inside the container/);
assert.match(deploy, /SELECT COUNT\(\*\) AS count FROM backup_runs WHERE status = 'running'/);
assert.doesNotMatch(deploy, /Health response has no runningJobs count/);
assert.doesNotMatch(deploy, /-e PROXY_AUTO_PROVISION_ROLE=admin/);
assert.match(deploy, /--exclude='app\/backend\/data\/'/);
assert.match(deploy, /--exclude='id_ed25519\*'/);
assert.match(deploy, /--exclude='\.redman-deploy-profiles\.sh'/);
assert.match(deploy, /--exclude='\.redman-release\.env'/);
assert.match(deploy, /scripts\/\$setup_script --data-dir '\$data_dir' \$backup_root_args/);
assert.match(deploy, /Preparing target directories/);
assert.match(deploy, /install -d -m 0755 '\$src_dir'/);
assert.match(deploy, /--custom/);
assert.match(deploy, /--profile/);
assert.match(deploy, /--print-config/);
assert.match(deploy, /setup-backup-user\.sh/);
assert.match(deploy, /REDMAN_STORAGE_ROOTS='\$storage_roots'/);
assert.match(deploy, /DOCKER_CONTROL_HOST='\$docker_control_host_env'/);
assert.match(deploy, /REDMAN_DOCKER_PROXY_MODE=read/);
assert.match(deploy, /REDMAN_DOCKER_PROXY_MODE=control/);
assert.match(deploy, /docker build --target docker-api-proxy/);
assert.doesNotMatch(deploy, /docker build --memory|docker build[^\n]*--memory-swap/);
assert.match(deploy, /docker_free_kb/);
assert.match(deploy, /d_state/);
assert.match(deploy, /mountpoint -q \/mnt\/user/);
assert.match(deploy, /--timeout=120/);
assert.doesNotMatch(deploy, /CONTAINERS=|POST=|ALLOW_RESTARTS=/);
assert.match(deploy, /--clear-breakglass-latch/);
assert.match(deploy, /container-deploy-guard/);
assert.match(deploy, /container-breakglass/);
assert.match(deploy, /BREAKGLASS_PLUGIN/);
assert.match(deploy, /verify-breakglass-runtime\.sh/);
assert.match(deploy, /does not match its persistent plugin manifest/);
assert.match(deploy, /--restart no/);
assert.match(deploy, /read_existing_resource_args/);
assert.match(deploy, /container ls -a --format/);
assert.match(deploy, /grep -Fxq "\$CONTAINER"/);
assert.match(deploy, /\[0-9\]\{1,18\}/);
assert.match(deploy, /runtime_resource_args/);
assert.match(deploy, /runtime_restart_policy/);
// Restart-policy preservation must not copy forward --restart no from an
// abandoned canary left by a prior interrupted deploy — it should fall back
// to unless-stopped instead of leaving the promoted container without auto-restart.
assert.match(deploy, /if \[\[ "\$restart_name" == "no" \]\]/);
assert.match(deploy, /abandoned canary/);
assert.match(deploy, /capture_current_runtime_receipt/);
assert.match(deploy, /container-runtime\.json/);
assert.doesNotMatch(deploy, /runtime=\$\([^\n]*json \.HostConfig\}\}/);
assert.match(deploy, /json \.HostConfig\.Memory/);
assert.match(deploy, /umask 077/);
assert.match(deploy, /remove_reconciled_root_peer_keys/);
assert.match(deploy, /reconcile-root-peer-keys\.sh/);
assert.doesNotMatch(deploy, /REDMAN_DEPLOY_MEMORY_LIMIT|REDMAN_DEPLOY_MEMORY_SWAP_LIMIT|REDMAN_DEPLOY_CPU_LIMIT|REDMAN_DEPLOY_PIDS_LIMIT/);
assert.match(deploy, /-p \$web_bind:\$port:8090/);
assert.match(deploy, /-p \$peer_bind:\$peer_api_port:8091/);
assert.match(deploy, /T_PEER_BIND="\$\{T_PEER_BIND:-\$T_PEER_HOST\}"/);
assert.match(deploy, /http:\/\/\$\{web_bind\}:\$\{port\}\/api\/health/);
assert.match(deploy, /timeout -k 1 5 curl/);
assert.match(deploy, /timeout -k 1 5 .*docker inspect/);
assert.match(deploy, /ServerAliveCountMax=2/);
assert.match(deploy, /action=arm| arm \$CONTAINER/);
assert.match(deploy, /action=disarm| disarm \$CONTAINER/);
assert.match(deploy, /Host observation/);
assert.match(deploy, /early-exit/);
assert.match(deploy, /MemAvailable/);
assert.match(deploy, /rollback-/);
assert.doesNotMatch(deploy, /deploy_target "\$target"[^\n]*&/);
assert.doesNotMatch(deploy, /T_SSH="[A-Za-z0-9._@-]+"/);
assert.doesNotMatch(deploy, /T_(?:SRC|DATA)="\/[^\"]+"/);
assert.doesNotMatch(proxyMiddleware, /10\.0\.0\.0\/8|172\.16\.0\.0\/12|192\.168\.0\.0\/16/);

const noTarget = spawnSync('bash', [resolve(root, 'deploy.sh')], { encoding: 'utf8' });
assert.equal(noTarget.status, 2);
assert.match(noTarget.stdout + noTarget.stderr, /Choose --custom/);

const custom = spawnSync('bash', [resolve(root, 'deploy.sh'), '--custom', '--print-config'], {
	encoding: 'utf8',
	env: {
		...process.env,
		REDMAN_DEPLOY_SSH: 'admin@nas.example',
		REDMAN_DEPLOY_SOURCE_PATH: '/srv/redman-src',
		REDMAN_DEPLOY_DATA_PATH: '/srv/redman',
		REDMAN_DEPLOY_STORAGE_PATH: '/srv/redman-backups',
		REDMAN_DEPLOY_MEDIA_PATH: '/media',
		REDMAN_DEPLOY_PLATFORM: 'linux',
		REDMAN_DEPLOY_PEER_BIND: '192.168.1.20',
	},
});
assert.equal(custom.status, 0, custom.stderr);
assert.match(custom.stdout, /SETUP_SCRIPT=setup-backup-user\.sh/);
assert.match(custom.stdout, /STORAGE_ROOTS=\/srv\/redman-backups,\/media/);
assert.match(custom.stdout, /DOCKER_MONITORING=false/);
assert.match(custom.stdout, /WEB_BIND=127\.0\.0\.1/);
assert.match(custom.stdout, /PEER_BIND=192\.168\.1\.20/);

for (const webBind of ['0.0.0.0', '8.8.8.8']) {
	const unsafeWebBind = spawnSync('bash', [resolve(root, 'deploy.sh'), '--custom', '--print-config'], {
		encoding: 'utf8',
		env: {
			...process.env,
			REDMAN_DEPLOY_SSH: 'admin@nas.example',
			REDMAN_DEPLOY_SOURCE_PATH: '/srv/redman-src',
			REDMAN_DEPLOY_DATA_PATH: '/srv/redman',
			REDMAN_DEPLOY_STORAGE_PATH: '/srv/redman-backups',
			REDMAN_DEPLOY_MEDIA_PATH: '/media',
			REDMAN_DEPLOY_WEB_BIND: webBind,
			REDMAN_DEPLOY_PEER_BIND: '192.168.1.20',
		},
	});
	assert.equal(unsafeWebBind.status, 2);
	assert.match(unsafeWebBind.stderr, /web bind|Web bind/);
}

for (const peerBind of ['0.0.0.0', '8.8.8.8']) {
	const unsafeBind = spawnSync('bash', [resolve(root, 'deploy.sh'), '--custom', '--print-config'], {
		encoding: 'utf8',
		env: {
			...process.env,
			REDMAN_DEPLOY_SSH: 'admin@nas.example',
			REDMAN_DEPLOY_SOURCE_PATH: '/srv/redman-src',
			REDMAN_DEPLOY_DATA_PATH: '/srv/redman',
			REDMAN_DEPLOY_STORAGE_PATH: '/srv/redman-backups',
			REDMAN_DEPLOY_MEDIA_PATH: '/media',
			REDMAN_DEPLOY_PEER_BIND: peerBind,
		},
	});
	assert.equal(unsafeBind.status, 2);
	assert.match(unsafeBind.stderr, /private IPv4|private RFC1918 or CGNAT/);
}

const maliciousTimezone = spawnSync('bash', [resolve(root, 'deploy.sh'), '--custom', '--print-config'], {
	encoding: 'utf8',
	env: {
		...process.env,
		REDMAN_DEPLOY_SSH: 'admin@nas.example',
		REDMAN_DEPLOY_SOURCE_PATH: '/srv/redman-src',
		REDMAN_DEPLOY_DATA_PATH: '/srv/redman',
		REDMAN_DEPLOY_STORAGE_PATH: '/srv/redman-backups',
		REDMAN_DEPLOY_MEDIA_PATH: '/media',
		REDMAN_DEPLOY_PEER_BIND: '192.168.1.20',
		REDMAN_DEPLOY_TZ: "UTC'; touch /tmp/redman-injected; #",
	},
});
assert.equal(maliciousTimezone.status, 2);
assert.match(maliciousTimezone.stderr, /Invalid timezone/);

const profileDir = mkdtempSync(resolve(tmpdir(), 'redman-deploy-profile-'));
const profileFile = resolve(profileDir, 'profiles.sh');
writeFileSync(
	profileFile,
	`redman_deploy_profile() {
	case "$1" in
		greenfield)
			T_SSH="operator@nas.example"
			T_SRC="/opt/redman-src"
			T_DATA="/var/lib/redman"
			T_PORT="8080"
			T_WEB_BIND="127.0.0.1"
			T_PEER_API_PORT="8081"
			T_PEER_BIND="192.168.1.20"
			T_DOCKER=""
			T_SETUP_SCRIPT="setup-backup-user.sh"
			T_STORAGE_ROOTS="/srv/backups,/srv/media"
			T_MEDIA_ROOT="/srv/media"
			T_SHARE_CONFIG_DIR=""
			T_TZ="UTC"
			T_DOCKER_MONITORING="false"
			;;
		partial) T_SSH="operator@partial.example" ;;
		*) return 1 ;;
	esac
}
`,
);

try {
	const profileEnv = { ...process.env, REDMAN_DEPLOY_PROFILE_FILE: profileFile };
	const namedProfile = spawnSync('bash', [resolve(root, 'deploy.sh'), '--profile', 'greenfield', '--print-config'], {
		encoding: 'utf8',
		env: profileEnv,
	});
	assert.equal(namedProfile.status, 0, namedProfile.stderr);
	assert.match(namedProfile.stdout, /TARGET=greenfield/);
	assert.match(namedProfile.stdout, /SOURCE=\/opt\/redman-src/);
	assert.match(namedProfile.stdout, /STORAGE_ROOTS=\/srv\/backups,\/srv\/media/);

	const unknownProfile = spawnSync('bash', [resolve(root, 'deploy.sh'), '--profile', 'missing', '--print-config'], {
		encoding: 'utf8',
		env: profileEnv,
	});
	assert.equal(unknownProfile.status, 2);
	assert.match(unknownProfile.stdout + unknownProfile.stderr, /Unknown target profile: missing/);

	const partialAfterCustom = spawnSync(
		'bash',
		[resolve(root, 'deploy.sh'), '--custom', '--profile', 'partial', '--print-config'],
		{
			encoding: 'utf8',
			env: {
				...profileEnv,
				REDMAN_DEPLOY_SSH: 'admin@nas.example',
				REDMAN_DEPLOY_SOURCE_PATH: '/srv/redman-src',
				REDMAN_DEPLOY_DATA_PATH: '/srv/redman',
				REDMAN_DEPLOY_STORAGE_PATH: '/srv/redman-backups',
				REDMAN_DEPLOY_MEDIA_PATH: '/media',
				REDMAN_DEPLOY_PEER_BIND: '192.168.1.20',
			},
		},
	);
	assert.equal(partialAfterCustom.status, 2);
	assert.match(partialAfterCustom.stderr, /Invalid or missing deployment path for partial/);
} finally {
	rmSync(profileDir, { recursive: true, force: true });
}

assert.match(prePush, /--deploy requires --custom or --profile NAME/);
const implicitDeploy = spawnSync('bash', [resolve(root, 'pre-push.sh'), '--deploy'], { encoding: 'utf8' });
assert.equal(implicitDeploy.status, 2);
assert.match(implicitDeploy.stderr, /requires --custom or --profile/);
console.log('Authentication deployment: exact trust/origin required, mode preserved, and no admin auto-provision default passed');
