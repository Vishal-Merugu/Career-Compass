// ─── LLM Client (Native Ollama & OpenAI Standard) ──────────────────
// Supports Gemini, OpenRouter, and Native Ollama endpoints.

/**
 * Get Base URL based on provider
 */
function getBaseUrl(config) {
  const provider = (config?.llmProvider || 'ollama').toLowerCase();
  const llmUrl = config?.llmUrl || '';

  console.log(`[llmClient V2.1] getBaseUrl for provider: ${provider}`);

  switch (provider) {
    case 'gemini':
      return 'https://generativelanguage.googleapis.com/v1beta/openai';
    case 'openrouter':
      return 'https://openrouter.ai/api/v1';
    case 'ollama':
    default: {
      let url = llmUrl || 'http://localhost:11434';
      if (url.endsWith('/')) url = url.slice(0, -1);
      return url;
    }
  }
}

/**
 * Get Auth Headers based on provider
 */
function getHeaders(config) {
  const provider = (config?.llmProvider || 'ollama').toLowerCase();
  const llmApiKey = config?.llmApiKey || '';
  const headers = { 'Content-Type': 'application/json' };

  if (provider === 'gemini' || provider === 'openrouter') {
    if (llmApiKey) {
      headers['Authorization'] = `Bearer ${llmApiKey}`;
    }
  }

  // OpenRouter requires these for ranking
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] =
      'https://github.com/vshalsingh/linkedin-automationV2';
    headers['X-Title'] = 'CareerCompass';
  }

  return headers;
}

/**
 * Health check — fetch models
 */
async function llmHealthCheck(config) {
  const provider = (config?.llmProvider || 'ollama').toLowerCase();
  const baseUrl = getBaseUrl(config);
  const headers = getHeaders(config);

  // Ollama uses /api/tags for legacy health, others use /v1/models (which is just /models here since baseUrl has /v1)
  const modelsUrl =
    provider === 'ollama' ? `${baseUrl}/api/tags` : `${baseUrl}/models`;

  try {
    const res = await fetch(modelsUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }

    const data = await res.json();

    // Parse models list based on response schema
    let models = [];
    if (provider === 'ollama' && data.models) {
      models = data.models.map((m) => m.name);
    } else if (data.data && Array.isArray(data.data)) {
      models = data.data.map((m) => m.id);
    }

    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Universal Chat Completion Wrapper
 * Automatically switches between Native Ollama and OpenAI schemas.
 */
async function sendChatCompletion(
  config,
  systemPrompt,
  userPrompt,
  maxTokens,
  temperature,
) {
  const provider = (config?.llmProvider || 'ollama').toLowerCase();
  const baseUrl = getBaseUrl(config);
  const headers = getHeaders(config);
  const model = config.llmModel || 'qwen2.5:1.5b';

  let endpoint, body;

  if (provider === 'ollama') {
    // Native Ollama API
    endpoint = `${baseUrl}/api/chat`;
    body = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      stream: false,
      options: {
        num_predict: maxTokens,
        temperature: temperature,
      },
    });
  } else {
    // OpenAI Compatibility (Gemini, OpenRouter)
    endpoint = `${baseUrl}/chat/completions`;
    body = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: maxTokens,
      temperature: temperature,
      stream: false,
    });
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(120000), // 120 seconds for slow local LLMs
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM Error ${res.status}: ${text.slice(0, 150)}`);
  }

  const data = await res.json();
  let content = '';

  if (provider === 'ollama') {
    content = data.message?.content?.trim() || '';
  } else {
    content = data.choices?.[0]?.message?.content?.trim() || '';
  }

  return content;
}

/**
 * Generate a personalized connection message
 */
async function generateConnectionMessage(
  profileData,
  companyName,
  userContext,
  config,
) {
  // Must match server/src/shared/llmClient.ts's LINKEDIN_MAX_CHARS — LinkedIn
  // rejects connection notes over 200 characters, and the two clients
  // previously disagreed (extension allowed up to 295), risking silent
  // rejection depending on which path generated the message.
  const LINKEDIN_MAX_CHARS = 200;
  const MAX_ATTEMPTS = 3;

  function sanitizeMessage(raw) {
    return raw
      .replace(/\\n/g, ' ')
      .replace(/\r?\n/g, ' ')
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16)),
      )
      .replace(/^["']+|["']+$/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  const systemPrompt = `You are a professional networking assistant. Generate a SHORT, personalized LinkedIn connection request message.

RULES:
- HARD LIMIT: The message MUST be under ${LINKEDIN_MAX_CHARS} characters (including spaces). This is a strict technical limit — messages over ${LINKEDIN_MAX_CHARS} characters will be REJECTED by LinkedIn's API.
- TARGET LENGTH: 120-180 characters (including spaces).
- Write the ENTIRE message as a SINGLE paragraph. Do NOT use line breaks, newlines, or "Best regards" sign-offs.
- Be genuine and specific — reference the person's role, company, or background.
- Mention you're looking for working student / internship opportunities.
- Be warm but professional.
- Do NOT use emojis.
- Do NOT use generic phrases like "I'd love to connect".
- Output ONLY the message text, nothing else. No quotes, no newlines.`;

  const userPrompt = `Write a connection message for this person:
Name: ${profileData.firstName} ${profileData.lastName}
Title: ${profileData.headline}
Company: ${companyName}
${profileData.about ? `About: ${profileData.about.slice(0, 300)}` : ''}
${profileData.experiences?.length ? `Current Role: ${profileData.experiences[0]?.title} at ${profileData.experiences[0]?.companyName}` : ''}

