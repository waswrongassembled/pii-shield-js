import {
  generateText,
  jsonSchema,
  type LanguageModelMiddleware,
  type ModelMessage,
  Output,
  simulateReadableStream,
  stepCountIs,
  streamText,
  tool,
  type ToolResultPart,
  wrapLanguageModel,
} from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';

import {
  piiShieldMiddleware,
  type PiiShieldMiddlewareOptions,
  type RedactEvent,
  type RestoreEvent,
  UnsupportedContentError,
} from '../src/ai-sdk/index.js';
import { InMemoryVault, ModelDetector, PiiShield, PiiShieldError, defaultDetectors } from '../src/index.js';

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
type CallOptions = MockLanguageModelV4['doGenerateCalls'][number];
type StreamPart =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never;
type Content = GenerateResult['content'][number];

const LETTER =
  'Herrn\nJohann Beispielmann\nBahnhofstraße 7/3\n4020 Linz\n\nSVNR 4568 150392\nIBAN AT61 1904 3002 3457 3201\nBetrag 1.245,00 Euro, fällig am 15.11.2026.';
const ORIGINALS = ['Johann Beispielmann', 'Bahnhofstraße 7/3', '4568 150392', 'AT61 1904 3002 3457 3201'];

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const FINISH = { unified: 'stop', raw: 'stop' } as const;

function generated(...content: Content[]): GenerateResult {
  return { content, finishReason: FINISH, usage: USAGE, warnings: [] };
}

const text = (value: string): Content => ({ type: 'text', text: value });

function streamOf(parts: StreamPart[]): Awaited<ReturnType<MockLanguageModelV4['doStream']>> {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'stream-start', warnings: [] },
        ...parts,
        { type: 'finish', usage: USAGE, finishReason: FINISH },
      ],
    }),
  };
}

function textStream(id: string, deltas: string[]): StreamPart[] {
  return [
    { type: 'text-start', id },
    ...deltas.map((delta): StreamPart => ({ type: 'text-delta', id, delta })),
    { type: 'text-end', id },
  ];
}

function setup(
  answer: Content[] | ((options: CallOptions) => GenerateResult),
  options: PiiShieldMiddlewareOptions & { shield?: PiiShield } = {},
) {
  const redactions: RedactEvent[] = [];
  const restores: RestoreEvent[] = [];
  const mock = new MockLanguageModelV4({
    doGenerate: (callOptions) =>
      Promise.resolve(typeof answer === 'function' ? answer(callOptions) : generated(...answer)),
  });
  const middleware = piiShieldMiddleware(options.shield ?? new PiiShield(), {
    ...options,
    onRedact: (event) => redactions.push(event),
    onRestore: (event) => restores.push(event),
  });
  const model = wrapLanguageModel({ model: mock, middleware });

  return { mock, model, middleware, redactions, restores };
}

/** Everything that left the process for the provider: the call options as JSON. */
function sent(mock: MockLanguageModelV4): string {
  return JSON.stringify([...mock.doGenerateCalls, ...mock.doStreamCalls]);
}

function systemAndMessages(calls: CallOptions[]): unknown[] {
  return (calls[0]?.prompt ?? []).map((message) =>
    typeof message.content === 'string'
      ? message.content
      : message.content.map((part) => ('text' in part ? part.text : part)),
  );
}

