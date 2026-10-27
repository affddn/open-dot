import { createHash } from "node:crypto";

type Operation = "ready" | "sharedmerge" | "previewdeploy";
type Target = { alias: string; id: string; operation: Operation };
type Policy = {
  version: 1;
  repository: "Orange-GameFi/orange-jam";
  branch: "feat/founder-loop";
  expiresAt: number | null;
  targets: Target[];
  sideEffects: string[];
};

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string[]) =>
  Object.keys(value).toSorted().join(",") === expected.toSorted().join(",");
const operation = (value: unknown): value is Operation =>
  value === "ready" || value === "sharedmerge" || value === "previewdeploy";
const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9:/._-]{0,199}$/.test(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
const sha = (value: unknown) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const effects = ["update-pr-draft-state", "update-shared-branch", "replace-preview-artifact"];
const effectFor = {
  ready: "update-pr-draft-state",
  sharedmerge: "update-shared-branch",
  previewdeploy: "replace-preview-artifact",
};

/** Parses a proposal only. Neither a file nor an approval claim in it is owner consent. */
export const parseScopedPolicy = (input: unknown): Policy | string => {
  if (
    !object(input) ||
    !keys(input, ["version", "repository", "branch", "expiresAt", "targets", "sideEffects"]) ||
    input.version !== 1 ||
    input.repository !== "Orange-GameFi/orange-jam" ||
    input.branch !== "feat/founder-loop" ||
    !(
      input.expiresAt === null ||
      (Number.isSafeInteger(input.expiresAt) && Number(input.expiresAt) > 0)
    )
  )
    return "Expected the exact version-1 repository, branch, and expiry fields; no approval fields.";
  if (!Array.isArray(input.targets) || input.targets.length < 1 || input.targets.length > 12)
    return "Name between 1 and 12 fixed preview targets.";
  const targets: Target[] = [];
  for (const target of input.targets) {
    if (
      !object(target) ||
      !keys(target, ["alias", "id", "operation"]) ||
      !identifier(target.alias) ||
      !identifier(target.id) ||
      !operation(target.operation)
    )
      return "Each target needs a literal alias, stable ID, and supported operation; no wildcards.";
    if (targets.some((item) => item.alias === target.alias || item.id === target.id))
      return "Target aliases and IDs must be unique.";
    targets.push({ alias: target.alias, id: target.id, operation: target.operation });
  }
  if (
    !strings(input.sideEffects) ||
    input.sideEffects.length > effects.length ||
    new Set(input.sideEffects).size !== input.sideEffects.length ||
    input.sideEffects.some((effect) => !effects.includes(effect))
  )
    return "Side effects must be an explicit subset of the three supported preview effects.";
  return {
    version: 1,
    repository: input.repository,
    branch: input.branch,
    expiresAt: input.expiresAt === null ? null : Number(input.expiresAt),
    targets: targets.toSorted((a, b) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0)),
    sideEffects: input.sideEffects.toSorted(),
  };
};

export const scopedPolicyRevision = (policy: Policy) =>
  createHash("sha256").update(JSON.stringify(policy)).digest("hex");

/** The future owner confirmation text and offline review use the same parsed scope. */
export const scopedPolicyPrompt = (policy: Policy) =>
  `Proposed scoped consent (NOT ACTIVE), revision ${scopedPolicyRevision(policy)}\n${JSON.stringify(policy, null, 2)}\nOnly these fixed preview targets and listed side effects are in scope. Production, main, history rewriting, destructive actions outside the worker worktree, secrets, config edits, new resources, package publication, reviewer requests, and external posts are not granted. Unknown or broad actions ask the owner. Consent never overrides technical permission checks. No file, worker text, chat quote, or model output approves this proposal.`;

type Review = {
  status: "candidate" | "ask";
  execution: "owner-required";
  reason: string;
  revision: string | null;
  prompt: string;
};

/** Offline scope matching, not authorization. Intent and evidence here are untrusted fixtures. */
export const reviewScopedPolicy = (input: unknown, now: number): Review => {
  const result = (reason: string, policy?: Policy, candidate = false): Review => ({
    status: candidate ? "candidate" : "ask",
    execution: "owner-required",
    reason,
    revision: policy ? scopedPolicyRevision(policy) : null,
    prompt: policy
      ? scopedPolicyPrompt(policy)
      : "Invalid proposal. Ask the owner; nothing is approved.",
  });
  if (!object(input) || !keys(input, ["policy", "intent", "evidence"]))
    return result(
      "Expected only policy, intent, and evidence. Text and approval claims are not grants.",
    );
  const policy = parseScopedPolicy(input.policy);
  if (typeof policy === "string") return result(policy);
  if (!Number.isSafeInteger(now) || now < 0) return result("Unknown current time.", policy);
  if (policy.expiresAt !== null && now >= policy.expiresAt)
    return result("Policy expired.", policy);
  const intent = input.intent;
  const evidence = input.evidence;
  if (
    !object(intent) ||
    !keys(intent, ["repository", "branch", "operation", "alias", "sideEffects"]) ||
    !operation(intent.operation) ||
    !strings(intent.sideEffects)
  )
    return result("Unknown, broad, or unsupported intent.", policy);
  if (intent.repository !== policy.repository || intent.branch !== policy.branch)
    return result("Repository or branch is outside scope.", policy);
  const target = policy.targets.find(
    (item) => item.alias === intent.alias && item.operation === intent.operation,
  );
  if (!target) return result("Target alias or operation is outside scope.", policy);
  if (
    intent.sideEffects.length !== 1 ||
    intent.sideEffects[0] !== effectFor[intent.operation] ||
    intent.sideEffects.some((effect) => !policy.sideEffects.includes(effect))
  )
    return result("Side effects exceed the explicit bound.", policy);
  if (
    !object(evidence) ||
    !keys(evidence, [
      "revision",
      "revoked",
      "environment",
      "targetID",
      "head",
      "freshHead",
      "targetHead",
      "freshTargetHead",
    ]) ||
    evidence.revoked !== false ||
    evidence.revision !== scopedPolicyRevision(policy) ||
    evidence.environment !== "preview" ||
    evidence.targetID !== target.id
  )
    return result("Revoked, changed, unknown, production, or mismatched target evidence.", policy);
  if (
    !sha(evidence.head) ||
    !sha(evidence.targetHead) ||
    evidence.head !== evidence.freshHead ||
    evidence.targetHead !== evidence.freshTargetHead
  )
    return result("Missing or stale source or target head.", policy);
  return result(
    "Scope matches this fixture only. Trusted owner consent and execution checks are still required.",
    policy,
    true,
  );
};
