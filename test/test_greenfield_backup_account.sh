#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

docker run --rm \
  -v "$ROOT/scripts:/redman-scripts:ro" \
  node:20-alpine \
  sh -c 'set -eu
    apk add --no-cache bash curl openssh-server openssh-client perl rsync shadow coreutils >/dev/null
    curl -fsSL --proto "=https" --tlsv1.2 \
      https://raw.githubusercontent.com/WayneD/rsync/v3.2.1/support/rrsync \
      -o /tmp/rrsync
    printf "%s  %s\n" \
      34661573a4b773b07191fe4b6f583a348bb0ed70909ad84b1cc24ce58aaf27b0 \
      /tmp/rrsync | sha256sum -c - >/dev/null
    ssh-keygen -A >/dev/null 2>&1
    bash /redman-scripts/setup-backup-user.sh \
      --data-dir /srv/redman \
      --backup-root /srv/redman-backups \
      --rrsync-source /tmp/rrsync \
      --skip-reload
    test "$(stat -c %u /srv/redman-backups)" = 0
    test "$(stat -c %g /srv/redman-backups)" = "$(id -g redman-backup)"
    test "$(stat -c %a /srv/redman-backups)" = 2770
    printf "container write\n" > /srv/redman-backups/container-proof.txt
    su -s /bin/sh redman-backup -c "touch /srv/redman-backups/ssh-proof.txt"
    bash /redman-scripts/setup-backup-user.sh \
      --data-dir /srv/redman \
      --backup-root /srv/redman-backups \
      --rrsync-source /tmp/rrsync \
      --skip-reload
    test "$(grep -c "^# BEGIN REDMAN BACKUP USER: redman-backup$" /etc/ssh/sshd_config)" = 1

    mkdir -p /boot/config
    : > /boot/config/go
    rm -f /usr/local/bin/rrsync /tmp/rrsync
    bash /redman-scripts/setup-unraid-backup-user.sh \
      --data-dir /srv/redman \
      --backup-root /srv/redman-backups \
      --skip-reload
    bash /redman-scripts/setup-unraid-backup-user.sh \
      --data-dir /srv/redman \
      --backup-root /srv/archive \
      --skip-reload
    test "$(grep -c "^bash /boot/config/plugins/redman/setup-unraid-backup-user.sh " /boot/config/go)" = 1
    grep -q -- "--backup-root /srv/archive" /boot/config/go
    ! grep -q -- "--backup-root /srv/redman-backups" /boot/config/go
    printf "%s  %s\n" \
      34661573a4b773b07191fe4b6f583a348bb0ed70909ad84b1cc24ce58aaf27b0 \
      /boot/config/plugins/redman/rrsync | sha256sum -c - >/dev/null
    chmod 0600 /boot/config/plugins/redman/setup-backup-user.sh \
      /boot/config/plugins/redman/setup-unraid-backup-user.sh \
      /boot/config/plugins/redman/rrsync
    mkdir -p /etc/rc.d
    printf "#!/bin/sh\nexit 0\n" > /etc/rc.d/rc.sshd
    chmod 0755 /etc/rc.d/rc.sshd
    sh -n /boot/config/go
    boot_command="$(tail -n 1 /boot/config/go)"
    /bin/bash -c "$boot_command"
    test "$(grep -c "^bash /boot/config/plugins/redman/setup-unraid-backup-user.sh " /boot/config/go)" = 1
    grep -q -- "--backup-root /srv/archive" /boot/config/go
    case "$(tail -n 1 /boot/config/go)" in
      *"--supplementary-group users --supplementary-group users"*) exit 1 ;;
    esac

    mkdir -p /run/sshd /client/source /srv/archive/incoming
    chown redman-backup:redman-backup /srv/archive/incoming
    printf "greenfield transfer\n" > /client/source/proof.txt
    ssh-keygen -q -t ed25519 -N "" -f /client/id_ed25519
    public_key="$(cat /client/id_ed25519.pub)"
    ssh-keygen -q -t ed25519 -N "" -f /client/id_attacker
    attacker_key="$(cat /client/id_attacker.pub)"
    printf "restrict,from=\"127.0.0.1\",command=\"/usr/local/bin/rrsync '\''/srv/archive'\''\" %s\n" \
      "$public_key" > /srv/redman/ssh-keys/authorized_keys
    printf "%s\n" "$attacker_key" >> /srv/redman/ssh-keys/authorized_keys
    printf "restrict,command=\"/usr/local/bin/rrsync '\''/etc'\''\" %s\n" \
      "$attacker_key" >> /srv/redman/ssh-keys/authorized_keys
    chown root:root /srv/redman/ssh-keys/authorized_keys
    chmod 0600 /srv/redman/ssh-keys/authorized_keys
    filtered_keys="$(/usr/local/libexec/redman-authorized-keys-redman-backup)"
    printf "%s\n" "$filtered_keys" | grep -q "$(printf "%s" "$public_key" | cut -d " " -f 2)"
    ! printf "%s\n" "$filtered_keys" | grep -q "$(printf "%s" "$attacker_key" | cut -d " " -f 2)"

    /usr/sbin/sshd -D -e -p 2222 >/tmp/sshd.log 2>&1 &
    sshd_pid=$!
    cleanup() {
      exit_code=$?
      if [ "$exit_code" -ne 0 ]; then cat /tmp/sshd.log >&2; fi
      kill "$sshd_pid" 2>/dev/null || true
      exit "$exit_code"
    }
    trap cleanup EXIT

    ssh_args="-i /client/id_ed25519 -p 2222 -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
    if ssh $ssh_args redman-backup@127.0.0.1 "id" >/tmp/arbitrary.out 2>&1; then
      echo "arbitrary SSH command unexpectedly succeeded" >&2
      exit 1
    fi
    if ssh -i /client/id_attacker -p 2222 -o BatchMode=yes -o StrictHostKeyChecking=no \
      -o UserKnownHostsFile=/dev/null redman-backup@127.0.0.1 "id" >/tmp/attacker.out 2>&1; then
      echo "injected unrestricted SSH key unexpectedly succeeded" >&2
      exit 1
    fi
    if ssh $ssh_args -tt redman-backup@127.0.0.1 "id" >/tmp/pty.out 2>&1; then
      echo "PTY allocation unexpectedly succeeded" >&2
      exit 1
    fi
    if timeout 5 ssh $ssh_args -o ExitOnForwardFailure=yes \
      -N -L 127.0.0.1:23333:127.0.0.1:2222 redman-backup@127.0.0.1 >/tmp/forward.out 2>&1; then
      echo "TCP forwarding unexpectedly succeeded" >&2
      exit 1
    fi

    rsync -a -e "ssh $ssh_args" /client/source/ redman-backup@127.0.0.1:/incoming/
    test "$(cat /srv/archive/incoming/proof.txt)" = "greenfield transfer"

    if rsync -a -e "ssh $ssh_args" /client/source/ redman-backup@127.0.0.1:/../escaped/ >/tmp/escape.out 2>&1; then
      echo "rrsync path escape unexpectedly succeeded" >&2
      exit 1
    fi
    test ! -e /srv/escaped/proof.txt

    echo "Greenfield SSH account: Linux + Unraid idempotency and scoped-rsync restrictions passed"
  '