import axios from "axios";
import {
  ANTHROPIC_TOOLS,
  GEMINI_FUNCTION_DECLARATIONS,
  OPENAI_TOOLS,
  buildSystemInstruction,
} from "./aiPrompt.js";

const PROVIDERS = new Set(["gemini", "openai", "anthropic", "openrouter", "ollama"]);

function env(key, fallback = "") {
  const v = process.env[key];
  return v == null ? fallback : String(v).trim();
}

/** Free-tier-friendly Gemini models — tried in order when the configured one 404s. */
export const GEMINI_MODEL_FALLBACKS = [
  "gemini-2.0-flash",
  "gemini-flash-latest",
  "gemini-1.5-flash",
  "gemini-2.5-flash",
];

/** Strip accidental `models/` prefix / whitespace from Gemini model IDs. */
function normalizeGeminiModel(model) {
  return String(model || "gemini-2.0-flash")
    .trim()
    .replace(/^models\//i, "");
}

/** Active provider + credentials — always read at call time (Settings applyToEnv). */
export function getAiConfig() {
  let provider = env("AI_PROVIDER", "gemini").toLowerCase().trim();
  if (!PROVIDERS.has(provider)) provider = "gemini";

  if (provider === "gemini") {
    return {
      provider,
      apiKey: env("GEMINI_API_KEY"),
      model: normalizeGeminiModel(env("GEMINI_MODEL", "gemini-2.0-flash")),
      baseUrl: "",
    };
  }
  if (provider === "openai") {
    return {
      provider,
      apiKey: env("OPENAI_API_KEY"),
      model: env("OPENAI_MODEL", "gpt-4o-mini"),
      baseUrl: env("OPENAI_BASE_URL", "https://api.openai.com/v1").replace(/\/+$/, ""),
    };
  }
  if (provider === "anthropic") {
    return {
      provider,
      apiKey: env("ANTHROPIC_API_KEY"),
      model: env("ANTHROPIC_MODEL", "claude-sonnet-4-20250514"),
      baseUrl: env("ANTHROPIC_BASE_URL", "https://api.anthropic.com").replace(/\/+$/, ""),
    };
  }
  if (provider === "openrouter") {
    return {
      provider,
      apiKey: env("OPENROUTER_API_KEY"),
      model: env("OPENROUTER_MODEL", "openai/gpt-4o-mini"),
      baseUrl: env("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1").replace(/\/+$/, ""),
    };
  }
  // ollama — local OpenAI-compatible API; key usually unused
  return {
    provider,
    apiKey: env("OLLAMA_API_KEY", "ollama"),
    model: env("OLLAMA_MODEL", "llama3.2"),
    baseUrl: env("OLLAMA_BASE_URL", "http://127.0.0.1:11434/v1").replace(/\/+$/, ""),
  };
}

function requireKey(cfg) {
  if (cfg.provider === "ollama") return;
  if (!cfg.apiKey || cfg.apiKey === "CHANGE_ME") {
    throw new Error(
      `${cfg.provider} API key is not configured. Set it in Admin → Settings → AI assistant.`
    );
  }
  const k = cfg.apiKey;
  if (k.startsWith("crsr_")) {
    throw new Error(
      "That is a Cursor API key (crsr_…). Forge Assist cannot use it. Create a Gemini key at https://aistudio.google.com/apikey"
    );
  }
  if (cfg.provider === "gemini" && (k.startsWith("sk-") || k.startsWith("sk-proj-"))) {
    throw new Error(
      "That looks like an OpenAI key. For Google Gemini, create a key at https://aistudio.google.com/apikey"
    );
  }
}

/** Turn axios/provider errors into a short message the UI can show. */
export function formatAiProviderError(err, cfg = getAiConfig()) {
  const status = err.response?.status;
  const data = err.response?.data;
  const detail =
    data?.error?.message ||
    data?.error?.status ||
    (typeof data?.error === "string" ? data.error : null) ||
    data?.message ||
    err.message ||
    "Unknown error";

  if (status === 429) {
    return `${cfg.provider} rate limit / quota exceeded. Wait a few minutes or try again tomorrow on the free tier. (${detail})`;
  }
  if (status === 404 && cfg.provider === "gemini") {
    return `Gemini model "${normalizeGeminiModel(cfg.model)}" not found for your key. Pick gemini-2.0-flash in Settings, Save & test. (${detail})`;
  }
  if (status === 401 || status === 403) {
    return `${cfg.provider} rejected the API key (${status}). Paste a fresh key from aistudio.google.com/apikey (Gemini) and Save. (${detail})`;
  }
  if (status) return `${cfg.provider} API error ${status}: ${detail}`;
  return detail;
}

function historyToOpenAiMessages(history = []) {
  return history
    .filter((h) => h?.text)
    .map((h) => ({
      role: h.role === "assistant" ? "assistant" : "user",
      content: String(h.text),
    }));
}

async function geminiGenerate({ apiKey, model, body, timeout = 60000 }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  return axios.post(url, body, {
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    timeout,
  });
}

function geminiModelCandidates(preferred) {
  const primary = normalizeGeminiModel(preferred);
  return [primary, ...GEMINI_MODEL_FALLBACKS.filter((m) => m !== primary)];
}

async function chatGemini({ message, history, cfg }) {
  requireKey(cfg);
  const contents = [
    ...historyToOpenAiMessages(history).map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    { role: "user", parts: [{ text: message }] },
  ];
  const body = {
    contents,
    systemInstruction: { parts: [{ text: buildSystemInstruction() }] },
    tools: [{ functionDeclarations: GEMINI_FUNCTION_DECLARATIONS }],
  };

  let lastErr;
  for (const model of geminiModelCandidates(cfg.model)) {
    try {
      const res = await geminiGenerate({ apiKey: cfg.apiKey, model, body });
      const parts = res.data.candidates?.[0]?.content?.parts || [];
      const functionCallPart = parts.find((p) => p.functionCall);
      const textPart = parts.find((p) => p.text);
      return {
        functionCall: functionCallPart?.functionCall
          ? { name: functionCallPart.functionCall.name, args: functionCallPart.functionCall.args || {} }
          : null,
        text: textPart?.text || null,
        provider: cfg.provider,
        model,
      };
    } catch (err) {
      lastErr = err;
      // Only chase alternate model IDs on 404 (model unavailable for this key).
      if (err.response?.status !== 404) throw err;
    }
  }
  throw lastErr;
}

async function chatOpenAiCompatible({ message, history, cfg, extraHeaders = {} }) {
  requireKey(cfg);
  const messages = [
    { role: "system", content: buildSystemInstruction() },
    ...historyToOpenAiMessages(history),
    { role: "user", content: message },
  ];
  const res = await axios.post(
    `${cfg.baseUrl}/chat/completions`,
    {
      model: cfg.model,
      messages,
      tools: OPENAI_TOOLS,
      tool_choice: "auto",
    },
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
        ...extraHeaders,
      },
      timeout: 90000,
    }
  );
  const choice = res.data.choices?.[0]?.message || {};
  const tool = choice.tool_calls?.[0];
  let functionCall = null;
  if (tool?.function?.name) {
    let args = {};
    try {
      args = typeof tool.function.arguments === "string"
        ? JSON.parse(tool.function.arguments || "{}")
        : (tool.function.arguments || {});
    } catch {
      args = {};
    }
    functionCall = { name: tool.function.name, args };
  }
  return {
    functionCall,
    text: choice.content || null,
    provider: cfg.provider,
    model: cfg.model,
  };
}

