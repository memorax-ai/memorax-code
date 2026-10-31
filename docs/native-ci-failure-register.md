# Native CI Failure Register

This register lists the failure signatures of the
[native client functional workflow](../.github/workflows/macos-codex-install.yml):
where each first appeared, where the same signature recurred, how it was
rechecked, and its status. The rules for maintaining it are in the contributor
guide's [Native CI Failure Register](../CONTRIBUTING.md#native-ci-failure-register)
section.

Entries name runs, attempts, jobs, and artifacts only. Logs, reports, and input
records stay in the run's job logs and artifacts; local paths, credentials,
tokens, and transcripts are never recorded here. An entry records what was
observed, not a cause: equal signatures do not prove the same root cause.

The register was seeded on 2026-10-30 from every run of the workflow created
from 2026-10-26 to that date. Jobs cancelled at a maintainer's request, in
attempt 1 of runs 40623661565 and 40623666188, have no signature and are not
listed.

## Columns

- **Signature**: `client|os|node|channel`, followed by the stage or step and
  the code that failed. Clients use the scope names `codex`, `opencode`,
  `claude`, `codebuddy`, `cursor`, and `workbuddy`.
- **Category**: where the failure surfaced. Except for `product`, a category
  does not name a cause.
  - `environment`: before the code under test ran, such as runner acquisition
    or a client installer download.
  - `cleanup`: teardown after the suite's checks.
  - `functional`: a stage of a functional suite.
  - `client-release`: a cell on a client's official latest release.
  - `product`: a MemoraX Code defect that the evidence shows.
- **First seen**: the run ID, attempt, job name, and UTC date of the first
  failure. It stays on record when a later recheck passes.
- **Later sightings**: runs in which the same signature recurred.
- **Rechecks**: job-level rechecks of the failure and their results.
- **Status**: one of
  - `open`: registered, with nothing in place for it;
  - `observing #PR`: the pull request added observation for the next
    occurrence;
  - `mitigated #PR`: the pull request changed the harness or the product for
    this signature;
  - `deferred <version>`: the client version is held back in the `deferred`
    list of the [client acceptance manifest](../scripts/ci/shared/client-acceptance.json);
  - `closed: not seen since <date> over N runs`.

## Register

