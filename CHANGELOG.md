# Changelog

All notable user-visible changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Release dates are npm publication dates, and versions follow this repository's pre-1.0 versioning policy documented in `AGENTS.md`.

## [Unreleased]

### Added

- None.

### Changed

- Moved the complete release history into this changelog and kept concise release indexes in the English and Chinese READMEs.

### Fixed

- None.

## [0.1.5] - 2026-08-04

### Added

- Added persistent, endpoint-specific server memory through `/remote config memory TEXT` and the `ssh_remote_control` `memory` action.
- Added automatic injection of that memory into every model request while the matching endpoint is the active remote workspace.

### Changed

- Server memory is removed from subsequent model requests when remote tool routing is disabled, including disconnect and tunnel-only mode.
- `/remote config` now shows the memory stored for each endpoint.

### Fixed

- None.

## [0.1.4] - 2026-07-31

### Added

- Added persistent endpoint notes through `/remote config note TEXT` and the `ssh_remote_control` `note` action.
- Added per-command timeout overrides through `/remote exec --timeout SECONDS` and the tool's `timeout` parameter.

### Changed

- Remote commands now default to a 30-second timeout and endpoint notes appear in status, connection, reconnection, and footer labels.
- Expanded the documentation around agent-first workflows, multi-server operation, background jobs, and tunnel mode.

### Fixed

- Fixed remote commands that could run without a deadline by enforcing GNU `timeout` remotely and a local fallback timer.
- Fixed timeout reporting for processes terminated with timeout-related exit codes 124 and 137.

## [0.1.3] - 2026-07-24

### Added

- Added configurable collapsed command previews with `/remote config display-lines N`, `/remote exec --lines N`, and the tool's `displayLines` parameter.
- Added expandable custom rendering for remote command results.

### Changed

- Remote command previews default to the last five visual lines while model-facing output remains limited to 2,000 lines or 50 KB.
- Oversized complete output is saved to a permission-restricted local temporary file.

### Fixed

- Fixed `/remote exec` truncating its notification to an arbitrary 4,000 characters without preserving or identifying the full output.

## [0.1.2] - 2026-07-24

### Added

- None.

### Changed

- Republished the 0.1.1 runtime as 0.1.2 to align npm package version metadata; there were no runtime code changes.

### Fixed

- None.

## [0.1.1] - 2026-07-24

### Added

- Added the shorter `/remote ssh USER@HOST [-p PORT]` connection command.

### Changed

- `/remote ssh` now saves, selects, and immediately connects to the endpoint instead of only storing it.

### Fixed

- Fixed help and error text that still instructed users to run the obsolete `/remote config ssh ssh ...` form.

## [0.1.0] - 2026-07-24

### Added

- Initial release with persistent multi-endpoint SSH workspaces and remote working directories.
- Added transparent routing for Pi's `read`, `write`, `edit`, `bash`, and user shell operations.
- Added SSH-agent/password authentication, interactive host-key verification, automatic reconnection, SFTP file access, bounded command output, and local TCP forwarding.

### Changed

- None.

### Fixed

- None.

[Unreleased]: https://github.com/petrichor20211/pi-ssh-remote/compare/v0.1.5...HEAD
[0.1.5]: https://github.com/petrichor20211/pi-ssh-remote/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/petrichor20211/pi-ssh-remote/releases/tag/v0.1.4
[0.1.3]: https://www.npmjs.com/package/pi-ssh-remote/v/0.1.3
[0.1.2]: https://www.npmjs.com/package/pi-ssh-remote/v/0.1.2
[0.1.1]: https://www.npmjs.com/package/pi-ssh-remote/v/0.1.1
[0.1.0]: https://www.npmjs.com/package/pi-ssh-remote/v/0.1.0