${userContext ? `About me (the sender): ${userContext}` : ''}`;

  try {
    let message = '';

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const temperature = attempt === 1 ? 0.7 : attempt === 2 ? 0.5 : 0.3;

      let promptToUse = systemPrompt;
      if (attempt > 1) {
        promptToUse += `\n\nWARNING: Your previous attempt was ${message.length} characters which EXCEEDS the ${LINKEDIN_MAX_CHARS} character limit. You MUST write a SHORTER message this time. Aim for 150 characters. NO line breaks.`;
      }

      const raw = await sendChatCompletion(
        config,
        promptToUse,
        userPrompt,
        300,
        temperature,
      );
      message = sanitizeMessage(raw);

      if (message.length <= LINKEDIN_MAX_CHARS) {
        return { ok: true, message };
      }

      console.warn(
        `[LLM] Message too long (${message.length} chars), attempt ${attempt}/${MAX_ATTEMPTS}`,
      );
    }

    if (message.length > LINKEDIN_MAX_CHARS) {
      const truncated = message.slice(0, LINKEDIN_MAX_CHARS);
      const lastSentenceEnd = Math.max(
        truncated.lastIndexOf('.'),
        truncated.lastIndexOf('!'),
        truncated.lastIndexOf('?'),
      );
      message =
        lastSentenceEnd > 100
          ? truncated.slice(0, lastSentenceEnd + 1)
          : truncated.slice(0, LINKEDIN_MAX_CHARS - 3) + '...';
      console.warn(
        `[LLM] Hard-truncated message to ${message.length} chars after ${MAX_ATTEMPTS} failed attempts`,
      );
    }

    return { ok: true, message };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Evaluate if a profile matches a given prompt
 */
async function evaluateProfile(
  profileData,
  prompt,
  config,
  targetCompanyName = '',
) {
  const systemPrompt = `You are a professional job search assistant evaluating LinkedIn profiles to find high-value connections.
Your task is to decide whether a person is a good target for professional outreach at a target company based on their profile data and the evaluation criteria.

CRITICAL EVALUATION RULES:
1. **Headline Priority**: A person's Headline is often the most up-to-date representation of their current role and seniority (e.g., if their headline says "Head of Engineering" but their current experience lists "Software Engineer", they are likely the Head of Engineering, and should be evaluated as Tier 1/Tier 2 rather than mid-level). 
2. **Career-Wide Seniority**: Evaluate seniority based on their ENTIRE career history, not just their tenure at the current company. A candidate who has only been at the target company for < 1 year but has substantial prior experience (e.g., 4+ years of total industry experience, past senior titles at reputable firms, or former founder background) is NOT entry-level/mid-level and should be treated as a senior/Tier 2 professional.
3. **Flexibility**: Be EXTREMELY flexible with company name variations (e.g., "Yendou" is the same as "itsyendou", "Google" is the same as "Google LLC"). Be flexible with engineering titles (e.g., Developer, Tech Lead, Architect are functionally equivalent).
4. **Err on the Side of Approval**: Err on the side of approval (match: true) if a candidate is close to a tier threshold or possesses significant career depth (e.g. ex-founders, senior engineers, high tenure, or former elite company experience) as they are high-value networking targets.

Respond ONLY with valid JSON in the exact format below, nothing else. Do not use markdown blocks.
Format: {"match": true/false, "reason": "a very brief 1-sentence explanation mentioning their Tier and why they were accepted/rejected"}`;

  const targetCompany =
    targetCompanyName ||
    profileData.experiences?.[0]?.companyName ||
    'the target company';

  const experiences =
    profileData.experiences
      ?.map((e) => {
        const startYear = e.timePeriod?.startDate?.year || '';
        const startMonth = e.timePeriod?.startDate?.month || '';
        const endYear = e.timePeriod?.endDate?.year || '';
        const endMonth = e.timePeriod?.endDate?.month || '';

        let dateStr = '';
        if (startYear) {
          const start = startMonth
            ? `${startMonth}/${startYear}`
            : `${startYear}`;
          const end = endYear
            ? endMonth
              ? `${endMonth}/${endYear}`
              : `${endYear}`
            : 'Present';
          dateStr = ` [${start} - ${end}]`;
        }
        return `- ${e.title} at ${e.companyName}${dateStr}`;
      })
      .join('\n') || 'None';

  const skills = profileData.skills?.slice(0, 10).join(', ') || 'None';

  const candidateProfileString = `Name: ${profileData.firstName} ${profileData.lastName}
Headline: ${profileData.headline}
Experiences (History & Duration):
${experiences}
Skills: ${skills}
About: ${profileData.about || 'None'}`;

  const userPrompt = `You are evaluating a LinkedIn profile on behalf of a job seeker conducting a targeted outreach campaign.

Target company: ${targetCompany}
Today's date: ${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}

---

PROFILE DATA:
${candidateProfileString}

---

EVALUATION CRITERIA:
${prompt}

---

INSTRUCTIONS:
1. Determine if they are currently at ${targetCompany} or closely associated.
2. Assign a TIER (1, 2, 3, or NONE) based on their role, seniority, and overall career history.
3. Return a JSON response in the exact format: {"match": true/false, "reason": "a very brief 1-sentence explanation mentioning their Tier and why they were accepted/rejected"}`;

  try {
    let content = await sendChatCompletion(
      config,
      systemPrompt,
      userPrompt,
      150,
      0.1,
    );

    // Try to parse JSON from the response
    content = content
      .replace(/```json/g, '')
      .replace(/```/g, '')
      .trim();

    const parsed = JSON.parse(content);
    return { ok: true, match: !!parsed.match, reason: parsed.reason || '' };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      match: false,
      reason: 'Error parsing LLM response',
    };
  }
}

// ─── Exports ─────────────────────────────────────────────────────

if (typeof globalThis !== 'undefined') {
  Object.assign(globalThis, {
    llmHealthCheck,
    generateConnectionMessage,
    evaluateProfile,
  });
}
