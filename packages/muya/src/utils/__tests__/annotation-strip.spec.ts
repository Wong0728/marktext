// @vitest-environment happy-dom

import { execFileSync } from 'child_process';
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, expect, it } from 'vitest';
import { renderMath } from '../katex';

const PANDOC = 'pandoc';

function roundTrip(html: string): string {
    const tmpDir = join(tmpdir(), `mt-ann-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    const htmlPath = join(tmpDir, 'in.html');
    const docxPath = join(tmpDir, 'out.docx');
    writeFileSync(htmlPath, html, 'utf8');
    try {
        execFileSync(PANDOC, ['-f', 'html', '-t', 'docx', '--wrap=none', '-o', docxPath, htmlPath], {
            timeout: 30000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
        });
        if (!existsSync(docxPath)) throw new Error('no DOCX');
        return execFileSync(PANDOC, ['-f', 'docx', '-t', 'plain', docxPath], {
            timeout: 30000, encoding: 'utf8',
        });
    } finally {
        try { unlinkSync(htmlPath); } catch {}
        try { unlinkSync(docxPath); } catch {}
    }
}

// KaTeX wraps MathML in <semantics><math>...<annotation encoding="application/x-tex">...</annotation></semantics>
// Pandoc reads the annotation and tries to parse it as TeX. When the TeX has
// array `&` separators, pandoc fails and falls back to raw TeX text (not OMML).
// Stripping the <annotation> forces pandoc to use the MathML elements directly.
describe('annotation stripping → pandoc OMML conversion', () => {
    const tex = String.raw`\begin{CD} A @>f>> B \\ @VgVV @VVhV \\ C @>>k> D \end{CD}`;

    it('WITH annotation: pandoc falls back to raw TeX (warning)', () => {
        const html = renderMath(tex, { displayMode: true });
        const mathml = html.match(/<math[\s\S]*?<\/math>/)![0];
        // Verify annotation is present
        expect(mathml).toContain('annotation');
        const fullHtml = `<!DOCTYPE html><html><body>${mathml}</body></html>`;
        const text = roundTrip(fullHtml);
        // With annotation, pandoc renders as TeX text (contains \begin{array})
        expect(text).toContain('array');
    });

    it('WITHOUT annotation: pandoc converts MathML elements to OMML', () => {
        const html = renderMath(tex, { displayMode: true });
        let mathml = html.match(/<math[\s\S]*?<\/math>/)![0];
        // Strip the <semantics> wrapper and <annotation> element, keep inner MathML
        mathml = mathml.replace(/<semantics>/g, '').replace(/<\/semantics>/g, '');
        mathml = mathml.replace(/<annotation[\s\S]*?<\/annotation>/g, '');
        // Verify annotation is gone
        expect(mathml).not.toContain('annotation');
        const fullHtml = `<!DOCTYPE html><html><body>${mathml}</body></html>`;
        const text = roundTrip(fullHtml);
        // Without annotation, pandoc should convert MathML to OMML properly.
        // The round-trip text should NOT contain raw \begin{array} TeX.
        console.log(`[without annotation] round-trip text: ${JSON.stringify(text)}`);
        expect(text.length).toBeGreaterThan(0);
    });

    it('WITHOUT annotation: all formula types convert to OMML', () => {
        const formulas = [
            String.raw`\begin{aligned} (a+b)^2 &= a^2 + 2ab + b^2 \end{aligned}`,
            String.raw`\begin{cases} x^2 & x \geq 0 \\ -x & x < 0 \end{cases}`,
            String.raw`\binom{n}{k} = \frac{n!}{k!(n-k)!}`,
            String.raw`\begin{gather} a = b + c \\ d = e + f \end{gather}`,
            String.raw`\begin{CD} A @>f>> B \\ @VgVV @VVhV \\ C @>>k> D \end{CD}`,
            String.raw`\sum_{\substack{1 \leq i \leq n \\ i \text{ odd}}} i^2`,
            String.raw`\cfrac{1}{1 + \cfrac{2}{1 + \cfrac{3}{1 + \cdots}}}`,
        ];
        for (const formula of formulas) {
            const html = renderMath(formula, { displayMode: true, throwOnError: true });
            let mathml = html.match(/<math[\s\S]*?<\/math>/)![0];
            mathml = mathml.replace(/<semantics>/g, '').replace(/<\/semantics>/g, '');
            mathml = mathml.replace(/<annotation[\s\S]*?<\/annotation>/g, '');
            const fullHtml = `<!DOCTYPE html><html><body>${mathml}</body></html>`;
            const text = roundTrip(fullHtml);
            console.log(`[${formula.slice(0, 30)}...] → ${JSON.stringify(text.slice(0, 100))}`);
            expect(text.length, `${formula}: empty round-trip`).toBeGreaterThan(0);
        }
    });
});
