import { describe, expect, it } from 'vitest';
import { MarkdownToState } from '../markdownToState';
import ExportMarkdown from '../stateToMarkdown';

// LaTeX `\[...\]` is a display-math delimiter equivalent to `$$...$$`. The
// marked math extension recognises it on load (lexBlock) and produces a
// `math-block` state; on save `_serializeMathBlock` normalises it back to the
// canonical `$$...$$` form. These specs pin both halves of the round-trip.

interface IMathLike {
    name: string;
    text?: string;
    meta?: { mathStyle?: string };
}

function parse(markdown: string): IMathLike[] {
    return new MarkdownToState({
        footnote: false,
        math: true,
        isGitlabCompatibilityEnabled: true,
        trimUnnecessaryCodeBlockEmptyLines: false,
        frontMatter: false,
    } as never).generate(markdown) as unknown as IMathLike[];
}

function serialize(states: IMathLike[]): string {
    return new ExportMarkdown({ listIndentation: 1 } as never).generate(
        states as never,
    );
}

describe('bracket math — \\[...\\] delimiter', () => {
    it('parses \\[...\\] as a math-block', () => {
        const [block] = parse('\\[\nx^2\n\\]\n');
        expect(block.name).toBe('math-block');
        expect(block.meta?.mathStyle).toBe('');
        expect(block.text).toBe('x^2');
    });

    it('parses multi-line \\[...\\] content', () => {
        const [block] = parse('\\[\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n\\]\n');
        expect(block.name).toBe('math-block');
        expect(block.text).toContain('\\begin{aligned}');
        expect(block.text).toContain('c &= d');
    });

    it('normalises \\[...\\] back to $$...$$ on save', () => {
        const states = parse('\\[\nx^2\n\\]\n');
        const md = serialize(states);
        expect(md).toContain('$$');
        expect(md).not.toContain('\\[');
    });

    it('keeps the $$...$$ path unchanged (regression)', () => {
        const [block] = parse('$$\nx^2\n$$\n');
        expect(block.name).toBe('math-block');
        expect(block.text).toBe('x^2');
    });
});
