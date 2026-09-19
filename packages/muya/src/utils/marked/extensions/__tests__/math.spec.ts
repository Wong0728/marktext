// @vitest-environment happy-dom

import { Marked } from 'marked';
import { describe, expect, it } from 'vitest';
import mathExtension from '../math';

function render(src: string): string {
    const marked = new Marked();
    marked.use(
        mathExtension({
            throwOnError: false,
            useKatexRender: true,
        }),
    );
    return marked.parse(src) as string;
}

describe('marked math extension', () => {
    it('renders \\(...\\) after Chinese punctuation', () => {
        const html = render(`导数定义：\\(f'(x)\\)`);
        expect(html).toContain('katex');
        expect(html).toContain('f');
    });

    it('renders inline \\[...\\] with display math', () => {
        const html = render('\\[\\int_0^1\\]');
        expect(html).toContain('katex-display');
        expect(html).toContain('∫');
    });

    it('renders inline \\[...\\] inside a table cell', () => {
        const src = '| 积分 | \\[\\int_0^1\\] |\n| ---- | -------------- |';
        const html = render(src);
        expect(html).toContain('katex-display');
        expect(html).toContain('∫');
    });

    it('still renders block \\[...\\] as display math', () => {
        const html = render('\\[\n\\begin{pmatrix} a & b \\ c & d \\end{pmatrix}\n\\]');
        expect(html).toContain('katex-display');
        expect(html).toContain('pmatrix');
    });

    it('renders block $$...$$ when the opening $$ shares its line with the math', () => {
        const html = render('$$\\begin{aligned}\n(a+b)^2 &= a^2 + 2ab + b^2 \\\\\\n(a-b)^2 &= a^2 - 2ab + b^2\n\\end{aligned}$$');
        expect(html).toContain('katex-display');
        expect(html).toContain('aligned');
    });

    it('does not render an escaped \\( as math', () => {
        const html = render('\\\\(a+b\\)');
        expect(html).not.toContain('katex');
    });

    it('renders inline $...$ after Chinese punctuation', () => {
        const html = render('质能方程：$E = mc^2$');
        expect(html).toContain('katex');
        expect(html).toContain('E');
    });

    it('renders inline $...$ followed by Chinese period', () => {
        const html = render('答案为 $x$。');
        expect(html).toContain('katex');
        expect(html).toContain('x');
    });

    it('renders inline $...$ inside a table cell', () => {
        const src = '| 物理量 | $v$ | 单位 |\n|--------|------|------|';
        const html = render(src);
        expect(html).toContain('katex');
        expect(html).toContain('v');
    });

    it('renders single-line block $$...$$ as display math', () => {
        const html = render('$$\\int_{-\\infty}^{+\\infty} e^{-x^2} dx = \\sqrt{\\pi}$$');
        expect(html).toContain('katex-display');
        expect(html).toContain('∫');
    });

    it('renders nested fractions and square roots inline', () => {
        const html = render('$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$');
        expect(html).toContain('katex');
        expect(html).toContain('mfrac');
        expect(html).toContain('sqrt');
    });

    it('does not render prices like $5 or $ 100 as math', () => {
        const html = render('The price is $5 and $ 100.');
        expect(html).not.toContain('katex');
    });
});
