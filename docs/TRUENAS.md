# Super Lan-Cache on TrueNAS

## Fresh TrueNAS install

1. Download `super-lan-cache-truenas.yaml` from the highest version on the [releases page](https://github.com/HDR-Performance/super-lan-cache/releases). Do not copy the source template for a normal install: the release file pins the tested image digest.
2. Create cache, logs and manager datasets. Replace the example `/mnt/tank/apps/super-lan-cache` paths and every `192.168.1.10` with your server address. Choose your cache allowance. New named datasets should be writable by the container; the entrypoint initializes ownership for the engine.
3. Ensure TCP 80 and 443 are free on the selected address, and move the TrueNAS administration UI to other ports if it currently owns them. Management uses TCP 20722. Do not remap content ports to arbitrary ports: download clients use standard HTTP/HTTPS ports. Expose the management port only to your trusted LAN.
4. Install via YAML with name `super-lan-cache`. Open **Web UI**. There is no default password. Settings can enable, change or disable password protection later.
5. Choose one DNS path under **Services & DNS**. Enable built-in DNS for a standalone setup, export rules for your own resolver, or pair optionally with [Super Pi Hole](https://github.com/HDR-Performance/super-pi-hole). Clients must use that DNS server. Engine origin resolvers must resolve real Internet addresses, so keep them separate from cache-routing DNS.

The built-in DNS sidecar starts disabled and uses host networking so it can bind the server's LAN address directly. If port 53 is already used, the GUI reports a conflict and the sidecar stays offline; it never stops the existing resolver. On a server already running Super Pi Hole, Pi-hole, AdGuard Home, or another DNS service, keep built-in DNS disabled. On a standalone server, enable it only after the GUI shows the correct listen address and independent upstream resolvers, then set the router's DHCP DNS server to that address.

## Upgrade an existing Super Lan-Cache app

These steps update an existing 0.1.x installation in place and preserve its cache, history, settings and password.

1. In TrueNAS, save a copy of the existing app YAML. Snapshot the manager dataset; snapshot the cache dataset too if space and snapshot policy permit.
2. Download `super-lan-cache-truenas.yaml` from the new release. Edit all three dataset source paths to match the existing app. Copy the existing server IP into both `GUI_CACHE_IP` entries, `GUI_PUBLIC_ORIGIN`, and the `x-portals` host. Retain the existing cache allowance, index memory, free-space reserve, retention and upstream resolver values.
3. Open the installed app's **Edit** screen and replace its YAML with the prepared release definition. Keep the same app name and the same cache, logs and manager paths. Applying the edit recreates the containers but does not delete those datasets.
4. Wait for the app to report Running. It now contains `lancache` and `lancache-dns`. Open **Web UI** and verify `/healthz` reports healthy. The library scan resumes against the existing files; no cache migration or deletion is required.
5. Built-in DNS remains disabled after the upgrade. Leave it disabled when Super Pi Hole or another resolver owns port 53. Enable it from **Services & DNS** only when this server will become the LAN DNS endpoint.

If the current app is the original upstream `lancachenet/monolithic` container rather than Super Lan-Cache, follow **Reusing an existing LanCache** below. Preserve the old app until Super Lan-Cache has scanned the mounted cache and served a verified test download; never run both engines against the same dataset at the same time.

## Reusing an existing LanCache

Back up the existing Compose definition and snapshot the data. Update the **existing app** and preserve its content ports and mount paths. Do not start two caches on the same ports or write to one cache dataset from two engines. Mount the folder containing `CONFIGHASH` and `cache/` at `/data/cache`; retain logs at `/data/logs`; add a separate `/data/manager` dataset. This build retains the monolithic format, cache-key formula and 1 MiB slices. Incompatible `CONFIGHASH` settings must be reconciled; never remove the marker to force compatibility.

Inventory runs automatically. Large caches can take hours; indexed bytes remain partial until the scan finishes, while filesystem usage reports the whole volume. Requests continue during scanning. Depot names are metadata, not proof of a complete installed game. Settings saved in the GUI override corresponding startup defaults.

## Updates and rollback

Use the installer attached to the release so both services use the tested immutable image digest. Update during a maintenance window; snapshot manager/cache configuration and retain the prior app YAML. TrueNAS may recreate containers during app updates. To roll back, restore the previous YAML/image digest and restore the manager snapshot only if required. Never delete datasets during an image rollback.

## Current TrueNAS installation model

TrueNAS 24.10 and later use Docker Compose. These packages target **TrueNAS 25.10 on x86-64**, matching the validated server. Older Kubernetes / Manage Catalogs / Add Catalog guides do not describe this installation route.

Use **Apps → Discover Apps → ⋮ → Install via YAML**. The app appears in Installed Applications and `x-portals` provides its **Web UI** button. No SSH helper or Docker socket is required by either application.

App icons are provided as editable SVG and 512px PNG under `branding/`, and are used in each application's web interface. TrueNAS's custom YAML editor has no supported icon field; a generic icon there does not mean installation failed. Do not patch NAS internal metadata files. For an official catalog icon and guided installation form, contribute a definition under `ix-dev/community/<app-name>` in `truenas/apps`: `app.yaml`, `ix_values.yaml`, `questions.yaml`, and rendered Compose templates. Reviewers arrange CDN hosting for icons. These repositories are application source releases, not an already accepted Community catalog. No upstream submission or catalog acceptance is claimed.

References: [TrueNAS 25.10 custom apps](https://www.truenas.com/docs/scale/25.10/scaleuireference/apps/installcustomappscreens/), [current contribution layout and icon requirements](https://github.com/truenas/apps/blob/master/CONTRIBUTIONS.md).