| ID | Signature | Category | First seen | Later sightings | Rechecks | Status |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | `codex\|windows-2025\|24\|accepted`; cleanup stage `directory_removal`: `CLEANUP_DIRECTORY_REMOVAL_FAILED` (`EBUSY` on the isolated `.codex` directory) | `cleanup` | Run 40692096815 attempt 1, `Codex accepted 0.165.0 (windows-2025, Node 24)`, 2026-10-28 (#238) | Same signature recurred in run 40815143686 attempt 2, same job name, 2026-10-29 (#239), during the job-level recheck of that run's first failure (see [Earlier Signatures](#earlier-signatures)); and in run 40853420771 attempt 1, `Codex latest 0.165.0 (windows-2025, Node 24)`, 2026-10-29 (compatibility monitor; the same Codex version on the latest channel) | None. Not reproduced in the experiment's planned full reruns of run 40692096815 (attempts 2 and 3). | `observing #242` |
| S2 | `codebuddy\|macos-15\|24\|accepted`; no step ran: the job was not acquired by a hosted runner and was cancelled | `environment` | Run 40692096815 attempt 3, `CodeBuddy functional accepted 2.177.1 (macos-15, Node 24)`, 2026-10-28 (#238) | Same signature recurred on a `cursor` cell in run 40905164506 attempt 1, `Cursor App accepted 3.27.22 (macos-15, Node 24)`, 2026-10-29 (#241) | The first sighting was not rerun. Run 40905164506 attempt 2, a single authorized re-run of the failed jobs, passed the Cursor App cell. | `open` |
| S3 | `cursor\|windows-2025\|24\|baseline`; stage `windows-acquisition`: `CURSOR_APP_WINDOWS_ARTIFACT_DOWNLOAD` | `environment` | Run 40905164506 attempt 1, `Cursor App baseline 3.21.18 (windows-2025, Node 24)`, 2026-10-29 (#241) | None | Run 40905164506 attempt 2, the same re-run, passed: first failure, single recheck passed, root cause undetermined. | `open` |
| S4 | `cursor\|windows-2025\|24\|baseline`; stage `workspace-switch`: `CURSOR_APP_WINDOWS_APP_STOP_EXIT_255` | `functional` | Run 41017240796 attempt 1, `Cursor App baseline 3.21.18 (windows-2025, Node 24)`, 2026-10-30 (#243) | None | Run 41017240796 attempt 2, a single authorized job-level recheck, passed: first failure, single recheck passed, root cause undetermined. | `open` |
| S5 | `workbuddy\|macos-15\|24\|latest`; step "Open the verified archive and validate the official application": `AssertionError`, the bundled `cli/package.json` has no `publishConfig.customPackage.name` | `client-release` | Run 40623666188 attempt 2, `WorkBuddy native (macos-15, Node 24, latest, 5.9.3.42398134)`, 2026-10-28 (#235) | Same signature recurred in run 40623661565 attempt 2, same job name, 2026-10-28 (#236); in run 40853420771 attempt 1, same job name, 2026-10-29 (compatibility monitor); in run 41037250868 attempt 1, same job name, 2026-10-30 (compatibility monitor); and in run 41189360166 attempt 1, same job name, 2026-10-31 (compatibility monitor) | None | `deferred 5.9.3.42398134` |
| S6 | `workbuddy\|windows-2025\|24\|latest`; step "Acquire and extract the signed official Windows package": `WORKBUDDY_BUNDLE_LAYOUT_INVALID` | `client-release` | Run 40623661565 attempt 2, `WorkBuddy native (windows-2025, Node 24, latest, 5.9.3.42398134)`, 2026-10-28 (#236) | Same signature recurred in run 40623666188 attempt 2, same job name, 2026-10-28 (#235); in run 40853420771 attempt 1, same job name, 2026-10-29 (compatibility monitor); in run 41037250868 attempt 1, same job name, 2026-10-30 (compatibility monitor); and in run 41189360166 attempt 1, same job name, 2026-10-31 (compatibility monitor) | None | `deferred 5.9.3.42398134` |

## Earlier Signatures

These signatures appeared before the register existed and are recorded by code
only.

| Code | Last seen | PR |
| --- | --- | --- |
| `CURSOR_APP_SKILL_HOOK_CONTEXT` at stage `agent-transport` | Run 40481976093 attempt 1, `Cursor App latest 3.27.14 (windows-2025, Node 24)`, 2026-10-27 | #236 |
| `SETUP_EXITED_BEFORE_INTERRUPTION_STAGE` | Run 40481976093 attempt 1, `CodeBuddy functional baseline 2.159.0 (windows-2025, Node 24)`, 2026-10-27 | #236 |
| `NATIVE_CODEBUDDY_TURN_FAILED` with `NATIVE_BASH_STDOUT_INVALID` | Run 40513022084 attempt 1, `WorkBuddy native (ubuntu-24.04, Node 20, baseline, 5.5.6.38337834)`, 2026-10-27 | #236 |
| `CURSOR_APP_WINDOWS_PROCESS_QUERY_TIMEOUT` at stage `workspace-switch` | Run 40623666188 attempt 2, `Cursor App baseline 3.21.18 (windows-2025, Node 24)`, 2026-10-28 | #235 |
| `BACKGROUND_JOB_DID_NOT_FINISH` | Run 40623666188 attempt 2, `Claude smoke baseline 2.1.277 (windows-2025, Node 24)`, 2026-10-28 | #235 |
| `CLEANUP_TRACKED_PROCESS_CHECK_FAILED`, after stage `stop and start` found an installation Backend process remaining after stop | Run 40815143686 attempt 1, `Codex accepted 0.165.0 (windows-2025, Node 24)`, 2026-10-29 | #239 |