describe('piiShieldMiddleware (PHP PiiShieldProcessorTest)', () => {
  it('no personal data reaches the provider', async () => {
    const { mock, model } = setup([text('ok')]);

    await generateText({ model, instructions: 'Erkläre den Brief.', prompt: LETTER });

    const payload = sent(mock);
    for (const original of ORIGINALS) {
      expect(payload).not.toContain(original);
    }
    expect(payload).toContain('⟦PERSON_1⟧');
    expect(payload).toContain('⟦SVNR_1⟧');
    expect(payload, 'amounts must survive').toContain('1.245,00 Euro');
    expect(payload, 'deadlines must survive').toContain('15.11.2026');
  });

  it('the text answer is restored', async () => {
    const { model } = setup([text('⟦PERSON_1⟧, bitte überweisen Sie auf ⟦IBAN_1⟧.')]);

    const result = await generateText({ model, prompt: LETTER });

    expect(result.text).toBe('Johann Beispielmann, bitte überweisen Sie auf AT61 1904 3002 3457 3201.');
  });

  it('placeholders are consistent across messages', async () => {
    const { mock, model } = setup([text('ok')]);

    await generateText({
      model,
      instructions: 'Konto der Behörde: IBAN DE89 3704 0044 0532 0130 00',
      messages: [
        { role: 'assistant', content: 'Ihr Konto AT61 1904 3002 3457 3201 ist hinterlegt.' },
        { role: 'user', content: 'Überweise von AT61 1904 3002 3457 3201 auf DE89 3704 0044 0532 0130 00.' },
      ],
    });

    expect(systemAndMessages(mock.doGenerateCalls)).toEqual([
      'Konto der Behörde: IBAN ⟦IBAN_1⟧',
      ['Ihr Konto ⟦IBAN_2⟧ ist hinterlegt.'],
      ['Überweise von ⟦IBAN_2⟧ auf ⟦IBAN_1⟧.'],
    ]);
  });

  it('multi-part user messages are redacted part by part', async () => {
    const { mock, model } = setup([text('ok')]);

    await generateText({
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'SVNR 4568 150392' },
            { type: 'text', text: 'nochmal: 4568 150392' },
          ],
        },
      ],
    });

    expect(sent(mock)).not.toContain('4568 150392');
    expect(systemAndMessages(mock.doGenerateCalls)).toEqual([['SVNR ⟦SVNR_1⟧', 'nochmal: ⟦SVNR_1⟧']]);
  });

  it('images are rejected before anything is sent', async () => {
    const { mock, model } = setup([text('ok')]);

    const call = generateText({
      model,
      maxRetries: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Siehe Foto' },
            { type: 'file', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mediaType: 'image/png' },
          ],
        },
      ],
    });

    await expect(call).rejects.toThrow(UnsupportedContentError);
    await expect(call).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONTENT',
      message: 'Content of type "file" cannot be redacted. Extract its text locally and send text only.',
    });
    expect(mock.doGenerateCalls).toEqual([]);
  });

  it('structured output is restored deeply', async () => {
    const answer = JSON.stringify({
      summary: 'Das Finanzamt schreibt ⟦PERSON_1⟧ an ⟦ADDRESS_1⟧.',
      actions: ['Überweisen Sie auf ⟦IBAN_1⟧', 'Fragen? Ihre SVNR: ⟦SVNR_1⟧'],
      payment: { iban: '⟦IBAN_1⟧', reference: 'Steuer 2026', dueDate: '2026-11-15' },
      amountInCents: 124500,
    });
    const { mock, model } = setup([text(answer)]);
    const schema = jsonSchema<{
      summary: string;
      actions: string[];
      payment: { iban: string; reference: string; dueDate: string };
      amountInCents: number;
    }>({ type: 'object' });

    const result = await generateText({ model, prompt: LETTER, output: Output.object({ schema }) });

    expect(mock.doGenerateCalls[0]?.responseFormat?.type).toBe('json');
    expect(result.output).toEqual({
      summary: 'Das Finanzamt schreibt Johann Beispielmann an Bahnhofstraße 7/3\n4020 Linz.',
      actions: ['Überweisen Sie auf AT61 1904 3002 3457 3201', 'Fragen? Ihre SVNR: 4568 150392'],
      payment: { iban: 'AT61 1904 3002 3457 3201', reference: 'Steuer 2026', dueDate: '2026-11-15' },
      amountInCents: 124500,
    });
  });

  it('invented placeholders are reported', async () => {
    const { model, restores } = setup([text('⟦PERSON_1⟧ und ⟦PERSON_9⟧, [[person 9]]')]);

    const result = await generateText({ model, prompt: LETTER });

    expect(result.text).toBe('Johann Beispielmann und ⟦PERSON_9⟧, [[person 9]]');
    expect(restores).toEqual([{ unknownPlaceholders: ['⟦PERSON_9⟧'] }]);
  });

  it('the answer to a call it did not redact is left alone', async () => {
    const { middleware } = setup([]);
    const result = generated(text('⟦PERSON_1⟧'));
    const params = { prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hallo' }] }] };

    const restored = await middleware.wrapGenerate?.({
      doGenerate: () => Promise.resolve(result),
      doStream: () => Promise.reject(new Error('unused')),
      params,
      model: new MockLanguageModelV4(),
    });

    expect(restored).toBe(result);
  });
});

