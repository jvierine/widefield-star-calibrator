# AIDA Rust API deployment

Build the locked release binary with:

```sh
cargo build --locked --release
```

Install `target/release/aida-calibrator-server` at the path used by the
appropriate unit file, install the unit, run `systemctl daemon-reload`, and
restart the service. The server exposes `/healthz` for local health checks.

The Apache configuration does not change: it continues to proxy
`/api/test-cases` to the loopback port. Keep the previous unit and executable
until list, detail, image, and upload checks have passed after deployment.
