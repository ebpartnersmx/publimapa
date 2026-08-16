/**
 * Publimapa Worker — AI Concierge with Gemini Context Caching
 *
 * Architecture:
 *   - Static assets (frontend) served from ./public via the ASSETS binding
 *   - POST /api/chat         → User chat with AI concierge (uses cached Gemini context)
 *   - POST /api/update-cache  → Manually trigger cache refresh
 *   - Cron (hourly)           → Auto-refreshes Gemini context cache
 *
 * Bindings:
 *   - PUBLIMAPA_KV  (KV)      → Stores the Gemini Cache ID
 *   - GEMINI_API_KEY (secret) → Google AI Studio API key
 *   - GAS_API_URL    (secret) → Google Apps Script Web App URL (business directory)
 */

// ─── Configuration ───────────────────────────────────────────────
const CACHE_MODELS = ["gemini-1.5-flash"];
const INLINE_MODELS = ["gemini-2.5-flash", "gemini-1.5-flash"];
const MIN_CACHE_TOKENS = 4096;
const SYSTEM_INSTRUCTION =
  "You are the Publimapa WTC Concierge. Use the provided JSON directory to recommend businesses based on user needs. Always respond with ONLY a valid JSON array of recommended businesses. Each business object should include name, category, description, and reason fields. If no businesses match, return an empty array []. Do not include any explanation, thinking, or text outside the JSON.";
const CACHE_TTL = "3600s";
const KV_CACHE_TTL = 3300;
const CACHE_KEY = "WTC_GEMINI_CACHE_ID";

// ─── Worker Entry Point ─────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // API routes (server-side, hidden from public)
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }

    // Everything else: serve static assets (frontend)
    return env.ASSETS.fetch(request);
  },

  // Cron trigger: refresh cache every hour
  async scheduled(event, env) {
    try {
      await refreshCache(env);
      console.log("[Publimapa] Cache refreshed successfully");
    } catch (error) {
      console.error("[Publimapa] Cache refresh failed:", error.message);
    }
  },
};

// ─── API Router ──────────────────────────────────────────────────
async function handleApi(request, env, url) {
  const route = url.pathname.replace("/api/", "");

  try {
    switch (route) {
      case "chat":
        return handleChat(request, env);
      case "update-cache":
        return handleUpdateCache(request, env);
      default:
        return json({ error: "Not found" }, 404);
    }
  } catch (error) {
    return json({ error: "Internal error", message: error.message }, 500);
  }
}

// ─── POST /api/chat ──────────────────────────────────────────────
async function handleChat(request, env) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const { userMessage } = await request.json();
  if (!userMessage) {
    return json({ error: "Missing 'userMessage' in request body" }, 400);
  }

  try {
    let cacheName = await env.PUBLIMAPA_KV.get(CACHE_KEY);

    if (!cacheName) {
      console.log("[Publimapa] No cache found, attempting to build new cache...");
      try {
        cacheName = await refreshCache(env);
      } catch (cacheErr) {
        console.log("[Publimapa] Cache creation failed, using inline generation:", cacheErr.message);
        cacheName = null;
      }
    }

    if (cacheName) {
      try {
        const response = await generateWithCache(env, cacheName, userMessage);
        return response;
      } catch (cacheErr) {
        console.log("[Publimapa] Cached generation failed, falling back:", cacheErr.message);
        await env.PUBLIMAPA_KV.delete(CACHE_KEY);
      }
    }

    return await generateInline(env, userMessage);
  } catch (error) {
    return json({ error: error.message }, 500);
  }
}

// ─── Generate with cached content ───────────────────────────────
async function generateWithCache(env, cacheName, userMessage) {
  const generatePayload = {
    cachedContent: cacheName,
    contents: [{ role: "user", parts: [{ text: userMessage }] }],
    generationConfig: {
      responseMimeType: "application/json",
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  let lastError = null;

  for (const model of CACHE_MODELS) {
    const aiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(generatePayload),
      }
    );

    const aiData = await aiRes.json();

    if (aiRes.ok) {
      const responseText = aiData.candidates?.[0]?.content?.parts?.[0]?.text;
      if (responseText) {
        const cleanJson = extractJson(responseText);
        if (cleanJson !== null) {
          return new Response(cleanJson, {
            headers: { "Content-Type": "application/json" },
          });
        }
      }
    }

    lastError = aiData.error?.message || "Unknown error";
  }

  throw new Error(lastError || "No response from AI");
}

