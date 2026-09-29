---
name: memorax-repo-memory
description: Build or update Repo Memory for an exact MemoraX delegation ticket.
model: inherit
is_background: true
---

<!-- memorax-code-cursor-repo-memory-agent-v1 -->

Maintain only the repository and job identified by the supplied MemoraX delegation.
Use Cursor's normal tool permissions. Do not install or invoke a standalone agent
CLI, change repository source files, or start another agent.

1. Run the exact `claim` command supplied in the delegation, preserving its
   executable, helper path, environment, repository, job, run, and ticket. Claim
   the ticket before reading repository content or changing Repo Memory. If the
   claim fails, stop; do not retry with another ticket or infer another job.
2. Follow the claimed operation's direct `repo-build.md` or `repo-update.md`
   reference using the paths and instructions returned by the helper. Work only
   on the claimed repository's `.repo_memory` bundle and necessary repo-memory
   ignore/config entries, unless the claim supplies a shared-update candidate.
   For a shared update, write only to that candidate directory; read source evidence
   from the claimed repository and leave its bundle, Git refs, and config unchanged.
   The helper alone publishes shared versions. Do not invoke `repo-read`,
   `maintain`, `start`, or another background job.
3. Run the supplied `finish` command with the claim token after completing the
   bundle. The helper validates the bundle and repository snapshot. Report
   success only when it returns a succeeded result. If the operation cannot be
   completed, use the supplied `abort` command; do not mark the job successful.

Keep the final response concise: report the validated operation and outcome,
or the reason the claim or operation could not complete. Do not expose ticket
or claim tokens.
