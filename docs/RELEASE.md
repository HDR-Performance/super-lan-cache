# Super Lan-Cache 0.1.4

This testing update adds an optional built-in DNS service so a standalone installation can work after one router DHCP DNS change.

Existing 0.1.x users can update the same TrueNAS app while retaining their cache, logs and manager datasets. The release installer adds the bundled `lancache-dns` sidecar, which starts disabled, and the documented upgrade checklist preserves all existing mounts and settings. Fresh installations use the attached digest-pinned `super-lan-cache-truenas.yaml` and open without a password.

- Built-in dnsmasq runs as a bundled sidecar and starts disabled. The web interface controls its listen address, independent upstream resolvers, and enabled cache services.
- The sidecar uses the same exact and wildcard service routes as the Super Pi Hole integration. It reports starting, running, stopped, stale, configuration-error, and port-conflict states without stopping another resolver.
- Super Pi Hole, Pi-hole, AdGuard Home, and other DNS servers remain supported. Leave built-in DNS off when another service owns port 53; caching, management, exports, and pairing continue to work independently.
- A review dialog is required before enabling or disabling DNS, and the interface shows the exact router DHCP address only after the service is running.
- Download activity is grouped into sessions by client and content, with a 10-second delivery rate, cache-hit share, request totals, and expandable request detail.
- Encrypted HTTPS pass-through is shown separately with client, service hostname, completed bytes, aggregate delivery rate, connection count, and an explicit `Not cached` state.
- Client IP addresses can be given friendly local names without changing DNS or cache identity.
- Services & DNS includes a read-only guided connection check for engine health, client resolver responses, selected cache routes, origin DNS, and recent traffic.
- Existing-cache inventory, depot metadata, measured resident content, reviewed cleanup, and persistent engine settings remain available.
- Cleanup previews remain compact for very large selections and no longer stop at 100,000 files. Confirmed removals stream verified files in batches, report progress, and keep the cache engine recovery checks.
- Resident byte and file totals are maintained incrementally, avoiding repeated multi-million-row totals during normal dashboard updates on large caches.
- Large cache indexing is recovered after an interrupted restart, deferred while downloads are active, and scheduled only after verified idle time. Buffered access-log ingestion keeps the API responsive during high request volume.
- Settings report the CPU and memory exposed by the container so TrueNAS resource limits and NGINX worker/index-memory settings are easier to assess.
- No password on fresh installs; optional password controls in Settings preserve existing protected installations.
- Optional setup-code pairing with Super Pi Hole, with service presets and reviewed DNS changes. Each app works independently.
- TrueNAS 25.10 x86-64 installer with a Web UI portal and a shared manager dataset for the cache and DNS sidecar. Reuse existing cache/log paths and add manager storage; see docs/TRUENAS.md.

Release gates exercise the complete container, real HTTP MISS/HIT transfers and file indexing, alongside the unit/integration suite. Production predecessor validation used an existing multi-terabyte cache and real Steam transfers. A partial inventory is not a complete game/version catalog, and HTTPS content remains uncached.

This is a testing prerelease. Back up existing app definitions and snapshot persistent settings before upgrading. No Community catalog acceptance is implied.
