// @vitest-environment happy-dom

import type { CodeEmojiMathToken } from '../types';
import { describe, expect, it } from 'vitest';
import { tokenizer } from '../lexer';

function findMathToken(src: string): CodeEmojiMathToken | undefined {
    return tokenizer(src).find(t => t.type === 'inline_math') as
        | CodeEmojiMathToken
        | undefined;
}

describe('inline math — LaTeX \\[...\\] delimiter', () => {
    it('tokenizes \\[a^2 + b^2\\] as inline math with displayMode', () => {
        const token = findMathToken('\\[a^2 + b^2\\]');
        expect(token).toBeDefined();
        expect(token!.content).toBe('a^2 + b^2');
        expect(token!.marker).toBe('\\[');
        expect(token!.displayMode).toBe(true);
    });

    it('tokenizes a fraction \\[\\frac{1}{2}\\]', () => {
        const token = findMathToken('\\[\\frac{1}{2}\\]');
        expect(token).toBeDefined();
        expect(token!.content).toBe('\\frac{1}{2}');
    });

    it('renders inline display math in a table cell', () => {
        const tokens = tokenizer('| 积分 | \\[\\int_0^1\\] |');
        const math = tokens.find(t => t.type === 'inline_math') as
            | CodeEmojiMathToken
            | undefined;
        expect(math).toBeDefined();
        expect(math!.content).toBe('\\int_0^1');
        expect(math!.displayMode).toBe(true);
    });

    it('does not span newlines', () => {
        const tokens = tokenizer('\\[a\nb\\]');
        expect(tokens.some(t => t.type === 'inline_math')).toBe(false);
    });

    it('does not treat an escaped \\[ as math', () => {
        const tokens = tokenizer('\\\\[a+b\\]');
        expect(tokens.some(t => t.type === 'inline_math')).toBe(false);
    });
});