async function chatAnthropic({ message, history, cfg }) {
  requireKey(cfg);
  const messages = [
    ...historyToOpenAiMessages(history).map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    })),
    { role: "user", content: message },
  ];
  const res = await axios.post(
    `${cfg.baseUrl}/v1/messages`,
    {
      model: cfg.model,
      max_tokens: 4096,
      system: buildSystemInstruction(),
      tools: ANTHROPIC_TOOLS,
      messages,
    },
    {
      headers: {
        "Content-Type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
      },
      timeout: 90000,
    }
  );
  const blocks = res.data.content || [];
  const toolUse = blocks.find((b) => b.type === "tool_use");
  const textBlock = blocks.find((b) => b.type === "text");
  return {
    functionCall: toolUse
      ? { name: toolUse.name, args: toolUse.input || {} }
      : null,
    text: textBlock?.text || null,
    provider: cfg.provider,
    model: cfg.model,
  };
}

/**
 * Forge Assist chat — provider selected via AI_PROVIDER.
 * Returns { functionCall: { name, args } | null, text, provider, model }.
 */
export async function chatWithAssist({ message, history = [] }) {
  const cfg = getAiConfig();
  if (cfg.provider === "gemini") return chatGemini({ message, history, cfg });
  if (cfg.provider === "anthropic") return chatAnthropic({ message, history, cfg });
  if (cfg.provider === "openrouter") {
    return chatOpenAiCompatible({
      message,
      history,
      cfg,
      extraHeaders: {
        "HTTP-Referer": env("FORGE_PUBLIC_URL", "http://localhost:4100"),
        "X-Title": "Forge Assist",
      },
    });
  }
  // openai + ollama
  return chatOpenAiCompatible({ message, history, cfg });
}

/** @deprecated use chatWithAssist */
export const chatWithGemini = chatWithAssist;

