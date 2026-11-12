# Seccomp Profile Attribution

`seccomp-profile.json` is derived from Microsoft Playwright v1.58.2's
[Docker seccomp profile](https://github.com/microsoft/playwright/blob/v1.58.2/utils/docker/seccomp_profile.json).
Playwright is licensed under the Apache License 2.0; its license text is
preserved in [LICENSE.playwright](LICENSE.playwright).

[Playwright's Docker documentation](https://playwright.dev/docs/docker#crawling-and-scraping)
identifies the profile as Docker's default seccomp profile with additional
`clone`, `setns`, and `unshare` permissions. The
[Moby project license](https://github.com/moby/moby/blob/master/LICENSE)
is also Apache License 2.0.

The local modification adds `chroot` to that existing namespace allowance and
updates its explanatory comment. The default-deny action and all other rules
are unchanged. The container still drops all capabilities and enables
`no-new-privileges`; no `--no-sandbox` or unconfined fallback is permitted.
Upstream and modified checksums are recorded in [provenance.json](provenance.json).

Cursor packages are not vendored. The launcher downloads fixed official
artifacts, verifies locally observed SHA-256 values, and extracts them only in
the disposable image. These observed hashes are not publisher-supplied hashes.
