# Copy this file to .redman-deploy-profiles.sh and customize it. The local file
# is gitignored. Never commit credentials or private infrastructure details.

redman_deploy_profile() {
  case "$1" in
    example-unraid)
      T_SSH="admin@nas.example"
      T_SRC="/mnt/user/appdata/redman-src"
      T_DATA="/mnt/user/appdata/redman"
      T_PORT="8090"
      T_WEB_BIND="${REDMAN_EXAMPLE_WEB_BIND:-127.0.0.1}"
      T_PEER_API_PORT="8091"
      T_PEER_BIND="${REDMAN_EXAMPLE_PEER_BIND:-}"
      T_DOCKER="sudo"
      T_AUTH_MODE="${REDMAN_EXAMPLE_AUTH_MODE:-local}"
      T_PUBLIC_ORIGIN="${REDMAN_EXAMPLE_PUBLIC_ORIGIN:-}"
      T_TRUSTED_PROXIES="${REDMAN_EXAMPLE_TRUSTED_PROXIES:-}"
      T_PEER_HOST="${REDMAN_EXAMPLE_PEER_HOST:-}"
      T_AUTO_PROVISION_ROLE=""
      T_BOOTSTRAP_TOKEN="${REDMAN_EXAMPLE_BOOTSTRAP_TOKEN:-}"
      T_BACKUP_ROOT_ARGS="--backup-root /mnt/user --backup-root /mnt/disks"
      T_EXTRA_VOLS="-v /boot/config/shares:/boot/config/shares:ro -v /mnt/user:/mnt/user -v /mnt/cache:/mnt/cache:ro -v /mnt/disks:/mnt/disks -v /mnt/user/appdata/redman/ssh-keys/authorized_keys:/host-ssh/authorized_keys"
      T_SETUP_SCRIPT="setup-unraid-backup-user.sh"
      T_STORAGE_ROOTS="/mnt/user,/mnt/cache,/mnt/disks"
      T_MEDIA_ROOT="/mnt/disks"
      T_SHARE_CONFIG_DIR="/boot/config/shares"
      T_TZ="UTC"
      T_DOCKER_MONITORING="false"
      ;;
    *) return 1 ;;
  esac
}