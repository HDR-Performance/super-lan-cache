# Super Lan-Cache 0.1.3

This testing update makes live traffic and DNS setup easier to understand before starting a large download.

- Download activity is grouped into sessions by client and content, with a 10-second delivery rate, cache-hit share, request totals, and expandable request detail.
- Client IP addresses can be given friendly local names without changing DNS or cache identity.
- Services & DNS includes a read-only guided connection check for engine health, client resolver responses, selected cache routes, origin DNS, and recent traffic.
- Existing-cache inventory, depot metadata, measured resident content, reviewed cleanup, and persistent engine settings remain available.
- No password on fresh installs; optional password controls in Settings preserve existing protected installations.
- Optional setup-code pairing with Super Pi Hole, with service presets and reviewed DNS changes. Each app works independently.
- TrueNAS 25.10 x86-64 installer with a Web UI portal and an immutable image digest. Reuse existing cache/log paths and add manager storage; see docs/TRUENAS.md.

Release gates exercise the complete container, real HTTP MISS/HIT transfers and file indexing, alongside the unit/integration suite. Production predecessor validation used an existing multi-terabyte cache and real Steam transfers. A partial inventory is not a complete game/version catalog, and HTTPS content remains uncached.

This is a testing prerelease. Back up existing app definitions and snapshot persistent settings before upgrading. No Community catalog acceptance is implied.
