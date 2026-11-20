/**
 * @waswrongassembled/pii-shield/ai-sdk: Vercel AI SDK integration. Needs the `ai` package (peer dependency).
 */
import { generateText, type LanguageModel, type LanguageModelCallOptions } from 'ai';

import type { DetectionModel } from '../model/model-detector.js';

/** Settings passed to `generateText()` for every detection call, e.g. `{ temperature: 0, maxOutputTokens: 1024 }`. */
export type DetectionModelSettings = LanguageModelCallOptions &
  Pick<Parameters<typeof generateText>[0], 'maxRetries' | 'headers' | 'providerOptions'>;

/**
 * An AI SDK language model as the model of a ModelDetector:
 *
 * ```ts
 * new ModelDetector({ model: detectionModel(ollama('qwen3:8b'), { temperature: 0 }), location: 'local' })
 * ```
 *
 * The location is still yours to state: the AI SDK cannot tell where a provider runs. A plain model id
 * string goes through the AI Gateway, an external provider.
 */
export function detectionModel(model: LanguageModel, settings: DetectionModelSettings = {}): DetectionModel {
  return {
    name: typeof model === 'string' ? model : model.modelId,
    generate: async ({ system, user }, { signal }) => {
      const result = await generateText({
        ...settings,
        model,
        instructions: system,
        prompt: user,
        abortSignal: signal,
      });

      return result.text;
    },
  };
}
