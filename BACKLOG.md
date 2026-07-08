# RedMan — Backlog

## SSH / Connectivity

- [ ] **Auto-diagnose SSH AllowUsers issues during pairing**
  When pairing with a remote peer, RedMan connects as `root` via SSH for rsync.
  If the remote's `sshd_config` has `AllowUsers` without `root`, the connection silently fails with `Connection closed by <ip> port 22`.
  RedMan should detect this during the pairing test / connection test and surface a clear error message (e.g. "root is not in AllowUsers on the remote host") instead of a generic rsync error 255.
  Ideally, offer a one-click fix via the peer API that adds `root` to `AllowUsers` and restarts sshd (with boot persistence on Unraid).
