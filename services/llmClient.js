// ─── LLM Client (OpenAI Standard) ──────────────────────────────────
// Supports Gemini, OpenRouter, and Custom (Ollama) endpoints.

/**
 * Get Base URL based on provider
 */
function getBaseUrl(config) {
  const provider = (config?.llmProvider || "ollama").toLowerCase();
  const llmUrl = config?.llmUrl || "";

  console.log(`[llmClient V2.1] getBaseUrl for provider: ${provider}`);

  switch (provider) {
    case "gemini":
      // Google OpenAI Mapping: https://ai.google.dev/gemini-api/docs/openai
      return "https://generativelanguage.googleapis.com/v1beta/openai";
    case "openrouter":
      // OpenRouter Quickstart: https://openrouter.ai/docs/quickstart
      return "https://openrouter.ai/api/v1";
    case "ollama":
    default: {
      let url = llmUrl || "http://localhost:11434";
      if (url.endsWith("/")) url = url.slice(0, -1);
      // Ollama standard for OpenAI compatibility
      if (!url.endsWith("/v1")) {
        url += "/v1";
      }
      return url;
    }
  }
}

/**
 * Get Auth Headers based on provider
 */
function getHeaders(config) {
  const provider = (config?.llmProvider || "ollama").toLowerCase();
  const llmApiKey = config?.llmApiKey || "";
  const headers = { "Content-Type": "application/json" };

  if (provider === "gemini" || provider === "openrouter") {
    if (llmApiKey) {
      headers["Authorization"] = `Bearer ${llmApiKey}`;
    }
  }

  // OpenRouter requires these for ranking
  if (provider === "openrouter") {
    headers["HTTP-Referer"] =
      "https://github.com/vshalsingh/linkedin-automationV2";
    headers["X-Title"] = "CareerCompass";
  }

  return headers;
}

/**
 * Health check — fetch models
 */
async function llmHealthCheck(config) {
  const provider = (config?.llmProvider || "ollama").toLowerCase();
  const baseUrl = getBaseUrl(config);
  const headers = getHeaders(config);

  // Ollama uses /api/tags for legacy health, others use /v1/models
  const modelsUrl =
    provider === "ollama" ? `${baseUrl}/api/tags` : `${baseUrl}/models`;

  try {
    const res = await fetch(modelsUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      // Fallback for Ollama to try /v1/models if /api/tags fails, but usually we just want a list
      return { ok: false, error: `HTTP ${res.status}` };
    }

    const data = await res.json();

    // Parse models list based on response schema
    let models = [];
    if (provider === "ollama" && data.models) {
      models = data.models.map((m) => m.name);
    } else if (data.data && Array.isArray(data.data)) {
      // OpenAI Standard
      models = data.data.map((m) => m.id);
    }

    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err.message };
  }
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
  const baseUrl = getBaseUrl(config);
  const headers = getHeaders(config);
  const model = config.llmModel || "qwen2.5:1.5b";

  const systemPrompt = `You are a professional networking assistant. Generate a SHORT, personalized LinkedIn connection request message.

RULES:
- TARGET LENGTH: 200-240 characters. 
- ABSOLUTE MAXIMUM: 295 characters (LinkedIn will reject anything longer).
- Be genuine and specific — reference the person's role, company, or background.
- Mention you're looking for working student / internship opportunities.
- Be warm but professional.
- Do NOT use emojis.
- Do NOT use generic phrases like "I'd love to connect".
- Output ONLY the message text, nothing else.`;

  const userPrompt = `Write a connection message for this person:
Name: ${profileData.firstName} ${profileData.lastName}
Title: ${profileData.headline}
Company: ${companyName}
${profileData.about ? `About: ${profileData.about.slice(0, 300)}` : ""}
${profileData.experiences?.length ? `Current Role: ${profileData.experiences[0]?.title} at ${profileData.experiences[0]?.companyName}` : ""}

${userContext ? `About me (the sender): ${userContext}` : ""}`;

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 250,
        temperature: 0.7,
        stream: false,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`LLM Error ${res.status}: ${text.slice(0, 150)}`);
    }

    const data = await res.json();
    let message = data.choices?.[0]?.message?.content?.trim() || "";
    message = message.replace(/^["']|["']$/g, "");

    if (message.length > 295) {
      message = message.slice(0, 292) + "...";
    }

    return { ok: true, message };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Exports ─────────────────────────────────────────────────────

if (typeof globalThis !== "undefined") {
  Object.assign(globalThis, {
    llmHealthCheck,
    generateConnectionMessage,
  });
}
