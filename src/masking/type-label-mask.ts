import { type Entity, typeName } from '../entity.js';
import type { MaskingStrategy } from './strategy.js';

export interface TypeLabelMaskOptions {
  /**
   * PHP sprintf format that receives the type name (e.g. "PERSON"), default "[%s]". Supported: `%s` (once),
   * `%1$s` and `%%`; anything else throws a TypeError. Or a function of the type name.
   */
  format?: string | ((type: string) => string);
}

const DIRECTIVE = /%(?:%|1\$s|s)|%/g;

/**
 * Replaces the whole value with its type name: "Maria Musterfrau" → "[PERSON]". Learned types use their name.
 */
export class TypeLabelMask implements MaskingStrategy {
  readonly #format: (type: string) => string;

  constructor(options: TypeLabelMaskOptions = {}) {
    const { format = '[%s]' } = options;
    this.#format = typeof format === 'function' ? format : compile(format);
  }

  mask(entity: Entity): string {
    return this.#format(typeName(entity));
  }
}

/** The subset of PHP's sprintf() that a single string argument can satisfy. */
function compile(format: string): (type: string) => string {
  let plain = 0;
  for (const [directive] of format.matchAll(DIRECTIVE)) {
    if (directive === '%') {
      throw new TypeError('The type label format supports only %s, %1$s and %%.');
    }
    if (directive === '%s' && ++plain > 1) {
      throw new TypeError('The type label format may contain %s only once; use %1$s to repeat the type.');
    }
  }

  return (type) => format.replace(DIRECTIVE, (directive) => (directive === '%%' ? '%' : type));
}