describe('piiShieldMiddleware: prompt', () => {
  it('redacts tool calls and tool results in the history with the same mapping', async () => {
    const { mock, model } = setup([text('ok')]);
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Prüfe AT61 1904 3002 3457 3201.' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Die IBAN AT61 1904 3002 3457 3201 prüfen.' },
          {
            type: 'tool-call',
            toolCallId: 'c1',
            toolName: 'check',
            input: { iban: 'AT61 1904 3002 3457 3201', 'AT61 1904 3002 3457 3201': 1 },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'check',
            output: {
              type: 'json',
              value: { owner: 'SVNR 4568 150392', valid: true, list: ['AT61 1904 3002 3457 3201'] },
            },
          },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'Und DE89 3704 0044 0532 0130 00?' }] },
    ];

    await generateText({ model, messages });

    const prompt = mock.doGenerateCalls[0]?.prompt;
    expect(prompt?.[1]?.content).toEqual([
      expect.objectContaining({ type: 'reasoning', text: 'Die IBAN ⟦IBAN_1⟧ prüfen.' }),
      expect.objectContaining({
        type: 'tool-call',
        input: { iban: '⟦IBAN_1⟧', '⟦IBAN_1⟧': 1 },
      }),
    ]);
    expect(prompt?.[2]?.content).toEqual([
      expect.objectContaining({
        output: { type: 'json', value: { owner: 'SVNR ⟦SVNR_1⟧', valid: true, list: ['⟦IBAN_1⟧'] } },
      }),
    ]);
    expect(prompt?.[3]?.content).toEqual([expect.objectContaining({ text: 'Und ⟦IBAN_2⟧?' })]);
  });

  it.each([
    ['text', { type: 'text', value: 'SVNR 4568 150392' }, { type: 'text', value: 'SVNR ⟦SVNR_1⟧' }],
    ['error-text', { type: 'error-text', value: 'SVNR 4568 150392' }, { type: 'error-text', value: 'SVNR ⟦SVNR_1⟧' }],
    [
      'error-json',
      { type: 'error-json', value: ['SVNR 4568 150392'] },
      { type: 'error-json', value: ['SVNR ⟦SVNR_1⟧'] },
    ],
    [
      'execution-denied',
      { type: 'execution-denied', reason: 'SVNR 4568 150392' },
      { type: 'execution-denied', reason: 'SVNR ⟦SVNR_1⟧' },
    ],
    [
      'content',
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- flags the union's deprecated 'file-data' member
      { type: 'content', value: [{ type: 'text', text: 'SVNR 4568 150392' }] },
      { type: 'content', value: [{ type: 'text', text: 'SVNR ⟦SVNR_1⟧' }] },
    ],
  ] satisfies [string, ToolResultPart['output'], unknown][])(
    'redacts a %s tool output',
    async (_type, output, expected) => {
      const { mock, model } = setup([text('ok')]);

      await generateText({
        model,
        messages: [
          { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'check', input: {} }] },
          { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'check', output }] },
        ],
      });

      expect(mock.doGenerateCalls[0]?.prompt[1]?.content).toEqual([expect.objectContaining({ output: expected })]);
    },
  );

  it('rejects files in tool results', async () => {
    const { mock, model } = setup([text('ok')]);

    const call = generateText({
      model,
      maxRetries: 0,
      messages: [
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'scan', input: {} }] },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c1',
              toolName: 'scan',
              output: {
                type: 'content',
                // eslint-disable-next-line @typescript-eslint/no-deprecated -- flags the union's deprecated 'file-data' member
                value: [{ type: 'file', data: { type: 'data', data: 'AAAA' }, mediaType: 'image/png' }],
              },
            },
          ],
        },
      ],
    });

    await expect(call).rejects.toThrow(UnsupportedContentError);
    expect(mock.doGenerateCalls).toEqual([]);
  });

  it.each([
    ['file', { type: 'file', data: 'AAAA', mediaType: 'image/png' }],
    ['reasoning-file', { type: 'reasoning-file', data: 'AAAA', mediaType: 'image/png' }],
    ['custom', { type: 'custom', kind: 'test.custom' }],
  ] as const)('rejects %s parts of assistant messages by default (fail closed)', async (type, part) => {
    const { mock, model } = setup([text('ok')]);

    await expect(
      model.doGenerate({
        prompt: [
          { role: 'user', content: [{ type: 'text', text: 'Male ein Bild.' }] },
          { role: 'assistant', content: [part as never] },
        ],
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT', message: expect.stringContaining(`"${type}"`) as string });
    expect(mock.doGenerateCalls).toEqual([]);
  });

  it('passes files of assistant messages unchanged when allowed', async () => {
    const { mock, model } = setup([text('ok')], { allowOpaqueAssistantParts: true });

    await generateText({
      model,
      messages: [
        { role: 'user', content: 'Male ein Bild.' },
        { role: 'assistant', content: [{ type: 'file', data: 'AAAA', mediaType: 'image/png' }] },
      ],
    });

    expect(mock.doGenerateCalls[0]?.prompt[1]?.content).toEqual([
      expect.objectContaining({ type: 'file', mediaType: 'image/png' }),
    ]);
  });

  it('redacts keys of JSON tool outputs and tool call inputs', async () => {
    const { mock, model } = setup([text('ok')]);

    await model.doGenerate({
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'Wer ist das?' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: { 'AT61 1904 3002 3457 3201': 'IBAN' } },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c1',
              toolName: 'lookup',
              output: { type: 'json', value: { 'SVNR 4568 150392': { iban: 'AT61 1904 3002 3457 3201' } } },
            },
          ],
        },
      ],
    });

    const sent = JSON.stringify(mock.doGenerateCalls[0]?.prompt);
    expect(sent).not.toContain('AT61 1904');
    expect(sent).not.toContain('150392');
    expect(sent).toContain('⟦IBAN_1⟧');
  });

  it('keeps the mapping out of the call options and redacts every step of a tool loop', async () => {
    const executed: unknown[] = [];
    let step = 0;
    const { mock, model } = setup((options) => {
      step++;
      if (step === 1) {
        return generated({
          type: 'tool-call',
          toolCallId: 'c1',
          toolName: 'lookup',
          input: JSON.stringify({ iban: '⟦IBAN_1⟧' }),
        });
      }
      const last = JSON.stringify(options.prompt.at(-1));

      return generated(text(`Inhaber laut Tool: ${last.includes('⟦PERSON_1⟧') ? '⟦PERSON_1⟧' : '?'}`));
    });

    const result = await generateText({
      model,
      prompt: LETTER,
      stopWhen: stepCountIs(3),
      tools: {
        lookup: tool({
          inputSchema: jsonSchema<{ iban: string }>({ type: 'object', properties: { iban: { type: 'string' } } }),
          execute: (input) => {
            executed.push(input);

            return { owner: 'Johann Beispielmann', iban: input.iban };
          },
        }),
      },
    });

    expect(executed).toEqual([{ iban: 'AT61 1904 3002 3457 3201' }]);
    expect(result.text).toBe('Inhaber laut Tool: Johann Beispielmann');
    expect(mock.doGenerateCalls).toHaveLength(2);
    const payload = sent(mock);
    for (const original of ORIGINALS) {
      expect(payload).not.toContain(original);
    }
  });

  it('fails when a text contains the internal separator', async () => {
    const { mock, model } = setup([text('ok')]);

    await expect(generateText({ model, maxRetries: 0, prompt: `a\n\u{2063}\u{2063}\u{2063}\nb` })).rejects.toThrow(
      'Redaction changed the message structure.',
    );
    expect(mock.doGenerateCalls).toEqual([]);
  });

  it('runs async detectors with the call’s abort signal', async () => {
    const signals: AbortSignal[] = [];
    const detector = new ModelDetector({
      location: 'local',
      model: async (_prompt, { signal }) => {
        signals.push(signal);

        return Promise.resolve('{"entities":[{"type":"PERSON","value":"Maria Muster"}]}');
      },
    });
    const shield = new PiiShield({ detectors: [...defaultDetectors(), detector] });
    const { mock, model } = setup([text('Hallo ⟦PERSON_1⟧')], { shield });
    const controller = new AbortController();

    const result = await generateText({ model, prompt: 'Maria Muster fragt.', abortSignal: controller.signal });

    expect(sent(mock)).not.toContain('Maria Muster');
    expect(result.text).toBe('Hallo Maria Muster');
    expect(signals).toHaveLength(1);
  });

  it('stores the mapping in the vault and reports its id', async () => {
    const shield = new PiiShield({ vault: new InMemoryVault() });
    const { model, redactions } = setup([text('⟦IBAN_1⟧')], { shield, vault: true });

    await generateText({ model, prompt: 'Konto AT61 1904 3002 3457 3201' });

    expect(redactions).toHaveLength(1);
    expect(redactions[0]?.placeholders).toEqual(['⟦IBAN_1⟧']);
    const vaultId = redactions[0]?.vaultId ?? '';
    expect(vaultId).toMatch(/^[0-9a-f]{32}$/);
    expect((await shield.restoreFromVault('Neu: ⟦IBAN_1⟧', vaultId)).text).toBe('Neu: AT61 1904 3002 3457 3201');
  });

  it('reports placeholders but no values', async () => {
    const { redactions } = await (async () => {
      const s = setup([text('ok')]);
      await generateText({ model: s.model, prompt: LETTER });

      return s;
    })();

    expect(JSON.stringify(redactions)).not.toMatch(/Beispielmann|4568|AT61/);
    expect(redactions[0]?.placeholders).toContain('⟦PERSON_1⟧');
  });

  it('needs a vault-capable shield for the vault option', () => {
    const shield = { redact: () => undefined, redactAsync: () => undefined, restore: () => undefined };

    expect(() => piiShieldMiddleware(shield as never, { vault: true })).toThrow(TypeError);
  });

  it('UnsupportedContentError is a PiiShieldError', () => {
    expect(new UnsupportedContentError('x')).toBeInstanceOf(PiiShieldError);
  });
});

