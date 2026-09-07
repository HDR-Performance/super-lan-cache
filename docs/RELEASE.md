# Super Lan-Cache 0.1.2

Initial public release of the integrated cache engine and management app, renamed from the locally validated LanCache Control build.

- Original Super Lan-Cache branding and application icon.
- Live activity, existing-cache inventory, depot metadata, measured resident content, reviewed cleanup and persistent engine settings.
- No password on fresh installs; optional password controls in Settings preserve existing protected installations.
- Optional setup-code pairing with Super Pi Hole, with service presets and reviewed DNS changes. Each app works independently.
- TrueNAS 25.10 x86-64 installer with a Web UI portal and an immutable image digest. Reuse existing cache/log paths and add manager storage; see docs/TRUENAS.md.

Release gates exercise the complete container, real HTTP MISS/HIT transfers and file indexing, alongside the unit/integration suite. Production predecessor validation used an existing multi-terabyte cache and real Steam transfers. A partial inventory is not a complete game/version catalog, and HTTPS content remains uncached.

This is a testing prerelease. Back up existing app definitions and snapshot persistent settings before upgrading. No Community catalog acceptance is implied.
