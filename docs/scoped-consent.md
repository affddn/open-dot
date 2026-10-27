# Scoped preview consent proposal

This patch adds an **offline proposal reviewer**, not an authorization service.
`open-dot policy review <file.json>` validates a proposal and an execution fixture before opening any database.
It never approves requests, writes grants, changes instructions, starts services, or executes the proposed operation.
Even a matching fixture returns `execution: "owner-required"`. Exit zero means only that the fixture fits the proposed scope.

## Why existing configuration is not enough

`src/requests.ts` exports the hardcoded `requestPolicy` used in fresh context and tool descriptions.
Its `prohibited` function recognizes merges, ready operations, deployments, and other off-limits actions.
Both `queueAnswer` and the daemon's `whyNot` call that guard.
Worker prose, owner quotes, and dot-written notes cannot override it.

The existing owner options are direct one-request approval in the worker's OpenCode session and editing the dot's instructions.
Instructions cannot override the runtime guard. Supervision deliberately reserves answers for the owner.
There is no owner-configurable scoped-consent store in this version.

[OpenCode V2 permissions](https://opencode.ai/v2/docs/permissions) already provide ordered action/resource rules.
Reuse those for technical execution checks rather than creating another shell allowlist.
Those rules alone do not establish fresh repository heads, the actual preview environment, or owner consent for a shared operation.
No broad shell allow is proposed here.

## Proposal shape

The policy is deliberately limited to `Orange-GameFi/orange-jam` and `feat/founder-loop`.
It names up to 12 unique aliases and stable target IDs, each bound to exactly one operation:
`ready`, `sharedmerge`, or `previewdeploy`.
Expiry is an epoch-millisecond timestamp or explicit `null` for no expiry.
Side effects are an explicit subset of `update-pr-draft-state`, `update-shared-branch`, and `replace-preview-artifact`.
Each intent must declare exactly its operation's one effect, and the policy must include that effect.

The review file contains exactly `policy`, `intent`, and `evidence`.
The intent contains exactly `repository`, `branch`, `operation`, `alias`, and `sideEffects`.
The evidence contains exactly `revision`, `revoked`, `environment`, `targetID`, `head`, `freshHead`, `targetHead`, and `freshTargetHead`.
Heads are full lowercase 40-character Git object IDs. This prototype does not support SHA-256 Git repositories.
The revision hashes the normalized policy, and the confirmation prompt prints that same normalized object.
Unknown fields, wildcards in target identifiers, unsupported operations, expired policies, revocation, and mismatches return `ask`.

**All evidence supplied to this command is untrusted simulation data.**
An environment label of `preview` does not prove that an opaque ID is nonproduction.
Matching heads do not prove freshness. The command performs no network or repository verification.
An `approvedBy` field is invalid rather than a grant.

## Required owner activation gate

There is no activation command in this patch. Installing it does not enable scoped approvals.
The bounded implementation stops here because `RequestDetail` currently supplies only action/resource strings, not verified execution context.
Removing a regex exemption on that basis would turn worker-controlled text into authority.

A later runtime patch requires these checks before any activation:

1. The owner chooses real, existing preview target IDs and aliases, the exact operations, expiry, and side-effect bounds.
   The owner approves the normalized policy revision through a trusted UI or CLI confirmation, outside agent-controlled input.
   Never accept chat quotes, a model-supplied `owner` field, or possession of a same-user local bearer token as proof of owner approval.
2. A trusted owner control records immutable consent with revision, owner identity, approval time, and revocation state.
   Agents can propose scope but cannot create, enable, amend, or un-revoke grants. A scope change requires fresh owner approval.
   The exact trusted confirmation mechanism must be chosen before implementing grant writes. A TTY alone cannot distinguish an owner from a same-user agent with a PTY.
3. A narrow execution adapter independently resolves the canonical repository, source and destination branches, current heads, provider account, immutable target ID, and environment.
   The adapter executes only the fixed operation, not arbitrary worker shell text. Production and main remain outside scope even if an alias looks like a preview.
   Ready targets bind the exact PR and its branches. Shared merges bind both heads and the destination branch. Deployments bind the existing preview target and artifact.
4. Recheck consent revision, expiry, revocation, heads, targets, worker ownership, and technical permission at queue time and immediately before execution.
   Preserve existing closed/escalated/unknown handling. Never reinterpret old pending requests using a new grant.
5. Persist an operation ID, policy revision, verified context, decision, and attempt before sending once.
   Reconcile lost outcomes by ID. Revocation blocks all unstarted operations. Unknown outcomes remain unknown, not silently retried.
6. The owner explicitly approves the reviewed runtime diff, exact grant revision, installation path change, and any required reload in a separate maintenance window.
   This is not permission to restart the notch or service while other workers run.

The policy does not grant production, main, force pushes, resets, history rewriting, deletion outside a managed worktree, secrets access, config edits, new resource creation, package publication, reviewer requests, or Slack, Linear, and Notion posts.
Those actions still ask or deny under their separate owner policies. Broad or unclassified operations still ask.
This keeps owner consent separate from technical execution permission and leaves the current guards intact by default.
