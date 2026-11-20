import { encodeJson } from '../learning/json-file-store.js';
import type { JsonBody } from '../service/json-body.js';
import type { ServiceApi, ServiceOperation } from '../service/service-api.js';

/** JSON Schema of a tool's arguments (the subset these tools use). */
interface PropertySchema {
  readonly type: 'string' | 'array' | 'boolean';
  readonly description: string;
  readonly default?: unknown;
  readonly enum?: readonly string[];
  readonly pattern?: string;
  readonly items?: { readonly type: 'string' };
}

export interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, PropertySchema>>;
    readonly required?: readonly string[];
  };
  readonly annotations: Readonly<Record<string, boolean>>;
}

/**
 * The tools of PHP's PiiShieldTools: same names, titles, descriptions, input schemas and annotations
 * (as PHP's MCP SDK generates them).
 */
export const TOOLS: readonly ToolDefinition[] = Object.freeze([
  {
    name: 'redact_text',
    title: 'Redact personal data',
    description:
      'Replaces personal data (names, addresses, IDs, IBANs, …) with placeholders such as ⟦PERSON_1⟧, so the text can be given to any model. Returns the redacted text, a vaultId for restore_text and the placeholder types; never the original values.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text with personal data, e.g. a letter.' },
        detection: {
          type: 'string',
          default: 'regex',
          description: "regex (patterns, offline), model (the server's configured model) or both.",
          enum: ['regex', 'model', 'both'],
        },
      },
      required: ['text'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'restore_text',
    title: 'Restore placeholders',
    description:
      'Puts the original values back into a text with placeholders (typically a model answer), using the vaultId from redact_text. Placeholders the model invented are reported.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text containing placeholders like ⟦PERSON_1⟧.' },
        vaultId: { type: 'string', description: 'vaultId returned by redact_text.' },
      },
      required: ['text', 'vaultId'],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'mask_text',
    title: 'Mask personal data irreversibly',
    description:
      'Masks personal data for logs and previews (e.g. AT61 **** **** **** 3201, [PERSON]). Nothing is stored; there is no way back.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text with personal data.' } },
      required: ['text'],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'learn_entity_type',
    title: 'Learn a new kind of personal data',
    description:
      'Teaches pii-shield a new entity type from examples ("mask things like this too"). A pattern is derived from the examples; plain words become model-only types. Use synthetic examples only: they are stored. dryRun previews without saving.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'UPPER_SNAKE_CASE name, becomes the placeholder name, e.g. INSURANCE_NUMBER.',
          pattern: '^[A-Z][A-Z0-9_]{1,39}$',
        },
        examples: { type: 'array', description: 'Examples of the value, one per item.', items: { type: 'string' } },
        description: { type: 'string', default: '', description: 'What it is; helps the model.' },
        counterExamples: {
          type: 'array',
          default: [],
          description: 'Similar values that are not this type.',
          items: { type: 'string' },
        },
        dryRun: { type: 'boolean', default: false, description: 'Only derive and validate, do not save.' },
      },
      required: ['name', 'examples'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'list_entity_types',
    title: 'List learned entity types',
    description: 'Lists the entity types learned from examples, with their patterns.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
] satisfies ToolDefinition[]);

/** Server info and instructions of PHP's MCP server configuration. */
export const SERVER_INFO = Object.freeze({
  name: 'pii-shield',
  version: '1.0.0',
  description: 'Reversible redaction, masking and learning of personal data.',
});
export const SERVER_INSTRUCTIONS =
  'Before giving text with personal data to a model, call redact_text and work with the placeholders. restore_text returns the original values to you, the calling model: call it only if you run locally or the user asked for the restored text; otherwise give the user the answer with placeholders and the vaultId to restore it themselves.';

/** Result of a tool call (MCP CallToolResult). */
export type ToolResult =
  | { content: [{ type: 'text'; text: string }]; structuredContent: Record<string, unknown>; isError?: never }
  | { content: [{ type: 'text'; text: string }]; isError: true };

