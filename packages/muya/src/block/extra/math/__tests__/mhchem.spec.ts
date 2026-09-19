import { describe, expect, it } from 'vitest';
import { renderMath } from '../../../../utils/katex';

describe('mhchem (\\ce) extension registration', () => {
    it('patches the same katex instance the renderers use', () => {
        expect(() =>
            renderMath('\\ce{Zn^2+ <=> Zn(OH)2}', {
                displayMode: true,
            }),
        ).not.toThrow();
    });

    it('renders a simple chemical equation', () => {
        const html = renderMath('\\ce{2H2 + O2 -> 2H2O}', { displayMode: true });
        expect(html).toContain('katex');
        expect(html).not.toContain('katex-error');
    });
});
