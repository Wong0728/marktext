// @vitest-environment happy-dom

import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { describe, expect, it } from 'vitest';
import mathExtension from '../math';

// Mirrors packages/muya/src/config/index.ts EXPORT_DOMPURIFY_CONFIG so this
// test stays self-contained (no deep relative import to resolve).
const EXPORT_DOMPURIFY_CONFIG = {
    FORBID_ATTR: ['contenteditable'],
    ALLOW_DATA_ATTR: false,
    ADD_ATTR: ['data-align'],
    USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
    RETURN_TRUSTED_TYPE: false,
};

function renderAndSanitize(src: string): string {
    const marked = new Marked();
    marked.use(
        mathExtension({
            throwOnError: false,
            useKatexRender: true,
        }),
    );
    const raw = marked.parse(src) as string;
    return DOMPurify.sanitize(raw, EXPORT_DOMPURIFY_CONFIG) as string;
}

// Mirrors the real export pipeline (marked → KaTeX → DOMPurify with
// mathMl:true) and verifies the semantic <math> MathML survives sanitization
// for every formula type. Without surviving <math>, the DOCX export (pandoc
// OMML / JS mathml2omml) has nothing to convert and formulas are lost.
describe('export pipeline — MathML survival after DOMPurify', () => {
    const expectMathSurvives = (src: string): string => {
        const html = renderAndSanitize(src);
        expect(html, `MathML missing for:\n${src}`).toContain('<math');
        expect(html).not.toContain('katex-error');
        return html;
    };

    it('9. aligned', () => {
        const src = `$$
\\begin{aligned}
(a+b)^2 &= a^2 + 2ab + b^2 \\\\
(a-b)^2 &= a^2 - 2ab + b^2
\\end{aligned}$$`;
        expectMathSurvives(src);
    });

    it('10a. cases', () => {
        const src = `$$
f(x) = \\begin{cases}
x^2 & \\text{if } x \\geq 0 \\\\
-x & \\text{if } x < 0
\\end{cases}
$$`;
        expectMathSurvives(src);
    });

    it('10b. binom', () => {
        expectMathSurvives(`$$\\binom{n}{k} = \\frac{n!}{k!(n-k)!}$$`);
    });

    it('10c. partial derivative', () => {
        expectMathSurvives(`$$\\frac{\\partial^2 f}{\\partial x \\partial y}$$`);
    });

    it('10d. Christoffel symbol', () => {
        expectMathSurvives(`$$\\Gamma^\\lambda_{\\mu\\nu} = \\frac{1}{2}g^{\\lambda\\sigma}\\left(\\partial_\\mu g_{\\nu\\sigma}\\right)$$`);
    });

    it('11. inline math', () => {
        const src = `当 $x \\to \\infty$ 时，极限 $$\\lim_{x \\to +\\infty} \\frac{\\ln x}{x^\\alpha} = 0$$ 成立。`;
        const html = expectMathSurvives(src);
        // Should have both inline and display math
        const mathCount = (html.match(/<math/g) || []).length;
        expect(mathCount).toBeGreaterThanOrEqual(2);
    });

    it('12. gather', () => {
        const src = `$$\\begin{gather}
a = b + c \\\\
d = e + f + g
\\end{gather}$$`;
        expectMathSurvives(src);
    });

    it('13. AMSCD commutative diagram', () => {
        const src = `$$\\begin{CD}
A @>f>> B \\\\
@VgVV @VVhV \\\\
C @>>k> D
\\end{CD}$$`;
        const html = expectMathSurvives(src);
        // The CD preprocessor converts to array with xrightarrow + downarrow.
        // Verify the MathML contains the arrow semantics.
        expect(html).toContain('xrightarrow');
    });

    it('14. color', () => {
        expectMathSurvives(`$$\\color{red}{E} = \\color{blue}{mc^2}$$`);
    });

    it('15a. mathcal / mathbb', () => {
        expectMathSurvives(`$$\\mathcal{L}\\{\\mathcal{F}\\} = \\mathbb{R}^n \\oplus \\mathbb{C}^m$$`);
    });

    it('15b. mathfrak', () => {
        expectMathSurvives(`$$\\mathfrak{sl}(2, \\mathbb{C})$$`);
    });

    it('16a. substack', () => {
        expectMathSurvives(`$$\\sum_{\\substack{1 \\leq i \\leq n \\\\ i \\text{ odd}}} i^2$$`);
    });

    it('16b. int limits', () => {
        expectMathSurvives(`$$\\int\\limits_0^1 \\int\\limits_0^1 f(x,y) \\, dx \\, dy$$`);
    });

    it('17a. nth root', () => {
        expectMathSurvives(`$$\\sqrt[n]{x^m + y^m} = \\left(x^m + y^m\\right)^{\\frac{1}{n}}$$`);
    });

    it('17b. cfrac', () => {
        expectMathSurvives(`$$\\cfrac{1}{1 + \\cfrac{2}{1 + \\cfrac{3}{1 + \\cdots}}}$$`);
    });

    it('18a. xrightarrow / xleftarrow', () => {
        expectMathSurvives(`$$A \\xrightarrow{f} B \\xleftarrow{g} C$$`);
    });

    it('18b. mapsto', () => {
        expectMathSurvives(`$$x \\mapsto x^2$$`);
    });

    it('18c. nabla curl', () => {
        expectMathSurvives(`$$\\nabla \\times \\mathbf{E} = -\\frac{\\partial \\mathbf{B}}{\\partial t}$$`);
    });

    it('19a. forall / exists', () => {
        expectMathSurvives(`$$\\forall x \\in \\mathbb{R}, \\exists y \\in \\mathbb{R} : y^2 = x$$`);
    });

    it('19b. bigcup', () => {
        expectMathSurvives(`$$\\bigcup_{i \\in I} A_i = \\left\\{x \\mid \\exists i \\in I, x \\in A_i\\right\\}$$`);
    });
});
