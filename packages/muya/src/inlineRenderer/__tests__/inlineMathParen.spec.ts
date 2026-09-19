// @vitest-environment happy-dom

import type { CodeEmojiMathToken } from '../types';
import { describe, expect, it } from 'vitest';
import { tokenizer } from '../lexer';

function findMathToken(src: string): CodeEmojiMathToken | undefined {
    return tokenizer(src).find(t => t.type === 'inline_math') as
        | CodeEmojiMathToken
        | undefined;
}

describe('inline math — LaTeX `\\(...\\)` delimiter', () => {
    it('tokenizes \\(a^2 + b^2\\) as inline math', () => {
        const token = findMathToken('\\(a^2 + b^2\\)');
        expect(token).toBeDefined();
        expect(token!.content).toBe('a^2 + b^2');
        expect(token!.marker).toBe('\\(');
    });

    it('tokenizes a fraction \\(\\frac{1}{2}\\)', () => {
        const token = findMathToken('\\(\\frac{1}{2}\\)');
        expect(token).toBeDefined();
        expect(token!.content).toBe('\\frac{1}{2}');
    });

    it('renders inline math mid-sentence', () => {
        const tokens = tokenizer('foo \\(x^2\\) bar');
        const math = tokens.find(t => t.type === 'inline_math') as
            | CodeEmojiMathToken
            | undefined;
        expect(math).toBeDefined();
        expect(math!.content).toBe('x^2');
    });

    it('does not span newlines', () => {
        // `\(…\)` is single-line inline math; a newline between the delimiters
        // must NOT be absorbed into one math token.
        const tokens = tokenizer('\\(a\nb\\)');
        expect(tokens.some(t => t.type === 'inline_math')).toBe(false);
    });

    it('keeps the $...$ path unchanged (regression)', () => {
        const token = findMathToken('$a+b$');
        expect(token).toBeDefined();
        expect(token!.content).toBe('a+b');
        expect(token!.marker).toBe('$');
    });

    it('tokenizes \(...\) after Chinese punctuation', () => {
        const token = findMathToken(`导数定义：\\(f'(x)\\)`);
        expect(token).toBeDefined();
        expect(token!.content).toBe(String.raw`f'(x)`);
        expect(token!.marker).toBe('\\(');
        expect(token!.displayMode).toBe(false);
    });

    it('does not treat an escaped \\( as math', () => {
        const tokens = tokenizer('\\\\(a+b\\)');
        expect(tokens.some(t => t.type === 'inline_math')).toBe(false);
    });
});
