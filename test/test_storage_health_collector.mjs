// The collector's JSON is a contract the backend reads. If its shape or its
// verdicts drift, nothing errors — a destination just silently stops being
// judged, which is the one failure this feature exists to prevent.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'collect-storage-health.sh');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const ataHealthy = (serial, { realloc = 0, pending = 0, uncorrectable = 0, crc = 0, passedFlag = true } = {}) =>
  JSON.stringify({
    device: { protocol: 'ATA' },
    model_name: 'TEST-HDD',
    serial_number: serial,
    smart_status: { passed: passedFlag },
    temperature: { current: 38 },
    power_on_time: { hours: 1000 },
    ata_smart_attributes: {
      table: [
        { id: 5, name: 'Reallocated_Sector_Ct', raw: { value: realloc } },
        { id: 197, name: 'Current_Pending_Sector', raw: { value: pending } },
        { id: 198, name: 'Offline_Uncorrectable', raw: { value: uncorrectable } },
        { id: 199, name: 'UDMA_CRC_Error_Count', raw: { value: crc } },
      ],
    },
  });

const nvme = ({ percentageUsed = 1, spare = 100, threshold = 10, critical = 0, media = 0 } = {}) =>
  JSON.stringify({
    device: { protocol: 'NVMe' },
    model_name: 'TEST-NVME',
    serial_number: 'NV1',
    smart_status: { passed: true },
    nvme_smart_health_information_log: {
      critical_warning: critical,
      percentage_used: percentageUsed,
      available_spare: spare,
      available_spare_threshold: threshold,
      media_errors: media,
      unsafe_shutdowns: 3,
      temperature: 35,
    },
  });

const STANDBY = JSON.stringify({
  json_format_version: [1, 0],
  smartctl: { version: [7, 5], exit_status: 2, messages: [{ string: 'Device is in STANDBY mode, exit(2)' }] },
});

const USB_BRIDGE = JSON.stringify({
  json_format_version: [1, 0],
  smartctl: { exit_status: 1, messages: [{ string: '/dev/sdz: Unknown USB bridge [0x05e3:0x0749]' }] },
});