/** A protocol error (JSON-RPC "invalid params"), e.g. unknown tool or arguments that violate the schema. */
export class InvalidToolCall extends Error {}

const TOOL_OPERATIONS: Readonly<
  Record<string, (args: Readonly<Record<string, unknown>>) => [ServiceOperation, JsonBody]>
> = {
  redact_text: (a) => ['redact', { text: a['text'], detection: a['detection'] ?? 'regex' }],
  restore_text: (a) => ['restore', { text: a['text'], vaultId: a['vaultId'] }],
  mask_text: (a) => ['mask', { text: a['text'] }],
  learn_entity_type: (a) => [
    'learn',
    {
      name: a['name'],
      description: a['description'] ?? '',
      examples: a['examples'],
      counterExamples: a['counterExamples'] ?? [],
      dryRun: a['dryRun'] ?? false,
    },
  ],
  list_entity_types: () => ['entities', {}],
};

/**
 * Runs a tool like PHP's PiiShieldTools: the arguments are checked against the input schema (an
 * InvalidToolCall with the first violation), then the ServiceApi operation runs. An API error (status
 * >= 400) becomes a tool result with `isError`, so the model sees the message; success returns the JSON
 * body as pretty-printed text and as `structuredContent`.
 */
export async function callTool(
  api: ServiceApi,
  name: string,
  args: Readonly<Record<string, unknown>> | undefined,
  options: { signal?: AbortSignal | undefined } = {},
): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
  const toOperation = Object.hasOwn(TOOL_OPERATIONS, name) ? TOOL_OPERATIONS[name] : undefined;
  if (tool === undefined || toOperation === undefined) {
    throw new InvalidToolCall(`Tool not found: "${name}".`);
  }
  const values = args ?? {};
  const violation = validate(tool, values);
  if (violation !== null) {
    throw new InvalidToolCall(`Invalid parameters for tool '${name}': ${violation}`);
  }

  const [operation, body] = toOperation(values);
  const response = await api.operation(operation, body, { signal: options.signal });
  if (response.status >= 400) {
    const error = response.body?.['error'];

    return {
      content: [{ type: 'text', text: typeof error === 'string' ? error : 'The operation failed.' }],
      isError: true,
    };
  }
  const result = response.body ?? {};

  return { content: [{ type: 'text', text: encodeJson(result) }], structuredContent: { ...result } };
}

/** The first schema violation in the wording of PHP's MCP SDK (opis/json-schema), or null. */
function validate(tool: ToolDefinition, args: Readonly<Record<string, unknown>>): string | null {
  const { properties, required = [] } = tool.inputSchema;
  const missing = required.filter((key) => !Object.hasOwn(args, key));
  if (missing.length > 0) {
    return `Missing required properties: ${missing.map((k) => `\`${k}\``).join(', ')}.`;
  }
  for (const [key, schema] of Object.entries(properties)) {
    if (!Object.hasOwn(args, key)) {
      continue;
    }
    const value = args[key];
    const pointer = `Property '/${key}': `;
    if (jsonType(value) !== schema.type) {
      return `${pointer}Invalid type. Expected \`${schema.type}\`, but received \`${jsonType(value)}\`.`;
    }
    if (schema.enum !== undefined && !schema.enum.includes(value as string)) {
      return `${pointer}Value must be one of the allowed values: ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}.`;
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value as string)) {
      return `${pointer}String does not match the required pattern: \`${schema.pattern}\`.`;
    }
    if (schema.items !== undefined) {
      const items = value as unknown[];
      const index = items.findIndex((item) => jsonType(item) !== schema.items?.type);
      if (index !== -1) {
        return `Property '/${key}/${String(index)}': Invalid type. Expected \`${schema.items.type}\`, but received \`${jsonType(items[index])}\`.`;
      }
    }
  }

  return null;
}

function jsonType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number';
  }

  return typeof value;
}
