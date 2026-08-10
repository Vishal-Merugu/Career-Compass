// ─── Connection notes, written on the server ─────────────────────
//
// The last LLM caller outside the server. `massConnector.js` used to generate
// these with the extension's own hand-mirrored copy of `llmClient.js`, which
// forced two problems:
//
//   1. **Two callers, one setting.** The browser reaches a local Ollama at
//      `localhost:11434`; the server reaches one at `host.docker.internal`.
//      A single `llmUrl` cannot be right for both, and the one that was wrong
//      failed silently.
//   2. **A duplicated file.** `shared/llmClient.ts` was copied by hand into
//      `extension/services/llmClient.js`, so every fix — including the error
//      classification added after a run rejected 368 profiles for
//      `LLM Error: fetch failed` — had to be made twice or drift.
//
// Sending the request is still the extension's job. Only the writing moved.
//
// `requireAuthOrApiKey`: the extension holds an API key, and generating a note
// is what it is here to do. Unlike mail, this spends no credential of the
// user's beyond the model they configured.

import { Router } from 'express';
import { z } from 'zod';
import { requireAuthOrApiKey } from '../auth/middleware.js';
import { ValidationError } from '../errors/AppError.js';
import { LlmError } from '../errors/AppError.js';
import { describeJobError } from '../errors/jobErrors.js';
import { generateConnectionMessage } from '../shared/llmClient.js';
import { PrismaStorageAdapter } from '../services/storage.adapter.js';
import type { IParsedProfile } from '../shared/parsers.js';

const router = Router();

const messageSchema = z.object({
  firstName: z.string().default(''),
  lastName: z.string().default(''),
  headline: z.string().default(''),
  about: z.string().default(''),
  companyName: z.string().default(''),
  currentTitle: z.string().default(''),
  /** What the user wants said about themselves, per run. */
  prompt: z.string().max(4000).optional(),
});

router.post(
  '/connections/message',
  requireAuthOrApiKey,
  async (req, res, next) => {
    try {
      const body = messageSchema.parse(req.body);
      const config = await new PrismaStorageAdapter(req.user!.id).getConfig();

      // Only the fields the prompt actually reads. A full IParsedProfile would
      // mean the extension shipping an experience array it has already flattened.
      const profile: IParsedProfile = {
        firstName: body.firstName,
        lastName: body.lastName,
        headline: body.headline,
        about: body.about,
        experiences: body.currentTitle
          ? [
              {
                title: body.currentTitle,
                companyName: body.companyName,
                description: '',
                // The note prompt reads only the title and company; dates are
                // required by the shape, not by the text.
                timePeriod: {
                  startDate: { year: '', month: '' },
                  endDate: { year: '', month: '' },
                },
              },
            ]
          : [],
        education: [],
        skills: [],
        location: '',
        publicIdentifier: '',
      };

      const result = await generateConnectionMessage(
        profile,
        body.companyName,
        body.prompt ?? config.userContext ?? null,
        config,
      );

      if (!result.ok) {
        return res
          .status(502)
          .json({ ok: false, error: result.error ?? 'The AI model failed' });
      }

      res.status(200).json({ ok: true, message: result.message });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return next(new ValidationError('Invalid profile payload', err.errors));
      }
      // The classified copy, so the extension shows the same sentence the
      // dashboard would for the same failure.
      if (err instanceof LlmError) {
        const { message, fix } = describeJobError(err.code, {
          model: err.model,
          provider: err.provider,
        });
        return res
          .status(502)
          .json({ ok: false, error: `${message} ${fix}`, code: err.code });
      }
      next(err);
    }
  },
);

export const connectionsRouter = router;
