#!/usr/bin/env bash
set -euo pipefail

# Collects disk health on the host and writes it where RedMan can read it.
#
# RedMan runs with cap_drop ALL and no device access, so it cannot read SMART
# itself and should not be given the privileges to try. The host already can.

SCRIPT_NAME="$(basename "$0")"
DATA_DIR=""
OUTPUT_NAME="host-storage-health.json"
WAKE_SLEEPING=false
# Unions and mounted foreign disks are not pools and have no members of their own.
SKIP_MOUNTS_RE='^/mnt/(user|user0|disks|remotes|addons|rootshare)'

usage() {
  cat <<'EOF'
Usage: collect-storage-health.sh --data-dir PATH [options]

Writes a JSON snapshot of local disk and pool health for RedMan to read.
Run as root from cron; RedMan never invokes it.

Options:
  --data-dir PATH   RedMan data directory to write into (required)
  --output NAME     File name within --data-dir (default: host-storage-health.json)
  --wake            Read attributes even from disks that are spun down
  --help            Show this help

Without --wake a sleeping disk keeps its previous reading, marked stale, so
collection never becomes the reason an array stops idling.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --data-dir) DATA_DIR="${2:-}"; shift 2 ;;
    --output) OUTPUT_NAME="${2:-}"; shift 2 ;;
    --wake) WAKE_SLEEPING=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "$SCRIPT_NAME: unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$DATA_DIR" ]] || { echo "$SCRIPT_NAME: --data-dir is required" >&2; exit 2; }
[[ -d "$DATA_DIR" ]] || { echo "$SCRIPT_NAME: no such directory: $DATA_DIR" >&2; exit 2; }

for tool in smartctl jq lsblk findmnt; do
  command -v "$tool" >/dev/null || { echo "$SCRIPT_NAME: missing required tool: $tool" >&2; exit 2; }
done

OUTPUT="$DATA_DIR/$OUTPUT_NAME"
PREVIOUS="$(cat "$OUTPUT" 2>/dev/null || echo '{}')"
jq -e . >/dev/null 2>&1 <<<"$PREVIOUS" || PREVIOUS='{}'

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STARTED_EPOCH="$(date +%s)"

# The flash device holds /boot and answers no SMART; reporting it as unreadable
# would be a permanent false alarm.
flash_disk() {
  local src
  src="$(findmnt -no SOURCE /boot 2>/dev/null || true)"
  [[ -n "$src" ]] || return 0
  lsblk -no PKNAME "$src" 2>/dev/null | head -1
}
FLASH_DISK="$(flash_disk || true)"

previous_device() {
  jq -c --arg dev "$1" '(.devices // []) | map(select(.device == $dev)) | first // empty' <<<"$PREVIOUS"
}