// Every host tool the script shells out to is replaced by a stub that answers
// from the scenario, so a test never depends on the machine it runs on.
function runCollector(scenario, { dataDir } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'redman-health-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const data = dataDir || join(root, 'data');
  mkdirSync(data, { recursive: true });

  const specPath = join(root, 'scenario.json');
  writeFileSync(specPath, JSON.stringify(scenario));

  const stub = (name, body) => {
    const p = join(bin, name);
    writeFileSync(p, `#!/usr/bin/env bash\nSPEC="${specPath}"\n${body}\n`);
    chmodSync(p, 0o755);
  };

  stub('smartctl', `
dev="\${@: -1}"
out="$(jq -r --arg d "$dev" '.devices[$d].output // empty' "$SPEC")"
code="$(jq -r --arg d "$dev" '.devices[$d].exit // 0' "$SPEC")"
[ -n "$out" ] && printf '%s' "$out"
exit "$code"
`);

  stub('lsblk', `
args="$*"
case "$args" in
  *PKNAME*) jq -r --arg p "\${@: -1}" '.parents[$p] // empty' "$SPEC" ;;
  *TRAN*)   jq -r --arg d "\${@: -1}" '.devices[$d].transport // "sata"' "$SPEC" ;;
  *NAME,TYPE*) jq -r '.devices | keys[] | sub("^/dev/"; "") + " disk"' "$SPEC" ;;
esac
`);

  stub('findmnt', `
args="$*"
case "$args" in
  *"--real"*) jq -r '.mounts | to_entries[] | "\\(.key) \\(.value.fstype)"' "$SPEC" ;;
  *"/boot"*)  jq -r '.flashSource // empty' "$SPEC" ;;
  *)          jq -r --arg t "\${@: -1}" '.mounts[$t].source // empty' "$SPEC" ;;
esac
`);

  stub('btrfs', `
mount="\${@: -1}"
case "$2" in
  df)   jq -r --arg m "$mount" '.mounts[$m] | "Data, \\(.data): total=1.00TiB, used=0.50TiB\\nMetadata, \\(.metadata // .data): total=1.00GiB, used=0.50GiB"' "$SPEC" ;;
  show) jq -r --arg m "$mount" '.mounts[$m].parts[]? | "\\tdevid 1 size 1.00TiB used 0.50TiB path " + .' "$SPEC" ;;
esac
`);

  execFileSync('bash', [SCRIPT, '--data-dir', data], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    stdio: 'pipe',
  });

  return {
    report: JSON.parse(readFileSync(join(data, 'host-storage-health.json'), 'utf8')),
    dataDir: data,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const pool = (report, mount) => report.pools.find(p => p.mount === mount);
const device = (report, dev) => report.devices.find(d => d.device === dev);

const twoDiskRaid1 = (a, b, profile = 'RAID1') => ({
  flashSource: '/dev/sdz1',
  devices: { '/dev/sda': { output: a }, '/dev/sdb': { output: b } },
  parents: { '/dev/sda1': 'sda', '/dev/sdb1': 'sdb' },
  mounts: { '/mnt/pool': { fstype: 'btrfs', data: profile, parts: ['/dev/sda1', '/dev/sdb1'] } },
});

check('a healthy redundant pool reads as ok', () => {
  const { report, cleanup } = runCollector(twoDiskRaid1(ataHealthy('A'), ataHealthy('B')));
  assert.equal(pool(report, '/mnt/pool').state, 'ok');
  assert.equal(pool(report, '/mnt/pool').redundant, true);
  assert.equal(device(report, '/dev/sda').state, 'ok');
  cleanup();
});

check('a failing member of a mirror is a warning, because the copy survives', () => {
  const scenario = twoDiskRaid1(ataHealthy('A', { passedFlag: false }), ataHealthy('B'));
  const { report, cleanup } = runCollector(scenario);
  assert.equal(device(report, '/dev/sda').state, 'fail');
  assert.equal(pool(report, '/mnt/pool').state, 'warn');
  cleanup();
});

check('the same failing disk without redundancy is not safe to write to', () => {
  const scenario = twoDiskRaid1(ataHealthy('A', { passedFlag: false }), ataHealthy('B'), 'single');
  const { report, cleanup } = runCollector(scenario);
  assert.equal(pool(report, '/mnt/pool').redundant, false);
  assert.equal(pool(report, '/mnt/pool').state, 'fail');
  cleanup();
});

check('reallocated or pending sectors warn before the drive admits failure', () => {
  const { report, cleanup } = runCollector(twoDiskRaid1(ataHealthy('A', { pending: 8 }), ataHealthy('B')));
  const d = device(report, '/dev/sda');
  assert.equal(d.state, 'warn');
  assert.match(d.reason, /pending|reallocated/i);
  assert.equal(d.attributes.pendingSectors, 8);
  cleanup();
});

check('a worn NVMe is warned about before its spare blocks run out', () => {
  const scenario = twoDiskRaid1(nvme({ percentageUsed: 95 }), ataHealthy('B'));
  const { report, cleanup } = runCollector(scenario);
  assert.equal(device(report, '/dev/sda').state, 'warn');
  assert.match(device(report, '/dev/sda').reason, /endurance/i);
  cleanup();
});

check('spare blocks at the drive-defined threshold are a failure, not a warning', () => {
  const scenario = twoDiskRaid1(nvme({ spare: 8, threshold: 10 }), ataHealthy('B'), 'single');
  const { report, cleanup } = runCollector(scenario);
  assert.equal(device(report, '/dev/sda').state, 'fail');
  assert.equal(pool(report, '/mnt/pool').state, 'fail');
  cleanup();
});

check('a disk behind an enclosure that hides SMART is unsupported, not failing', () => {
  const scenario = twoDiskRaid1(USB_BRIDGE, ataHealthy('B'));
  scenario.devices['/dev/sda'].exit = 1;
  const { report, cleanup } = runCollector(scenario);
  assert.equal(device(report, '/dev/sda').state, 'unsupported');
  cleanup();
});

check('a member whose health cannot be read is never reported as ok', () => {
  const scenario = twoDiskRaid1(USB_BRIDGE, ataHealthy('B'));
  scenario.devices['/dev/sda'].exit = 1;
  const { report, cleanup } = runCollector(scenario);
  assert.equal(pool(report, '/mnt/pool').state, 'unknown');
  cleanup();
});

check('a sleeping disk keeps what was last known instead of raising an alarm', () => {
  const first = runCollector(twoDiskRaid1(ataHealthy('A', { realloc: 3 }), ataHealthy('B')));
  assert.equal(device(first.report, '/dev/sda').attributes.reallocatedSectors, 3);

  const asleep = twoDiskRaid1(STANDBY, STANDBY);
  asleep.devices['/dev/sda'].exit = 2;
  asleep.devices['/dev/sdb'].exit = 2;
  const second = runCollector(asleep, { dataDir: first.dataDir });

  const d = device(second.report, '/dev/sda');
  assert.equal(d.stale, true);
  assert.equal(d.attributes.reallocatedSectors, 3);
  assert.equal(d.state, 'warn');
  assert.equal(pool(second.report, '/mnt/pool').state, 'warn');
  first.cleanup();
  second.cleanup();
});

check('a sleeping disk with nothing known yet is unknown, never healthy', () => {
  const asleep = twoDiskRaid1(STANDBY, STANDBY);
  asleep.devices['/dev/sda'].exit = 2;
  asleep.devices['/dev/sdb'].exit = 2;
  const { report, cleanup } = runCollector(asleep);
  assert.equal(device(report, '/dev/sda').state, 'unknown');
  assert.equal(pool(report, '/mnt/pool').state, 'unknown');
  cleanup();
});

check('the flash device is left out rather than reported as broken', () => {
  const scenario = twoDiskRaid1(ataHealthy('A'), ataHealthy('B'));
  scenario.devices['/dev/sdz'] = { output: USB_BRIDGE, exit: 1 };
  scenario.flashSource = '/dev/sdz1';
  scenario.parents['/dev/sdz1'] = 'sdz';
  const { report, cleanup } = runCollector(scenario);
  assert.equal(device(report, '/dev/sdz'), undefined);
  cleanup();
});

check('only real pools are reported, not subvolumes mounted beneath them', () => {
  const scenario = twoDiskRaid1(ataHealthy('A'), ataHealthy('B'));
  scenario.mounts['/mnt/pool/system/docker/btrfs'] = { fstype: 'btrfs', data: 'single', parts: ['/dev/sda1'] };
  scenario.mounts['/mnt/user'] = { fstype: 'fuse.shfs', data: 'single', parts: [] };
  const { report, cleanup } = runCollector(scenario);
  assert.deepEqual(report.pools.map(p => p.mount), ['/mnt/pool']);
  cleanup();
});

check('the report carries the shape the backend will read', () => {
  const { report, cleanup } = runCollector(twoDiskRaid1(ataHealthy('A'), ataHealthy('B')));
  assert.equal(report.schema, 1);
  assert.match(report.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(typeof report.host, 'string');
  assert.ok(Array.isArray(report.devices) && Array.isArray(report.pools));
  cleanup();
});

console.log(`\n${passed} storage health collector checks passed`);