describe('piiShieldMiddleware: generate answer', () => {
  it('restores reasoning, tool call inputs (keys and values) and provider tool results; keeps metadata', async () => {
    const providerMetadata = { mock: { signature: '⟦PERSON_1⟧' } };
    const { model, middleware } = setup([]);
    const answer = generated(
      { type: 'reasoning', text: 'Für ⟦PERSON_1⟧', providerMetadata },
      { type: 'text', text: 'An ⟦PERSON_1⟧', providerMetadata },
      {
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'pay',
        input: '{"iban":"⟦IBAN_1⟧","⟦IBAN_1⟧":["⟦ADDRESS_1⟧",1,null]}',
      },
      { type: 'tool-call', toolCallId: 'c2', toolName: 'pay', input: '{"amount": 1}' },
      { type: 'tool-result', toolCallId: 'c3', toolName: 'search', result: { hit: '⟦PERSON_1⟧' } },
      { type: 'source', sourceType: 'url', id: 's1', url: 'https://example.org/⟦PERSON_1⟧' },
    );
    const params = await middleware.transformParams?.({
      type: 'generate',
      params: { prompt: [{ role: 'user', content: [{ type: 'text', text: LETTER }] }] },
      model,
    });

    const result = await middleware.wrapGenerate?.({
      doGenerate: () => Promise.resolve(answer),
      doStream: () => Promise.reject(new Error('unused')),
      params: params ?? { prompt: [] },
      model,
    });

    expect(result?.content).toEqual([
      { type: 'reasoning', text: 'Für Johann Beispielmann', providerMetadata },
      { type: 'text', text: 'An Johann Beispielmann', providerMetadata },
      {
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'pay',
        input: JSON.stringify({
          iban: 'AT61 1904 3002 3457 3201',
          // Keys are restored too.
          'AT61 1904 3002 3457 3201': ['Bahnhofstraße 7/3\n4020 Linz', 1, null],
        }),
      },
      { type: 'tool-call', toolCallId: 'c2', toolName: 'pay', input: '{"amount": 1}' },
      { type: 'tool-result', toolCallId: 'c3', toolName: 'search', result: { hit: 'Johann Beispielmann' } },
      { type: 'source', sourceType: 'url', id: 's1', url: 'https://example.org/⟦PERSON_1⟧' },
    ]);
    expect(providerMetadata.mock.signature).toBe('⟦PERSON_1⟧');
  });

  it('restores an invalid JSON tool input JSON-escaped', async () => {
    const { model, middleware } = setup([]);
    const params = await middleware.transformParams?.({
      type: 'generate',
      params: { prompt: [{ role: 'user', content: [{ type: 'text', text: LETTER }] }] },
      model,
    });

    const result = await middleware.wrapGenerate?.({
      doGenerate: () =>
        Promise.resolve(generated({ type: 'tool-call', toolCallId: 'c', toolName: 't', input: '{"a":"⟦ADDRESS_1⟧"' })),
      doStream: () => Promise.reject(new Error('unused')),
      params: params ?? { prompt: [] },
      model,
    });

    expect(result?.content[0]).toMatchObject({ input: '{"a":"Bahnhofstraße 7/3\\n4020 Linz"' });
  });

  it('restores structuredOutputText JSON-escaped', async () => {
    const { model, middleware } = setup([]);
    const params = await middleware.transformParams?.({
      type: 'generate',
      params: {
        prompt: [{ role: 'user', content: [{ type: 'text', text: LETTER }] }],
        responseFormat: { type: 'json' },
      },
      model,
    });

    const result = await middleware.wrapGenerate?.({
      doGenerate: () =>
        Promise.resolve({ ...generated(text('draft ⟦PERSON_1⟧')), structuredOutputText: '{"a":"⟦ADDRESS_1⟧"}' }),
      doStream: () => Promise.reject(new Error('unused')),
      params: params ?? { prompt: [] },
      model,
    });

    expect(result?.structuredOutputText).toBe('{"a":"Bahnhofstraße 7/3\\n4020 Linz"}');
    expect(result?.content[0]).toMatchObject({ text: 'draft Johann Beispielmann' });
  });
});