# Reports facts; the verdict a destination gets is decided from these, not here.
collect_device() {
  local disk="$1" name="${1#/dev/}"
  local standby_flag=() raw rc=0 transport

  transport="$(lsblk -dno TRAN "$disk" 2>/dev/null | tr -d ' ' || true)"
  $WAKE_SLEEPING || standby_flag=(-n standby)

  raw="$(smartctl -j "${standby_flag[@]+"${standby_flag[@]}"}" -H -A -i "$disk" 2>/dev/null)" || rc=$?
  if ! jq -e . >/dev/null 2>&1 <<<"$raw"; then
    jq -n --arg device "$disk" --arg name "$name" --arg transport "$transport" \
      '{device:$device, name:$name, transport:$transport, state:"unknown", reason:"smartctl produced no usable output"}'
    return
  fi

  local asleep="false"
  if jq -e '[.smartctl.messages[]?.string // ""] | any(test("STANDBY|SLEEP"; "i"))' >/dev/null 2>&1 <<<"$raw"; then
    asleep="true"
  fi

  # An enclosure that will not pass SMART through has nothing to measure, which
  # is a different thing from a measurement we failed to take.
  if jq -e '[.smartctl.messages[]?.string // ""] | any(test("unknown usb bridge|specify device type|does not support smart|smart support is: +unavailable"; "i"))' >/dev/null 2>&1 <<<"$raw"; then
    jq -n --arg device "$disk" --arg name "$name" --arg transport "$transport" --arg at "$STARTED_AT" \
      '{device:$device, name:$name, transport:$transport, observedAt:$at, stale:false, state:"unsupported",
        reason:"this device does not pass SMART through its enclosure, so its health cannot be read"}'
    return
  fi

  # A disk that is merely asleep is not a disk in trouble: keep what we knew.
  if [[ "$asleep" == "true" ]]; then
    local prev
    prev="$(previous_device "$disk")"
    if [[ -n "$prev" ]]; then
      jq -c --arg at "$STARTED_AT" \
        '. + {stale:true, staleReason:"disk was spun down", observedAt:(.observedAt // $at)}' <<<"$prev"
    else
      jq -n --arg device "$disk" --arg name "$name" --arg transport "$transport" \
        '{device:$device, name:$name, transport:$transport, state:"unknown", reason:"disk was spun down and has no earlier reading", stale:true}'
    fi
    return
  fi

  jq -c \
    --arg device "$disk" \
    --arg name "$name" \
    --arg transport "$transport" \
    --arg at "$STARTED_AT" \
    --argjson exit "$rc" '
    def attr($id): (.ata_smart_attributes.table // []) | map(select(.id == $id)) | (first | .raw.value) // null;
    def nvme: .nvme_smart_health_information_log // {};

    (if .device.protocol == "NVMe" then "nvme" else "ata" end) as $kind
    | (if $kind == "nvme"
        then {
          criticalWarning: (nvme.critical_warning // null),
          percentageUsed:  (nvme.percentage_used // null),
          availableSpare:  (nvme.available_spare // null),
          spareThreshold:  (nvme.available_spare_threshold // null),
          mediaErrors:     (nvme.media_errors // null),
          unsafeShutdowns: (nvme.unsafe_shutdowns // null),
          temperature:     (nvme.temperature // null)
        }
        else {
          reallocatedSectors: attr(5),
          pendingSectors:     attr(197),
          offlineUncorrectable: attr(198),
          crcErrors:          attr(199),
          temperature:        (.temperature.current // null),
          powerOnHours:       (.power_on_time.hours // null)
        }
      end) as $a

    | (.smart_status.passed) as $passed
    | (if $passed == false then {state:"fail", reason:"the drive reports its own SMART health as failed"}
       elif $kind == "nvme" and ($a.criticalWarning // 0) != 0
         then {state:"fail", reason:"the drive raised an NVMe critical warning"}
       elif $kind == "nvme" and $a.availableSpare != null and $a.spareThreshold != null and $a.availableSpare <= $a.spareThreshold
         then {state:"fail", reason:"spare blocks fell to the threshold the drive itself considers critical"}
       elif $kind == "nvme" and ($a.mediaErrors // 0) > 0
         then {state:"warn", reason:"the drive logged media or data integrity errors"}
       elif $kind == "nvme" and ($a.percentageUsed // 0) >= 90
         then {state:"warn", reason:"the drive is near the end of its rated write endurance"}
       elif $kind == "ata" and (($a.reallocatedSectors // 0) > 0 or ($a.pendingSectors // 0) > 0 or ($a.offlineUncorrectable // 0) > 0)
         then {state:"warn", reason:"the drive has reallocated, pending or uncorrectable sectors"}
       elif $kind == "ata" and ($a.crcErrors // 0) > 0
         then {state:"warn", reason:"interface CRC errors, which usually means the cable rather than the disk"}
       elif $passed == true then {state:"ok", reason:null}
       else {state:"unknown", reason:"the drive did not report an overall health status"}
      end) as $verdict

    | {
        device: $device,
        name: $name,
        transport: $transport,
        kind: $kind,
        model: (.model_name // null),
        serial: (.serial_number // null),
        observedAt: $at,
        stale: false,
        exitStatus: $exit,
        attributes: $a
      } + $verdict
  ' <<<"$raw"
}

btrfs_profile() {
  btrfs filesystem df "$1" 2>/dev/null | sed -n "s/^$2, \([A-Za-z0-9]*\):.*/\1/p" | head -1
}

btrfs_members() {
  btrfs filesystem show "$1" 2>/dev/null | awk '/devid/ {print $NF}' | while read -r part; do
    local parent
    parent="$(lsblk -no PKNAME "$part" 2>/dev/null | head -1)"
    [[ -n "$parent" ]] && echo "/dev/$parent"
  done
}

DEVICE_JSON="[]"
declare -a DISKS=()
while read -r disk; do
  [[ -n "$disk" ]] || continue
  [[ "$disk" == "$FLASH_DISK" ]] && continue
  DISKS+=("/dev/$disk")
done < <(lsblk -dno NAME,TYPE | awk '$2 == "disk" {print $1}' | grep -Ev '^(loop|zram|ram)' || true)

for disk in "${DISKS[@]+"${DISKS[@]}"}"; do
  entry="$(collect_device "$disk")"
  DEVICE_JSON="$(jq -c --argjson e "$entry" '. + [$e]' <<<"$DEVICE_JSON")"
done

POOL_JSON="[]"
while read -r target fstype; do
  [[ -n "$target" ]] || continue
  # A pool is exactly /mnt/<name>; anything deeper is a subvolume or a foreign disk.
  [[ "$target" =~ ^/mnt/[^/]+$ ]] || continue
  [[ "$target" =~ $SKIP_MOUNTS_RE ]] && continue

  members="[]"
  data_profile=""
  meta_profile=""
  if [[ "$fstype" == "btrfs" ]]; then
    data_profile="$(btrfs_profile "$target" Data || true)"
    meta_profile="$(btrfs_profile "$target" Metadata || true)"
    while read -r member; do
      [[ -n "$member" ]] || continue
      members="$(jq -c --arg m "$member" '. + [$m]' <<<"$members")"
    done < <(btrfs_members "$target" || true)
  else
    src="$(findmnt -no SOURCE "$target" 2>/dev/null || true)"
    if [[ -b "$src" ]]; then
      parent="$(lsblk -no PKNAME "$src" 2>/dev/null | head -1)"
      [[ -n "$parent" ]] && members="$(jq -c --arg m "/dev/$parent" '. + [$m]' <<<"$members")"
    fi
  fi

  POOL_JSON="$(jq -c \
    --arg mount "$target" \
    --arg fstype "$fstype" \
    --arg data "$data_profile" \
    --arg meta "$meta_profile" \
    --argjson members "$members" \
    --argjson devices "$DEVICE_JSON" '
    ($data | ascii_upcase) as $d
    | (["RAID1","RAID10","RAID1C3","RAID1C4","RAID5","RAID6"] | index($d) != null) as $redundant
    | ($devices | map(select(.device as $x | $members | index($x) != null))) as $mine
    | (if ($mine | length) == 0 then "unknown"
       elif ($mine | map(.state) | index("fail")) != null then (if $redundant then "warn" else "fail" end)
       elif ($mine | map(.state) | index("warn")) != null then "warn"
       elif ($mine | map(.state) | index("unknown")) != null then "unknown"
       elif ($mine | map(.state) | index("unsupported")) != null then "unknown"
       else "ok" end) as $state
    | . + [{
        mount: $mount,
        fstype: $fstype,
        dataProfile: (if $data == "" then null else $data end),
        metadataProfile: (if $meta == "" then null else $meta end),
        redundant: $redundant,
        members: $members,
        state: $state
      }]
  ' <<<"$POOL_JSON")"
done < <(findmnt -rno TARGET,FSTYPE --real 2>/dev/null | sort -u || true)

TMP="$(mktemp "$OUTPUT.XXXXXX")"
trap 'rm -f "$TMP"' EXIT

# On Unraid a destination is written as /mnt/user/<share>, which is a union and
# not a pool. Resolving which pool actually holds it needs the share table, so
# it is done here rather than left to a reader that cannot see it.
SHARES_INI=/var/local/emhttp/shares.ini
SHARE_JSON="[]"
if [[ -r "$SHARES_INI" ]]; then
  SHARE_JSON="$(awk -F'=' '
    /^\["/ { if (name != "") emit(); name = $0; gsub(/[]["]/, "", name); use=""; pool=""; cfg=""; next }
    /^useCache=/  { use  = clean($2) }
    /^cachePool=/ { pool = clean($2) }
    /^hasCfg=/    { cfg  = clean($2) }
    END { if (name != "") emit() }
    function clean(v) { gsub(/"/, "", v); return v }
    function emit(  pinned) {
      pinned = (use == "only" && pool != "") ? "true" : "false"
      printf "%s\t%s\t%s\t%s\n", name, pool, pinned, cfg
    }
  ' "$SHARES_INI" | jq -R -s -c '
    [ split("\n")[] | select(length > 0) | split("\t")
      | { name: .[0],
          path: ("/mnt/user/" + .[0]),
          pool: (if .[1] == "" then null else "/mnt/" + .[1] end),
          pinned: (.[2] == "true"),
          configured: (.[3] == "yes") } ]
  ')"
fi

jq -n \
  --arg generatedAt "$STARTED_AT" \
  --arg host "$(hostname)" \
  --argjson durationMs "$(( ($(date +%s) - STARTED_EPOCH) * 1000 ))" \
  --argjson woke "$($WAKE_SLEEPING && echo true || echo false)" \
  --argjson devices "$DEVICE_JSON" \
  --argjson pools "$POOL_JSON" \
  --argjson shares "$SHARE_JSON" \
  '{schema:1, generatedAt:$generatedAt, host:$host, durationMs:$durationMs, wokeSleepingDisks:$woke, devices:$devices, pools:$pools, shares:$shares}' \
  > "$TMP"

chmod 0644 "$TMP"
mv -f "$TMP" "$OUTPUT"
trap - EXIT

echo "$SCRIPT_NAME: wrote $(jq -r '(.devices | length) as $d | (.pools | length) as $p | "\($d) device(s), \($p) pool(s)"' "$OUTPUT") to $OUTPUT"
