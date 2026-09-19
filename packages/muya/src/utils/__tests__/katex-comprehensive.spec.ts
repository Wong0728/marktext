import { describe, expect, it } from 'vitest';
import { renderMath } from '../katex';

// Comprehensive coverage of all formula types from the user's test document
// (sections 9-20). Each test verifies the formula renders without producing
// a KaTeX error and, where relevant, that key MathML semantic content is
// present so the DOCX export pipeline (pandoc OMML / JS mathml2omml) has
// something to convert.

describe('renderMath — comprehensive formula coverage', () => {
    // Helper: assert no katex-error and that katex output is present.
    const expectOk = (tex: string, displayMode = true): string => {
        const html = renderMath(tex, { displayMode, throwOnError: true });
        expect(html, `KaTeX error rendering: ${tex}`).not.toContain('katex-error');
        expect(html).toContain('katex');
        return html;
    };

    describe('9. 多行对齐公式 (aligned)', () => {
        it('renders aligned environment', () => {
            const tex = String.raw`\begin{aligned}
(a+b)^2 &= a^2 + 2ab + b^2 \\
(a-b)^2 &= a^2 - 2ab + b^2 \\
(a+b)(a-b) &= a^2 - b^2
\end{aligned}`;
            const html = expectOk(tex);
            expect(html).toContain('mtable');
        });
    });

    describe('10. 更复杂的 LaTeX', () => {
        it('renders cases (piecewise function)', () => {
            const tex = String.raw`f(x) = \begin{cases}
x^2 & \text{if } x \geq 0 \\
-x & \text{if } x < 0
\end{cases}`;
            const html = expectOk(tex);
            expect(html).toContain('mtable');
        });

        it('renders binomial coefficient', () => {
            const tex = String.raw`\binom{n}{k} = \frac{n!}{k!(n-k)!}`;
            const html = expectOk(tex);
            expect(html).toContain('mfrac');
        });

        it('renders partial derivatives', () => {
            const tex = String.raw`\frac{\partial^2 f}{\partial x \partial y}`;
            expectOk(tex);
        });

        it('renders tensor indices (Christoffel symbol)', () => {
            const tex = String.raw`\Gamma^\lambda_{\mu\nu} = \frac{1}{2}g^{\lambda\sigma}\left(\partial_\mu g_{\nu\sigma} + \partial_\nu g_{\mu\sigma} - \partial_\sigma g_{\mu\nu}\right)`;
            expectOk(tex);
        });
    });

    describe('11. 公式与文本混排 (inline)', () => {
        it('renders inline limits', () => {
            const tex = String.raw`\lim_{x \to +\infty} \frac{\ln x}{x^\alpha} = 0`;
            const html = expectOk(tex, false);
            expect(html).toContain('mfrac');
        });
    });

    describe('12. 多行公式编号 (gather)', () => {
        it('renders gather environment', () => {
            const tex = String.raw`\begin{gather}
a = b + c \\
d = e + f + g \\
h = i + j
\end{gather}`;
            const html = expectOk(tex);
            expect(html).toContain('mtable');
        });
    });

    describe('13. 交换图 (AMSCD)', () => {
        it('renders CD commutative diagram', () => {
            const tex = String.raw`\begin{CD}
A @>f>> B \\
@VgVV @VVhV \\
C @>>k> D
\end{CD}`;
            const html = expectOk(tex);
            expect(html).toContain('xrightarrow');
            expect(html).toContain('downarrow');
        });
    });

    describe('14. 公式中的颜色 (color)', () => {
        it('renders \\color{red}{...}', () => {
            const tex = String.raw`\color{red}{E} = \color{blue}{mc^2}`;
            expectOk(tex);
        });
    });

    describe('15. 花体与黑板粗体', () => {
        it('renders mathcal / mathbb / mathfrak', () => {
            const tex = String.raw`\mathcal{L}\{\mathcal{F}\} = \mathbb{R}^n \oplus \mathbb{C}^m`;
            expectOk(tex);
        });

        it('renders mathfrak with mathbb', () => {
            const tex = String.raw`\mathfrak{sl}(2, \mathbb{C})`;
            expectOk(tex);
        });
    });

    describe('16. 上下标堆叠', () => {
        it('renders substack under sum', () => {
            const tex = String.raw`\sum_{\substack{1 \leq i \leq n \\ i \text{ odd}}} i^2`;
            expectOk(tex);
        });

        it('renders \\int\\limits_0^1 \\int\\limits_0^1', () => {
            const tex = String.raw`\int\limits_0^1 \int\limits_0^1 f(x,y) \, dx \, dy`;
            expectOk(tex);
        });
    });

    describe('17. 根号与分数嵌套', () => {
        it('renders nth root and power', () => {
            const tex = String.raw`\sqrt[n]{x^m + y^m} = \left(x^m + y^m\right)^{\frac{1}{n}}`;
            expectOk(tex);
        });

        it('renders continued fraction (cfrac)', () => {
            const tex = String.raw`\cfrac{1}{1 + \cfrac{2}{1 + \cfrac{3}{1 + \cdots}}}`;
            const html = expectOk(tex);
            expect(html).toContain('mfrac');
        });
    });

    describe('18. 箭头与符号', () => {
        it('renders xrightarrow / xleftarrow', () => {
            const tex = String.raw`A \xrightarrow{f} B \xleftarrow{g} C`;
            expectOk(tex);
        });

        it('renders mapsto', () => {
            const tex = String.raw`x \mapsto x^2`;
            expectOk(tex);
        });

        it('renders nabla curl equation', () => {
            const tex = String.raw`\nabla \times \mathbf{E} = -\frac{\partial \mathbf{B}}{\partial t}`;
            expectOk(tex);
        });
    });

    describe('19. 集合与逻辑', () => {
        it('renders forall / exists', () => {
            const tex = String.raw`\forall x \in \mathbb{R}, \exists y \in \mathbb{R} : y^2 = x`;
            expectOk(tex);
        });

        it('renders bigcup set comprehension', () => {
            const tex = String.raw`\bigcup_{i \in I} A_i = \left\{x \mid \exists i \in I, x \in A_i\right\}`;
            expectOk(tex);
        });
    });
});
