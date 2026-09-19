import { describe, expect, it } from 'vitest';
import { renderMath } from '../katex';

describe('renderMath', () => {
    it('renders aligned multi-line equations', () => {
        const tex = String.raw`\begin{aligned}
(a+b)^2 &= a^2 + 2ab + b^2 \\
(a-b)^2 &= a^2 - 2ab + b^2 \\
(a+b)(a-b) &= a^2 - b^2
\end{aligned}`;
        const html = renderMath(tex, { displayMode: true });
        expect(html).toContain('katex');
        expect(html).not.toContain('katex-error');
    });

    it('renders mhchem chemical equations', () => {
        const html = renderMath('\\ce{2H2 + O2 -> 2H2O}', { displayMode: true });
        expect(html).toContain('katex');
        expect(html).not.toContain('katex-error');
    });

    it('renders nested fractions', () => {
        const html = renderMath('\\frac{1}{1 + \\frac{1}{1 + \\frac{1}{x}}}', { displayMode: true });
        expect(html).toContain('katex');
        expect(html).not.toContain('katex-error');
    });

    it('renders AMSCD commutative diagram', () => {
        const tex = String.raw`\begin{CD}
A @>f>> B \\
@VgVV @VVhV \\
C @>>k> D
\end{CD}`;
        const html = renderMath(tex, { displayMode: true });
        expect(html).toContain('katex');
        expect(html).not.toContain('katex-error');
        // Converted to array with arrows
        expect(html).toContain('xrightarrow');
        expect(html).toContain('downarrow');
    });

    it('renders AMSCD with unlabeled arrows', () => {
        const tex = String.raw`\begin{CD}
A @>>> B \\
@VVV @VVV \\
C @>>> D
\end{CD}`;
        const html = renderMath(tex, { displayMode: true });
        expect(html).toContain('katex');
        expect(html).not.toContain('katex-error');
    });
});
