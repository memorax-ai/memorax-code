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
  - `closed: not seen since <date> over 10 runs`: closed under the closing
    rule below, where `<date>` is the date of the last sighting.

  The closing rule counts the runs in which the signature's cell passed:
  - The cell is the family of jobs with the signature's client, OS, Node.js
    major, and channel, whatever the client version. For a signature whose
    job ran no step, such as S2, the cell is every job on that OS.
  - A counted run is an attempt of a run of this workflow, from any event
    (pull request, push, schedule, or dispatch), in which a job of the cell
    passed. Attempts of one run count separately, and each attempt counts at
    most once. A job that a later attempt carries over without running it
    again does not count again.
  - Counting starts with the first attempt created after the attempt of the
    last sighting. An attempt with a sighting does not count, and counting
    starts again after it. A failure of the cell with another signature
    neither counts nor restarts the count.
  - After 10 counted runs, a signature that is `open`, `observing #PR`, or
    `mitigated #PR` is closed, and its Rechecks end with the counting basis,
    the first and tenth counted runs, and the date of the count. Until then,
    Rechecks may record the current count and its date.
  - For `mitigated #PR`, counting starts no earlier than the merge of that
    pull request. A pass through the mitigation, such as S1's
    `removed_on_retry`, is recorded in Rechecks; it is not a sighting and
    does not prevent closing.
  - For `deferred <version>`, only runs of the cell on a version that is not
    deferred count, and the signature can close only after its version
    leaves the `deferred` list.
  - A closed signature that recurs reopens: its status returns to `open`,
    the new sighting is appended to Later sightings, and First seen stays
    unchanged.

## Register