/**
 * Plain-text completion for ops helpers (troubleshoot). Uses the same provider.
 * Returns assistant text or null on failure / missing key.
 */
export async function completeText(prompt, { timeoutMs = 20000 } = {}) {
  const cfg = getAiConfig();
  try {
    if (cfg.provider === "gemini") {
      if (!cfg.apiKey || cfg.apiKey === "CHANGE_ME") return null;
      let lastErr;
      for (const model of geminiModelCandidates(cfg.model)) {
        try {
          const res = await geminiGenerate({
            apiKey: cfg.apiKey,
            model,
            body: { contents: [{ role: "user", parts: [{ text: prompt }] }] },
            timeout: timeoutMs,
          });
          return res.data.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text || null;
        } catch (err) {
          lastErr = err;
          if (err.response?.status !== 404) return null;
        }
      }
      if (lastErr) return null;
      return null;
    }
    if (cfg.provider === "anthropic") {
      if (!cfg.apiKey || cfg.apiKey === "CHANGE_ME") return null;
      const res = await axios.post(
        `${cfg.baseUrl}/v1/messages`,
        { model: cfg.model, max_tokens: 1024, messages: [{ role: "user", content: prompt }] },
        {
          headers: {
            "Content-Type": "application/json",
            "x-api-key": cfg.apiKey,
            "anthropic-version": "2023-06-01",
          },
          timeout: timeoutMs,
        }
      );
      return (res.data.content || []).find((b) => b.type === "text")?.text || null;
    }
    // openai / openrouter / ollama
    if (cfg.provider !== "ollama" && (!cfg.apiKey || cfg.apiKey === "CHANGE_ME")) return null;
    const res = await axios.post(
      `${cfg.baseUrl}/chat/completions`,
      {
        model: cfg.model,
        messages: [{ role: "user", content: prompt }],
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey || "ollama"}`,
        },
        timeout: timeoutMs,
      }
    );
    return res.data.choices?.[0]?.message?.content || null;
  } catch {
    return null;
  }
}

/**
 * Smoke-test the configured AI provider (Settings → Save & test).
 * Returns { provider, model, reply } on success.
 */
export async function testAiConnection() {
  const cfg = getAiConfig();
  requireKey(cfg);

  if (cfg.provider === "gemini") {
    let lastErr;
    for (const model of geminiModelCandidates(cfg.model)) {
      try {
        const res = await geminiGenerate({
          apiKey: cfg.apiKey,
          model,
          body: {
            contents: [{ role: "user", parts: [{ text: "Reply with exactly: ok" }] }],
          },
          timeout: 30000,
        });
        const reply =
          res.data.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text?.trim() || "(empty)";
        return { provider: "gemini", model, reply, host: "generativelanguage.googleapis.com" };
      } catch (err) {
        lastErr = err;
        if (err.response?.status !== 404) {
          throw new Error(formatAiProviderError(err, { ...cfg, model }));
        }
      }
    }
    throw new Error(formatAiProviderError(lastErr, cfg));
  }

  if (cfg.provider === "anthropic") {
    const res = await axios.post(
      `${cfg.baseUrl}/v1/messages`,
      {
        model: cfg.model,
        max_tokens: 32,
        messages: [{ role: "user", content: "Reply with exactly: ok" }],
      },
      {
        headers: {
          "Content-Type": "application/json",
          "x-api-key": cfg.apiKey,
          "anthropic-version": "2023-06-01",
        },
        timeout: 30000,
      }
    );
    const reply = (res.data.content || []).find((b) => b.type === "text")?.text?.trim() || "(empty)";
    return { provider: "anthropic", model: cfg.model, reply, host: cfg.baseUrl };
  }

  if (cfg.provider === "ollama" || cfg.provider === "openai" || cfg.provider === "openrouter") {
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey || "ollama"}`,
    };
    if (cfg.provider === "openrouter") {
      headers["HTTP-Referer"] = env("FORGE_PUBLIC_URL", "http://localhost:4100");
      headers["X-Title"] = "Forge Assist";
    }
    try {
      const res = await axios.post(
        `${cfg.baseUrl}/chat/completions`,
        {
          model: cfg.model,
          messages: [{ role: "user", content: "Reply with exactly: ok" }],
          max_tokens: 16,
        },
        { headers, timeout: 30000 }
      );
      const reply = res.data.choices?.[0]?.message?.content?.trim() || "(empty)";
      return { provider: cfg.provider, model: cfg.model, reply, host: cfg.baseUrl };
    } catch (err) {
      throw new Error(formatAiProviderError(err, cfg));
    }
  }

  throw new Error(`Unsupported AI provider: ${cfg.provider}`);
}