describe('piiShieldMiddleware: stream', () => {
  function streamingSetup(parts: StreamPart[], options: PiiShieldMiddlewareOptions & { shield?: PiiShield } = {}) {
    const restores: RestoreEvent[] = [];
    const mock = new MockLanguageModelV4({ doStream: () => Promise.resolve(streamOf(parts)) });
    const model = wrapLanguageModel({
      model: mock,
      middleware: piiShieldMiddleware(options.shield ?? new PiiShield(), {
        ...options,
        onRestore: (event) => restores.push(event),
      }),
    });

    return { mock, model, restores };
  }

  async function rawParts(model: ReturnType<typeof wrapLanguageModel>, prompt: string): Promise<StreamPart[]> {
    const { stream } = await model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] });
    const parts: StreamPart[] = [];
    for await (const part of stream) {
      parts.push(part);
    }

    return parts;
  }

  it('restores text split across chunks and never emits part of a placeholder', async () => {
    const { mock, model, restores } = streamingSetup(
      textStream('t1', ['Sehr geehrte', 'r ⟦PERS', 'ON_1⟧, Ihr Konto [', '[iban 1', ']] ist ⟦PERSON_7⟧.']),
    );

    const result = streamText({ model, prompt: LETTER });
    const deltas: string[] = [];
    for await (const delta of result.textStream) {
      deltas.push(delta);
    }

    expect(deltas.join('')).toBe(
      'Sehr geehrter Johann Beispielmann, Ihr Konto AT61 1904 3002 3457 3201 ist ⟦PERSON_7⟧.',
    );
    for (const delta of deltas) {
      expect(delta).not.toMatch(/⟦PERS(?!ON_7⟧)|\[\[|\[$/);
    }
    expect(sent(mock)).not.toContain('Beispielmann');
    expect(restores).toEqual([{ unknownPlaceholders: ['⟦PERSON_7⟧'] }]);
  });

  it('restores reasoning and tool input deltas, flushes held text at the end of a block', async () => {
    const providerMetadata = { mock: { cache: 'x' } };
    const { model } = streamingSetup([
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-delta', id: 'r1', delta: 'Brief an ⟦PER' },
      { type: 'reasoning-delta', id: 'r1', delta: 'SON_1⟧ [[' },
      { type: 'reasoning-end', id: 'r1' },
      { type: 'tool-input-start', id: 'c1', toolName: 'pay' },
      { type: 'tool-input-delta', id: 'c1', delta: '{"to":"⟦ADDR' },
      { type: 'tool-input-delta', id: 'c1', delta: 'ESS_1⟧"}', providerMetadata },
      { type: 'tool-input-end', id: 'c1' },
      { type: 'tool-input-start', id: 'c2', toolName: 'note', inputEncoding: 'text' },
      { type: 'tool-input-delta', id: 'c2', delta: '⟦ADDRESS_1⟧' },
      { type: 'tool-input-end', id: 'c2' },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'pay', input: '{"to":"⟦ADDRESS_1⟧"}' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'Ende ⟦' },
    ]);

    const parts = await rawParts(model, LETTER);

    expect(parts.filter((p) => p.type !== 'stream-start')).toEqual([
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-delta', id: 'r1', delta: 'Brief an ' },
      { type: 'reasoning-delta', id: 'r1', delta: 'Johann Beispielmann ' },
      { type: 'reasoning-delta', id: 'r1', delta: '[[' },
      { type: 'reasoning-end', id: 'r1' },
      { type: 'tool-input-start', id: 'c1', toolName: 'pay' },
      { type: 'tool-input-delta', id: 'c1', delta: '{"to":"' },
      { type: 'tool-input-delta', id: 'c1', delta: 'Bahnhofstraße 7/3\\n4020 Linz"}', providerMetadata },
      { type: 'tool-input-end', id: 'c1' },
      { type: 'tool-input-start', id: 'c2', toolName: 'note', inputEncoding: 'text' },
      { type: 'tool-input-delta', id: 'c2', delta: 'Bahnhofstraße 7/3\n4020 Linz' },
      { type: 'tool-input-end', id: 'c2' },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'pay', input: '{"to":"Bahnhofstraße 7/3\\n4020 Linz"}' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'Ende ' },
      { type: 'text-delta', id: 't1', delta: '⟦' },
      { type: 'finish', usage: USAGE, finishReason: FINISH },
    ]);
  });

  it('streams structured output as valid JSON', async () => {
    const { model } = streamingSetup(textStream('t1', ['{"summary":"An ⟦ADD', 'RESS_1⟧"}']));
    const schema = jsonSchema<{ summary: string }>({ type: 'object' });

    const result = streamText({ model, prompt: LETTER, output: Output.object({ schema }) });

    expect(await result.output).toEqual({ summary: 'An Bahnhofstraße 7/3\n4020 Linz' });
  });

  it('passes the stream of a call it did not redact', async () => {
    const parts = textStream('t1', ['⟦PERSON_1⟧']);
    const middleware: LanguageModelMiddleware = piiShieldMiddleware(new PiiShield());
    const stream = simulateReadableStream({ chunks: parts });

    const result = await middleware.wrapStream?.({
      doGenerate: () => Promise.reject(new Error('unused')),
      doStream: () => Promise.resolve({ stream }),
      params: { prompt: [] },
      model: new MockLanguageModelV4(),
    });

    expect(result?.stream).toBe(stream);
  });

  it('random chunk splits give the same answer as generate', async () => {
    const answer =
      'Sehr geehrter ⟦PERSON_1⟧, [[person 1]] wohnt in ⟦ADDRESS_1⟧. SVNR ⟦SVNR\\_1⟧, IBAN [[ IBAN 1 ]], ⟦PERSON_2⟧ [x] [[ ]] ⟦⟧ 😀 ⟦IBAN_1⟧';
    const generatedText = (await generateText({ model: setup([text(answer)]).model, prompt: LETTER })).text;
    expect(generatedText).toContain('Johann Beispielmann, Johann Beispielmann wohnt');

    let seed = 7;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;

      return seed / 2147483648;
    };
    for (let run = 0; run < 20; run++) {
      const units = [...answer];
      const deltas: string[] = [];
      for (let i = 0; i < units.length;) {
        const size = 1 + Math.floor(next() * 5);
        deltas.push(units.slice(i, i + size).join(''));
        i += size;
      }
      const { model } = streamingSetup(textStream('t1', deltas));

      const result = streamText({ model, prompt: LETTER });

      expect(await result.text, JSON.stringify(deltas)).toBe(generatedText);
    }
  });
});
