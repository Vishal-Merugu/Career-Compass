// ─── Can this run actually succeed? ──────────────────────────────
//
// Everything checked here is knowable in under a second, and every one of them
// was previously discovered the expensive way — or not at all. The run that
// prompted this work made ~368 LinkedIn calls over twenty minutes against a
// model it had never once reached, then reported itself healthy.
//
// So: check first, and refuse with a sentence the user can act on.

import { getSessionState } from './linkedinSession.service.js';
import { PrismaStorageAdapter } from './storage.adapter.js';
import {
  asTarget,
  llmHealthCheck,
  normalizeProvider,
  providerLabel,
  resolveModel,
  usesOllamaDialect,
  type LlmSource,
} from '../shared/llmClient.js';
import { resolveChain } from './llmRouter.service.js';
import {
  describeJobError,
  type JobErrorCode,
  type JobErrorContext,
} from '../errors/jobErrors.js';
import type { IUserConfig } from '../shared/types.js';

export interface PreflightCheck {
  ok: boolean;
  /** Present only when `ok` is false. */
  code?: JobErrorCode;
  message?: string;
  fix?: string;
  /** Human-readable summary of what was found, shown either way. */
  detail?: string;
}

export interface PreflightResult {
  ok: boolean;
  checks: {
    linkedinSession: PreflightCheck;
    aiModel: PreflightCheck;
  };
  /** The first failure, promoted so a caller can render one line. */
  code?: JobErrorCode;
  message?: string;
  fix?: string;
}

/** `qwen2.5` and `qwen2.5:latest` are the same model to Ollama. Nothing else is. */
function withTag(model: string): string {
  return model.includes(':') ? model : `${model}:latest`;
}

function fail(code: JobErrorCode, ctx: JobErrorContext = {}): PreflightCheck {
  const { message, fix } = describeJobError(code, ctx);
  return { ok: false, code, message, fix };
}

async function checkSession(userId: string): Promise<PreflightCheck> {
  const state = await getSessionState(userId);

  if (!state.present) return fail('SESSION_MISSING');
  if (!state.isValid) return fail('SESSION_EXPIRED');

  return {
    ok: true,
    detail: state.importedAt
      ? `Session pushed ${new Date(state.importedAt).toLocaleString()}`
      : 'Session present',
  };
}

/**
 * Ask the model host what it has, from **this** process.
 *
 * The extension had a "Test AI" button that ran the same check in the browser,
 * where it reached the user's own laptop rather than the host that makes the
 * real calls — so it could report a healthy model while the server could not
 * resolve the address at all.
 */
export async function checkAiModel(config: LlmSource): Promise<PreflightCheck> {
  const provider = normalizeProvider(config);
  const model = resolveModel(config);
  const label = asTarget(config).label || providerLabel(provider);

  if (!model) {
    return fail('LLM_MODEL_NOT_FOUND', { provider: label });
  }

  const health = await llmHealthCheck(config);

  if (!health.ok) {
    const check = fail(health.code ?? 'LLM_UNREACHABLE', {
      provider: label,
      model,
    });
    return { ...check, detail: health.error };
  }

  // Only enforced for Ollama's dialect, where the model list is exact and a
  // missing model is the most common failure. Hosted providers list hundreds of
  // ids in shapes that vary (`models/gemini-…`), so a mismatch there would more
  // often be a false alarm than a real problem.
  if (usesOllamaDialect(provider) && health.models?.length) {
    // Exact, apart from the implicit `:latest` tag. Matching on the family name
    // instead — treating `qwen2.5:1.5b` as satisfied by `qwen2.5:14b` — was
    // tried and immediately let through the exact mismatch this check exists
    // for: the VM has 14b installed and the old default asked for 1.5b. The
    // size tag *is* the model.
    const installed = health.models.some(
      (name) => withTag(name) === withTag(model),
    );
    if (!installed) {
      const check = fail('LLM_MODEL_NOT_FOUND', { provider: label, model });
      return {
        ...check,
        detail: `Installed: ${health.models.slice(0, 10).join(', ')}`,
      };
    }
  }

  return { ok: true, detail: `${label} · ${model}` };
}

/**
 * Can *any* model this account holds answer?
 *
 * A waterfall only needs one working model, so this passes when one passes.
 * Checking only the top of the chain would refuse a run that would have
 * succeeded on the second key, which is precisely the failure the chain was
 * built to end.
 *
 * Checked in parallel: the chain is a handful of hosts and each check has its
 * own 5s ceiling, so serial worst-case would put half a minute in front of the
 * New run form.
 */
export async function checkAiChain(
  userId: string,
  config: IUserConfig | null,
): Promise<PreflightCheck> {
  const chain = await resolveChain(userId, config ?? undefined);

  if (chain.length === 0) return fail('LLM_MODEL_NOT_FOUND');

  const results = await Promise.all(chain.map((t) => checkAiModel(t)));
  const workingIndex = results.findIndex((r) => r.ok);

  if (workingIndex >= 0) {
    const working = results.filter((r) => r.ok).length;
    return {
      ok: true,
      detail:
        chain.length > 1
          ? `${working} of ${chain.length} models ready · ${chain[workingIndex]!.label} first`
          : results[workingIndex]!.detail,
    };
  }

  // One model is the pre-existing world: keep its specific code and copy.
  if (chain.length === 1) return results[0]!;

  return {
    ...fail('LLM_ALL_FAILED'),
    detail: chain
      .map((t, i) => `${t.label}: ${results[i]!.message}`)
      .join(' · '),
  };
}

/**
 * Run every check for a user, in the order the user should fix them.
 */
export async function preflightJob(userId: string): Promise<PreflightResult> {
  // Through the adapter, not `prisma.userConfig` directly: `llmApiKey` is
  // encrypted at rest, and handing the ciphertext to a provider as a bearer
  // token would fail authentication and report a wrong key to a user whose key
  // is fine.
  const config = await new PrismaStorageAdapter(userId)
    .getConfig()
    .catch(() => null);

  // The whole chain, not just `config`: an account whose keys all live in
  // `LlmCredential` has nothing useful in `UserConfig`, and checking only that
  // would refuse every run it can actually complete.
  const aiModel = await checkAiChain(userId, config);

  const linkedinSession = await checkSession(userId);

  const checks = { linkedinSession, aiModel };
  // Session first: it is the one the user is most likely to have simply not
  // done yet, and it blocks every run regardless of the model.
  const firstFailure = [linkedinSession, aiModel].find((c) => !c.ok);

  return {
    ok: !firstFailure,
    checks,
    code: firstFailure?.code,
    message: firstFailure?.message,
    fix: firstFailure?.fix,
  };
}
