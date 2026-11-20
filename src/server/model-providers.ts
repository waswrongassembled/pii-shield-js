import type { DetectionModel, ModelPrompt } from '../model/model-detector.js';
import { ModelLocation } from '../model/model-detector.js';

/** Providers of PHP's service configuration (PII_SERVICE_MODEL_PROVIDER). */
export type ModelProvider = 'ollama' | 'generic' | 'mistral' | 'openai' | 'anthropic';

export const MODEL_PROVIDERS: readonly ModelProvider[] = ['ollama', 'generic', 'mistral', 'openai', 'anthropic'];

export interface ProviderSettings {
  provider: ModelProvider;
  /** Model name; default per provider as in PHP (none for `generic`). */
  model?: string | undefined;
  /** Server URL for `ollama` (default http://127.0.0.1:11434) and `generic` (OpenAI-compatible, required). */
  endpoint?: string | undefined;
  /** API key: required for mistral, openai, anthropic; optional for generic. */
  apiKey?: string | undefined;
  /** For tests: the fetch implementation. */
  fetch?: typeof fetch;
}

export interface ResolvedProvider {
  model: DetectionModel;
  location: ModelLocation;
}

/** Defaults of PHP's DemoServices::PROVIDERS. */
const DEFAULT_MODELS: Readonly<Record<ModelProvider, string>> = {
  ollama: 'qwen3:4b-instruct',
  generic: '',
  mistral: 'mistral-small-latest',
  openai: 'gpt-5',
  anthropic: 'claude-sonnet-5-5',
};
/** A normal answer takes a few hundred tokens; a cut answer fails closed (PHP's $answerTokens). */
const ANSWER_TOKENS = 1024;
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal'];

/**
 * A DetectionModel over plain `fetch` for the providers of PHP's service, with PHP's request options:
 * deterministic (temperature 0, except OpenAI and Anthropic), no reasoning and at most 1024 answer tokens
 * for self-hosted models, no redirects. The location follows PHP: `ollama` and `generic` are local when
 * the URL's host is this machine (or host.docker.internal), else on-premise; the others are external.
 *
 * @throws TypeError for an unknown provider, a missing model, key or URL, or a URL that is not http(s)
 */
export function providerModel(settings: ProviderSettings): ResolvedProvider {
  const { provider, apiKey } = settings;
  const doFetch = settings.fetch ?? fetch;
  if (!MODEL_PROVIDERS.includes(provider)) {
    throw new TypeError(`Unknown provider "${provider as string}".`);
  }
  const trimmed = settings.model?.trim() ?? '';
  const model = trimmed === '' ? DEFAULT_MODELS[provider] : trimmed;
  if (model === '') {
    throw new TypeError('Choose a model first.');
  }
  const endpoint = settings.endpoint?.trim() ? validEndpoint(settings.endpoint) : undefined;
  const requireKey = (name: string): string => {
    if (apiKey === undefined || apiKey === '') {
      throw new TypeError(`Set ${name} in the environment of the server to use this provider.`);
    }

    return apiKey;
  };
  const post = async (
    url: string,
    headers: Record<string, string>,
    body: unknown,
    signal: AbortSignal,
  ): Promise<unknown> => {
    const response = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      redirect: 'error',
      signal,
    });
    if (!response.ok) {
      // The body may echo the request (the unredacted text): never put it into the error.
      await response.body?.cancel();
      throw new Error(`HTTP ${String(response.status)}`);
    }

    return response.json();
  };
  const messages = ({ system, user }: ModelPrompt) => [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  switch (provider) {
    case 'ollama': {
      const base = endpoint ?? 'http://127.0.0.1:11434';

      return {
        location: locationOf(base),
        model: {
          name: model,
          generate: async (prompt, { signal }) => {
            // No chain-of-thought (faster); no JSON mode, not every model supports it.
            const data = await post(
              `${base}/api/chat`,
              {},
              {
                model,
                messages: messages(prompt),
                stream: false,
                think: false,
                options: { temperature: 0, num_predict: ANSWER_TOKENS },
              },
              signal,
            );

            return text((data as { message?: { content?: unknown } }).message?.content);
          },
        },
      };
    }
    case 'generic': {
      if (endpoint === undefined) {
        throw new TypeError('Enter the URL of the OpenAI-compatible server.');
      }
      const base = endpoint.replace(/\/v1\/?$/, '');

      return {
        location: locationOf(base),
        model: openAiCompatible(model, `${base}/v1/chat/completions`, apiKey, {
          temperature: 0,
          reasoning_effort: 'none',
          max_tokens: ANSWER_TOKENS,
        }),
      };
    }
    case 'mistral':
      return {
        location: ModelLocation.External,
        model: openAiCompatible(model, 'https://api.mistral.ai/v1/chat/completions', requireKey('MISTRAL_API_KEY'), {
          temperature: 0,
        }),
      };
    case 'openai':
      return {
        location: ModelLocation.External,
        model: openAiCompatible(model, 'https://api.openai.com/v1/chat/completions', requireKey('OPENAI_API_KEY'), {}),
      };
    case 'anthropic': {
      const key = requireKey('ANTHROPIC_API_KEY');

      return {
        location: ModelLocation.External,
        model: {
          name: model,
          // Current Claude models reject sampling parameters.
          generate: async ({ system, user }, { signal }) => {
            const data = await post(
              'https://api.anthropic.com/v1/messages',
              { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
              { model, max_tokens: 4096, system, messages: [{ role: 'user', content: user }] },
              signal,
            );
            const content = (data as { content?: { type?: unknown; text?: unknown }[] }).content ?? [];

            return text(
              content
                .filter((c) => c.type === 'text')
                .map((c) => c.text)
                .join(''),
            );
          },
        },
      };
    }
  }

  function openAiCompatible(
    name: string,
    url: string,
    key: string | undefined,
    options: Record<string, unknown>,
  ): DetectionModel {
    return {
      name,
      generate: async (prompt, { signal }) => {
        const data = await post(
          url,
          key === undefined || key === '' ? {} : { Authorization: `Bearer ${key}` },
          { model: name, messages: messages(prompt), ...options },
          signal,
        );

        return text((data as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content);
      },
    };
  }
}

/** PHP's DemoServices::validEndpoint(): trimmed, without trailing slashes, http or https. */
export function validEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, '');
  let protocol: string;
  try {
    protocol = new URL(trimmed).protocol;
  } catch {
    protocol = '';
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new TypeError('The server URL must start with http:// or https://.');
  }

  return trimmed;
}

function locationOf(endpoint: string): ModelLocation {
  return LOCAL_HOSTS.includes(new URL(endpoint).hostname) ? ModelLocation.Local : ModelLocation.OnPremise;
}

function text(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError('The model answered without text.');
  }

  return value;
}
