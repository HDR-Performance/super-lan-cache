# Super Lan-Cache on TrueNAS

1. Download `super-lan-cache-truenas.yaml` from the [release](https://github.com/HDR-Performance/super-lan-cache/releases). The release file pins the tested image digest. The source template is `deploy/truenas.yaml`.
2. Create cache, logs and manager datasets. Replace the example `/mnt/tank/apps/super-lan-cache` paths and every `192.168.1.10` with your server address. Choose your cache allowance. New named datasets should be writable by the container; the entrypoint initializes ownership for the engine.
3. Ensure TCP 80 and 443 are free on the selected address, and move the TrueNAS administration UI to other ports if it currently owns them. Management uses TCP 20722. Do not remap content ports to arbitrary ports: download clients use standard HTTP/HTTPS ports. Expose the management port only to your trusted LAN.
4. Install via YAML with name `super-lan-cache`. Open **Web UI**. There is no default password. Settings can enable, change or disable password protection later.
5. Use Services & DNS to export rules for your own resolver, or pair optionally with [Super Pi Hole](https://github.com/HDR-Performance/super-pi-hole). Clients must use that DNS server. Engine origin resolvers must resolve real Internet addresses, so keep them separate from cache-routing DNS.

## Reusing an existing LanCache

Back up the existing Compose definition and snapshot the data. Update the **existing app** and preserve its content ports and mount paths. Do not start two caches on the same ports or write to one cache dataset from two engines. Mount the folder containing `CONFIGHASH` and `cache/` at `/data/cache`; retain logs at `/data/logs`; add a separate `/data/manager` dataset. This build retains the monolithic format, cache-key formula and 1 MiB slices. Incompatible `CONFIGHASH` settings must be reconciled; never remove the marker to force compatibility.

Inventory runs automatically. Large caches can take hours; indexed bytes remain partial until the scan finishes, while filesystem usage reports the whole volume. Requests continue during scanning. Depot names are metadata, not proof of a complete installed game. Settings saved in the GUI override corresponding startup defaults.

## Updates and rollback

Pull the next version before a maintenance window; snapshot manager/cache configuration and retain the previous image digest. Change the image in your existing app definition and keep all mounts. TrueNAS may recreate containers during app updates. Roll back the definition to the previous image and restore the manager snapshot if a future release changes its schema. Never delete datasets during an image rollback.

## Current TrueNAS installation model

TrueNAS 24.10 and later use Docker Compose. These packages target **TrueNAS 25.10 on x86-64**, matching the validated server. Older Kubernetes / Manage Catalogs / Add Catalog guides do not describe this installation route.

Use **Apps → Discover Apps → ⋮ → Install via YAML**. The app appears in Installed Applications and `x-portals` provides its **Web UI** button. No SSH helper or Docker socket is required by either application.

App icons are provided as editable SVG and 512px PNG under `branding/`, and are used in each application's web interface. TrueNAS's custom YAML editor has no supported icon field; a generic icon there does not mean installation failed. Do not patch NAS internal metadata files. For an official catalog icon and guided installation form, contribute a definition under `ix-dev/community/<app-name>` in `truenas/apps`: `app.yaml`, `ix_values.yaml`, `questions.yaml`, and rendered Compose templates. Reviewers arrange CDN hosting for icons. These repositories are application source releases, not an already accepted Community catalog. No upstream submission or catalog acceptance is claimed.

References: [TrueNAS 25.10 custom apps](https://www.truenas.com/docs/scale/25.10/scaleuireference/apps/installcustomappscreens/), [current contribution layout and icon requirements](https://github.com/truenas/apps/blob/master/CONTRIBUTIONS.md).
