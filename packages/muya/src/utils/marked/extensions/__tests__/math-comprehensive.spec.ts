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

// Mirrors the user's test document (sections 9-20) to verify the full
// marked tokenize→renderMath pipeline handles every formula shape the user
// writes, including $$ on the same line as \begin/\end.
describe('marked math extension — full document render', () => {
    const expectKatex = (src: string): string => {
        const html = render(src);
        expect(html, `Expected katex output for:\n${src}`).toContain('katex');
        expect(html).not.toContain('katex-error');
        return html;
    };

    it('9. aligned with $$ on own line, closing $$ glued to \\end{aligned}', () => {
        const src = `$$
\\begin{aligned}
(a+b)^2 &= a^2 + 2ab + b^2 \\\\
(a-b)^2 &= a^2 - 2ab + b^2 \\\\
(a+b)(a-b) &= a^2 - b^2
\\end{aligned}$$`;
        const html = expectKatex(src);
        expect(html).toContain('katex-display');
        expect(html).toContain('mtable');
    });

    it('10a. cases with $$ on own lines', () => {
        const src = `$$
f(x) = \\begin{cases}
x^2 & \\text{if } x \\geq 0 \\\\
-x & \\text{if } x < 0
\\end{cases}
$$`;
        const html = expectKatex(src);
        expect(html).toContain('katex-display');
    });

    it('10b. binom single-line $$...$$', () => {
        const src = `$$\\binom{n}{k} = \\frac{n!}{k!(n-k)!}$$`;
        const html = expectKatex(src);
        expect(html).toContain('katex-display');
    });

    it('10c. partial derivative single-line', () => {
        const src = `$$\\frac{\\partial^2 f}{\\partial x \\partial y}$$`;
        expectKatex(src);
    });

    it('10d. Christoffel symbol single-line', () => {
        const src = `$$\\Gamma^\\lambda_{\\mu\\nu} = \\frac{1}{2}g^{\\lambda\\sigma}\\left(\\partial_\\mu g_{\\nu\\sigma} + \\partial_\\nu g_{\\mu\\sigma} - \\partial_\\sigma g_{\\mu\\nu}\\right)$$`;
        expectKatex(src);
    });

    it('11. inline math mixed with text', () => {
        const src = `当 $x \\to \\infty$ 时，函数 $\\ln(x)$ 的增长速度远慢于任何幂函数 $x^\\alpha$（其中 $\\alpha > 0$）。这可以通过极限
$$\\lim_{x \\to +\\infty} \\frac{\\ln x}{x^\\alpha} = 0$$
来严格证明，对任意 $\\alpha > 0$ 成立。`;
        const html = expectKatex(src);
        expect(html).toContain('katex-display');
    });

    it('12. gather with $$ glued to \\begin / \\end', () => {
        const src = `$$\\begin{gather}
a = b + c \\\\
d = e + f + g \\\\
h = i + j
\\end{gather}$$`;
        const html = expectKatex(src);
        expect(html).toContain('katex-display');
        expect(html).toContain('mtable');
    });

    it('13. AMSCD commutative diagram with $$ glued to \\begin / \\end', () => {
        const src = `$$\\begin{CD}
A @>f>> B \\\\
@VgVV @VVhV \\\\
C @>>k> D
\\end{CD}$$`;
        const html = expectKatex(src);
        expect(html).toContain('katex-display');
        expect(html).toContain('xrightarrow');
        expect(html).toContain('downarrow');
    });

    it('14. color in formula', () => {
        const src = `$$\\color{red}{E} = \\color{blue}{mc^2}$$`;
        expectKatex(src);
    });

    it('15a. mathcal / mathbb / oplus', () => {
        const src = `$$\\mathcal{L}\\{\\mathcal{F}\\} = \\mathbb{R}^n \\oplus \\mathbb{C}^m$$`;
        expectKatex(src);
    });

    it('15b. mathfrak with mathbb', () => {
        const src = `$$\\mathfrak{sl}(2, \\mathbb{C})$$`;
        expectKatex(src);
    });

    it('16a. substack', () => {
        const src = `$$\\sum_{\\substack{1 \\leq i \\leq n \\\\ i \\text{ odd}}} i^2$$`;
        expectKatex(src);
    });

    it('16b. int\\limits nested', () => {
        const src = `$$\\int\\limits_0^1 \\int\\limits_0^1 f(x,y) \\, dx \\, dy$$`;
        expectKatex(src);
    });

    it('17a. nth root and power', () => {
        const src = `$$\\sqrt[n]{x^m + y^m} = \\left(x^m + y^m\\right)^{\\frac{1}{n}}$$`;
        expectKatex(src);
    });

    it('17b. continued fraction cfrac', () => {
        const src = `$$\\cfrac{1}{1 + \\cfrac{2}{1 + \\cfrac{3}{1 + \\cdots}}}$$`;
        expectKatex(src);
    });

    it('18a. xrightarrow / xleftarrow', () => {
        const src = `$$A \\xrightarrow{f} B \\xleftarrow{g} C$$`;
        expectKatex(src);
    });

    it('18b. mapsto', () => {
        const src = `$$x \\mapsto x^2$$`;
        expectKatex(src);
    });

    it('18c. nabla curl', () => {
        const src = `$$\\nabla \\times \\mathbf{E} = -\\frac{\\partial \\mathbf{B}}{\\partial t}$$`;
        expectKatex(src);
    });

    it('19a. forall / exists', () => {
        const src = `$$\\forall x \\in \\mathbb{R}, \\exists y \\in \\mathbb{R} : y^2 = x$$`;
        expectKatex(src);
    });

    it('19b. bigcup set comprehension', () => {
        const src = `$$\\bigcup_{i \\in I} A_i = \\left\\{x \\mid \\exists i \\in I, x \\in A_i\\right\\}$$`;
        expectKatex(src);
    });

    it('renders inline math wrapped in ASCII parentheses', () => {
        const src = 'inline ($x^2$) math';
        const html = render(src);
        expect(html).toContain('katex');
        expect(html).not.toContain('katex-error');
        expect(html).toContain('(');
        expect(html).toContain(')');
    });

    it('renders inline math wrapped in ASCII brackets', () => {
        const src = 'inline [$x^2$] math';
        const html = render(src);
        expect(html).toContain('katex');
        expect(html).not.toContain('katex-error');
        expect(html).toContain('[');
        expect(html).toContain(']');
    });
});