// ─── Generate inline without cache ──────────────────────────────
async function generateInline(env, userMessage) {
  const GEMINI_API_KEY = env.GEMINI_API_KEY;
  const GAS_API_URL = env.GAS_API_URL;

  const dbResponse = await fetch(GAS_API_URL);
  if (!dbResponse.ok) {
    return json({ error: `Failed to fetch database: ${dbResponse.status}` }, 502);
  }
  const dbJson = await dbResponse.text();

  const payload = {
    systemInstruction: {
      parts: [{ text: SYSTEM_INSTRUCTION }],
    },
    contents: [
      { role: "user", parts: [{ text: dbJson }] },
      { role: "model", parts: [{ text: "Understood. I have the business directory. How can I help?" }] },
      { role: "user", parts: [{ text: userMessage }] },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  const allErrors = [];

  for (const model of INLINE_MODELS) {
    const aiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );

    const aiData = await aiRes.json();

    if (aiRes.ok) {
      const responseText = aiData.candidates?.[0]?.content?.parts?.[0]?.text;
      if (responseText) {
        const cleanJson = extractJson(responseText);
        if (cleanJson !== null) {
          return new Response(cleanJson, {
            headers: { "Content-Type": "application/json" },
          });
        }
      }
    }

    allErrors.push({ model, error: aiData.error });
  }

  // Try discovering available models
  try {
    const listRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`
    );
    const listData = await listRes.json();

    const availableModels = (listData.models || [])
      .filter(m => m.supportedGenerationMethods?.includes("generateContent"))
      .map(m => m.name.replace("models/", ""))
      .filter(name => !INLINE_MODELS.includes(name));

    for (const model of availableModels) {
      const aiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );

      const aiData = await aiRes.json();

      if (aiRes.ok) {
        const responseText = aiData.candidates?.[0]?.content?.parts?.[0]?.text;
        if (responseText) {
          const cleanJson = extractJson(responseText);
          if (cleanJson !== null) {
            return new Response(cleanJson, {
              headers: { "Content-Type": "application/json" },
            });
          }
        }
      }

      allErrors.push({ model, error: aiData.error });
    }
  } catch (discoverErr) {
    allErrors.push({ discovery: discoverErr.message });
  }

  return json({ error: "Gemini API error", details: allErrors }, 502);
}

// ─── POST /api/update-cache ─────────────────────────────────────
async function handleUpdateCache(request, env) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const cacheName = await refreshCache(env);
    return json({ success: true, cacheId: cacheName });
  } catch (error) {
    return json({ error: error.message }, 500);
  }
}

// ─── Cache Refresh Logic ────────────────────────────────────────
async function refreshCache(env) {
  const GEMINI_API_KEY = env.GEMINI_API_KEY;
  const GAS_API_URL = env.GAS_API_URL;

  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");
  if (!GAS_API_URL) throw new Error("GAS_API_URL is not set");

  const dbResponse = await fetch(GAS_API_URL);
  if (!dbResponse.ok) {
    throw new Error(`Failed to fetch database from GAS: ${dbResponse.status} ${dbResponse.statusText}`);
  }
  const dbJson = await dbResponse.text();

  let cacheName = null;
  let lastError = null;

  for (const model of CACHE_MODELS) {
    const cachePayload = {
      model: `models/${model}`,
      systemInstruction: {
        parts: [{ text: SYSTEM_INSTRUCTION }],
      },
      contents: [{ role: "user", parts: [{ text: dbJson }] }],
      ttl: CACHE_TTL,
    };

    const cacheRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/cachedContents?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cachePayload),
      }
    );

    const cacheData = await cacheRes.json();

    if (cacheRes.ok && cacheData.name) {
      cacheName = cacheData.name;
      break;
    }

    lastError = cacheData.error;
  }

  if (!cacheName) {
    throw new Error(`Gemini cache creation failed for all models: ${JSON.stringify(lastError)}`);
  }

  await env.PUBLIMAPA_KV.put(CACHE_KEY, cacheName, { expirationTtl: KV_CACHE_TTL });

  return cacheName;
}

// ─── Helper ─────────────────────────────────────────────────────
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── Extract JSON from AI response ─────────────────────────────
function extractJson(text) {
  if (!text) return null;

  try {
    JSON.parse(text);
    return text;
  } catch {}

  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      JSON.parse(arrayMatch[0]);
      return arrayMatch[0];
    } catch {}
  }

  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      JSON.parse(objMatch[0]);
      return objMatch[0];
    } catch {}
  }

  return text;
}