| ID | Signature | Category | First seen | Later sightings | Rechecks | Status |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | `codex\|windows-2025\|24\|accepted`; cleanup stage `directory_removal`: `CLEANUP_DIRECTORY_REMOVAL_FAILED` (`EBUSY` on the isolated `.codex` directory) | `cleanup` | Run 40692096815 attempt 1, `Codex accepted 0.165.0 (windows-2025, Node 24)`, 2026-10-28 (#238) | Same signature recurred in run 40815143686 attempt 2, same job name, 2026-10-29 (#239), during the job-level recheck of that run's first failure (see [Earlier Signatures](#earlier-signatures)); in run 40853420771 attempt 1, `Codex latest 0.165.0 (windows-2025, Node 24)`, 2026-10-29 (compatibility monitor; the same Codex version on the latest channel); and in run 41223111032 attempt 1, `Codex accepted 0.165.0 (windows-2025, Node 24)`, 2026-10-31 (#249). In that attempt, the removal observation added by #242 recorded: the single removal of the isolated root failed with `EBUSY` after 4 ms, with 755 entries under the `.codex` directory; process queries from 503 ms to 2274 ms and from 2274 ms to 2993 ms after the failure found no process created since the smoke started still alive; the same removal, probed again 1006 ms after the failure, succeeded; and the Defender real-time protection status read timed out (artifact `native-evidence-codex-windows-2025-accepted-node-24-attempt1`) | Run 41223111032 attempt 2, a single authorized job-level recheck, passed: not reproduced in attempt 2, where the removal returned on its single attempt after 595 ms and the observation did not run; root cause undetermined, and the attempt 1 sighting stays on record. Not reproduced in the experiment's planned full reruns of run 40692096815 (attempts 2 and 3). Since #251, merged as febc685b on 2026-11-01, the cleanup passes when one of the removal probes removes the directory and neither process query finds a live process created since the smoke started; such a pass records `removed_on_retry` and a `Codex cleanup` warning, and any other outcome keeps this signature. S1 was not reproduced in that pull request's own run 41272269939 attempt 1, so that run did not exercise the retry. Closing-rule count on 2026-11-01 for jobs `Codex accepted <version> (windows-2025, Node 24)` since #251 merged: 0 counted runs; the cell has not run since then. | `mitigated #251` |
| S2 | `codebuddy\|macos-15\|24\|accepted`; no step ran: the job was not acquired by a hosted runner and was cancelled | `environment` | Run 40692096815 attempt 3, `CodeBuddy functional accepted 2.177.1 (macos-15, Node 24)`, 2026-10-28 (#238) | Same signature recurred on a `cursor` cell in run 40905164506 attempt 1, `Cursor App accepted 3.27.22 (macos-15, Node 24)`, 2026-10-29 (#241) | The first sighting was not rerun. Run 40905164506 attempt 2, a single authorized re-run of the failed jobs, passed the Cursor App cell. Closing-rule count on 2026-11-01 over every job on `macos-15`: 11 counted runs, from run 40905164506 attempt 2 to run 41272269939 attempt 1; the tenth was run 41223111032 attempt 1, so the signature is closed. | `closed: not seen since 2026-10-29 over 10 runs` |
| S3 | `cursor\|windows-2025\|24\|baseline`; stage `windows-acquisition`: `CURSOR_APP_WINDOWS_ARTIFACT_DOWNLOAD` | `environment` | Run 40905164506 attempt 1, `Cursor App baseline 3.21.18 (windows-2025, Node 24)`, 2026-10-29 (#241) | None | Run 40905164506 attempt 2, the same re-run, passed: first failure, single recheck passed, root cause undetermined. Closing-rule count on 2026-11-01 for jobs `Cursor App baseline <version> (windows-2025, Node 24)`: 11 counted runs, from run 40905164506 attempt 2 to run 41297371104 attempt 1; the tenth was run 41289676112 attempt 1, so the signature is closed. S4's failure in run 41017240796 attempt 1 neither counts nor restarts the count. | `closed: not seen since 2026-10-29 over 10 runs` |
| S4 | `cursor\|windows-2025\|24\|baseline`; stage `workspace-switch`: `CURSOR_APP_WINDOWS_APP_STOP_EXIT_255` | `functional` | Run 41017240796 attempt 1, `Cursor App baseline 3.21.18 (windows-2025, Node 24)`, 2026-10-30 (#243) | None | Run 41017240796 attempt 2, a single authorized job-level recheck, passed: first failure, single recheck passed, root cause undetermined. Closing-rule count on 2026-11-01 for jobs `Cursor App baseline <version> (windows-2025, Node 24)`: 10 counted runs, from run 41017240796 attempt 2 to run 41297371104 attempt 1; the tenth was run 41297371104 attempt 1, so the signature is closed. | `closed: not seen since 2026-10-30 over 10 runs` |
| S5 | `workbuddy\|macos-15\|24\|latest`; step "Open the verified archive and validate the official application": `AssertionError`, the bundled `cli/package.json` has no `publishConfig.customPackage.name` | `client-release` | Run 40623666188 attempt 2, `WorkBuddy native (macos-15, Node 24, latest, 5.9.3.42398134)`, 2026-10-28 (#235) | Same signature recurred in run 40623661565 attempt 2, same job name, 2026-10-28 (#236); in run 40853420771 attempt 1, same job name, 2026-10-29 (compatibility monitor); in run 41037250868 attempt 1, same job name, 2026-10-30 (compatibility monitor); in run 41189360166 attempt 1, same job name, 2026-10-31 (compatibility monitor); and in run 41297371104 attempt 1, same job name, 2026-11-01 (compatibility monitor). Since #254, merged as f9b6d2dc on 2026-11-01, a failure of this deferred cell no longer fails a compatibility monitor run: in run 41297371104 attempt 1 the job still concluded `failure`, the run concluded `success`, and `WorkBuddy functional result (compatibility monitor)` listed the cell as a `client-release-deferred` notice. | None | `deferred 5.9.3.42398134` |
| S6 | `workbuddy\|windows-2025\|24\|latest`; step "Acquire and extract the signed official Windows package": `WORKBUDDY_BUNDLE_LAYOUT_INVALID` | `client-release` | Run 40623661565 attempt 2, `WorkBuddy native (windows-2025, Node 24, latest, 5.9.3.42398134)`, 2026-10-28 (#236) | Same signature recurred in run 40623666188 attempt 2, same job name, 2026-10-28 (#235); in run 40853420771 attempt 1, same job name, 2026-10-29 (compatibility monitor); in run 41037250868 attempt 1, same job name, 2026-10-30 (compatibility monitor); in run 41189360166 attempt 1, same job name, 2026-10-31 (compatibility monitor); and in run 41297371104 attempt 1, same job name, 2026-11-01 (compatibility monitor). Since #254, merged as f9b6d2dc on 2026-11-01, a failure of this deferred cell no longer fails a compatibility monitor run: in run 41297371104 attempt 1 the job still concluded `failure`, the run concluded `success`, and `WorkBuddy functional result (compatibility monitor)` listed the cell as a `client-release-deferred` notice. | None | `deferred 5.9.3.42398134` |

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
