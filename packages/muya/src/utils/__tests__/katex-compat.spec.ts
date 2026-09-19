import { describe, expect, it } from 'vitest';
import { renderMath } from '../katex';

// Unit coverage for every preprocessor rule and injected macro in katex.ts.
// Each "ok" case asserts the output contains `katex` and neither `katex-error`
// (KaTeX parse failure) nor `math-fallback` (the graceful placeholder).
// Complements katex-comprehensive.spec.ts which covers the user's full
// document end-to-end.

describe('renderMath — preprocessor & macro compatibility', () => {
    const expectOk = (tex: string, displayMode = true): string => {
        const html = renderMath(tex, { displayMode });
        expect(html, `Expected KaTeX output for:\n${tex}`).toContain('katex');
        expect(html).not.toContain('katex-error');
        expect(html).not.toContain('math-fallback');
        return html;
    };

    describe('AMS environment conversion (preprocessAMS)', () => {
        it('align → aligned', () => {
            expectOk(String.raw`\begin{align} a &= b \\ &= c \end{align}`);
        });
        it('align* → aligned', () => {
            expectOk(String.raw`\begin{align*} a &= b \end{align*}`);
        });
        it('gather → gathered', () => {
            expectOk(String.raw`\begin{gather} a = b \\ c = d \end{gather}`);
        });
        it('gather* → gathered', () => {
            expectOk(String.raw`\begin{gather*} a = b \end{gather*}`);
        });
        it('multline → gathered', () => {
            expectOk(String.raw`\begin{multline} a + b + c + d \\ + e + f \end{multline}`);
        });
        it('multline* → gathered', () => {
            expectOk(String.raw`\begin{multline*} a + b \end{multline*}`);
        });
        it('eqnarray → aligned', () => {
            expectOk(String.raw`\begin{eqnarray} a &=& b \end{eqnarray}`);
        });
        it('split → aligned', () => {
            expectOk(String.raw`\begin{split} a &= b \\ &= c \end{split}`);
        });
        it('equation (tags stripped)', () => {
            expectOk(String.raw`\begin{equation} E = mc^2 \end{equation}`);
        });
        it('equation* (tags stripped)', () => {
            expectOk(String.raw`\begin{equation*} E = mc^2 \end{equation*}`);
        });
        it('displaylines → gathered', () => {
            expectOk(String.raw`\begin{displaylines} a = b \\ c = d \end{displaylines}`);
        });
    });

    describe('command rewriting (preprocessCommands)', () => {
        it('\\DeclareMathOperator{name}{body} then uses the operator', () => {
            expectOk(String.raw`\DeclareMathOperator{\optr}{Tr} \optr(A)`);
        });
        it('\\DeclareMathOperator* (limits) then uses the operator', () => {
            expectOk(String.raw`\DeclareMathOperator*{\oplim}{lim\,sup} \oplim_{n\to\infty} x_n`);
        });
        it('\\DeclareMathOperator does not clash with COMMON_MACROS (\\providecommand)', () => {
            // \Tr is predefined in COMMON_MACROS; \providecommand yields to it.
            expectOk(String.raw`\DeclareMathOperator{\Tr}{Tr} \Tr(A)`);
        });
        it('\\class → \\htmlClass', () => {
            expectOk(String.raw`\class{red}{x}`, false);
        });
        it('\\cssId → \\htmlId', () => {
            expectOk(String.raw`\cssId{eq1}{x}`, false);
        });
        it('\\style → \\htmlStyle', () => {
            expectOk(String.raw`\style{color:red}{x}`, false);
        });
        it('\\Arrowvert → \\Vert', () => {
            const html = expectOk(String.raw`\Arrowvert x \Arrowvert`);
            // KaTeX renders \Vert as U+2225 (∥), not U+2016 (‖).
            expect(html).toContain('∥');
        });
        it('\\arrowvert → \\vert', () => {
            expectOk(String.raw`\arrowvert x \arrowvert`);
        });
    });

    describe('smart-quote restoration', () => {
        it("right single quote U+2019 (f’) becomes prime", () => {
            const html = expectOk(`f\u2019(x)`, false);
            // KaTeX renders the prime glyph as U+2032 (′).
            expect(html).toContain('′');
        });
        it("left single quote U+2018 becomes prime", () => {
            const html = expectOk(`f\u2018(x)`, false);
            expect(html).toContain('′');
        });
    });

    describe('COMMON_MACROS — number sets', () => {
        it('\\R', () => expectOk(String.raw`\R`));
        it('\\N', () => expectOk(String.raw`\N`));
        it('\\Z', () => expectOk(String.raw`\Z`));
        it('\\Q', () => expectOk(String.raw`\Q`));
        it('\\C', () => expectOk(String.raw`\C`));
        it('\\F', () => expectOk(String.raw`\F`));
        it('\\R^n with exponent', () => expectOk(String.raw`\R^n`));
    });

    describe('COMMON_MACROS — operator names', () => {
        it('\\Tr(A)', () => expectOk(String.raw`\Tr(A)`));
        it('\\rank', () => expectOk(String.raw`\rank(A)`));
        it('\\diag', () => expectOk(String.raw`\diag(A, B)`));
        it('\\sgn', () => expectOk(String.raw`\sgn(x)`));
        it('\\argmax', () => expectOk(String.raw`\argmax_{x} f(x)`));
        it('\\argmin', () => expectOk(String.raw`\argmin_{x} f(x)`));
    });

    describe('COMMON_MACROS — physics package', () => {
        it('\\dv{x}{t}', () => expectOk(String.raw`\dv{x}{t}`));
        it('\\pdv{f}{x}', () => expectOk(String.raw`\pdv{f}{x}`));
        it('\\grad{F}', () => expectOk(String.raw`\grad{F}`));
        it('\\curl{E}', () => expectOk(String.raw`\curl{E}`));
        it('\\laplacian', () => expectOk(String.raw`\laplacian \phi`));
    });

    describe('COMMON_MACROS — delimiters', () => {
        it('\\abs{x}', () => expectOk(String.raw`\abs{x}`));
        it('\\norm{v}', () => expectOk(String.raw`\norm{v}`));
        it('\\floor{x}', () => expectOk(String.raw`\floor{x}`));
        it('\\ceil{x}', () => expectOk(String.raw`\ceil{x}`));
    });

    describe('physics vectors & operators (COMMON_MACROS extended)', () => {
        it('\\vu{v} (unit vector)', () => expectOk(String.raw`\vu{v}`));
        it('\\va{v} (vector)', () => expectOk(String.raw`\va{v}`));
        it('\\vm{v} (vector)', () => expectOk(String.raw`\vm{v}`));
        it('\\dif (differential d)', () => expectOk(String.raw`\int f \dif x`));
        it('\\eval{a}{b} (evaluation bar)', () => expectOk(String.raw`\eval{a}{b}`));
    });

    describe('extended command rewriting (preprocessCommands — stage 3.1)', () => {
        it('\\bbox[5px]{x} → {x}', () => {
            const html = expectOk(String.raw`\bbox[5px]{x}`, false);
            expect(html).toContain('x');
        });
        it('\\bbox[red,5px,border:1px]{x} → {x}', () => {
            expectOk(String.raw`\bbox[red,5px,border:1px]{x}`, false);
        });
        it('\\definecolor stripped, rest renders', () => {
            expectOk(String.raw`\definecolor{myred}{rgb}{1,0,0} \text{ok}`);
        });
        it('\\unicode{x263A} → \\text{☺}', () => {
            const html = expectOk(String.raw`\unicode{x263A}`, false);
            expect(html).toContain('☺');
        });
        it('\\unicode{9786} (decimal) → \\text{☺}', () => {
            const html = expectOk(String.raw`\unicode{9786}`, false);
            expect(html).toContain('☺');
        });
        it('\\buildrel \\text{def} \\over =', () => {
            expectOk(String.raw`\buildrel \text{def} \over =`);
        });
        it('\\cancelto{0}{x} → \\overset{0}{\\cancel{x}}', () => {
            expectOk(String.raw`\cancelto{0}{x}`, false);
        });
        it('\\Sb ... \\endSb → smallmatrix', () => {
            expectOk(String.raw`\Sb a & b \\ c & d \endSb`);
        });
        it('\\Sp ... \\endSp → smallmatrix', () => {
            expectOk(String.raw`\Sp a & b \endSp`);
        });
    });

    describe('newcommand extraction (stage 3.3)', () => {
        it('simple \\newcommand with nested braces', () => {
            const html = expectOk(String.raw`\newcommand{\myR}{\mathbb{R}} \myR`);
            expect(html).toContain('mathbb');
        });
        it('parameterized \\newcommand[n]', () => {
            const html = expectOk(String.raw`\newcommand{\myop}[1]{\mathbf{#1}} \myop{x}`);
            expect(html).toContain('mathbf');
        });
        it('\\renewcommand works the same', () => {
            expectOk(String.raw`\renewcommand{\foo}{\sin} \foo(x)`);
        });
        it('\\providecommand works the same', () => {
            expectOk(String.raw`\providecommand{\bar}{\overline} \bar{x}`);
        });
        it('definition is removed from rendered output', () => {
            const html = renderMath(String.raw`\newcommand{\myR}{\mathbb{R}} \myR`, { displayMode: true });
            // The \newcommand definition should not appear in the KaTeX HTML
            expect(html).not.toContain('newcommand');
        });
    });

    describe('graceful fallback for unsupported constructs', () => {
        it('undefined command returns .math-fallback, not red error', () => {
            const html = renderMath(String.raw`\thisIsNotARealCommand{x}`, { displayMode: true });
            expect(html).toContain('math-fallback');
            expect(html).not.toContain('katex-error');
            expect(html).not.toContain('mu-math-error');
            expect(html).toContain('[公式]');
            // title carries the original LaTeX + parse reason for debugging
            const title = (html.match(/title="([^"]*)"/) || [])[1] ?? '';
            expect(title).toContain('thisIsNotARealCommand');
        });
    });
});
