import katex from 'katex';
import 'katex/dist/katex.min.css';
import 'katex/dist/contrib/mhchem.mjs';

export interface IRenderMathOptions {
    displayMode?: boolean;
    throwOnError?: boolean;
}

// ---------------------------------------------------------------------------
// AMSCD (\begin{CD}) preprocessor
//
// KaTeX does not natively support the CD environment for commutative diagrams.
// This preprocessor converts \begin{CD}...\end{CD} into a KaTeX-compatible
// \begin{array}...\end{array} with \xrightarrow/\xleftarrow for horizontal
// arrows and \big\downarrow/\big\uparrow for vertical arrows.
//
// Vertical arrow labels are placed on the left/right side of the arrow using
// a small space (\;) instead of \overset/\underset. The latter produces nested
// <mo> MathML that Word's OMML renderer shows as empty boxes, while a simple
// mrow with an arrow and label renders correctly in DOCX.
//
// \big (not \Big) is used for vertical arrows because \Big triggers KaTeX's
// multi-part delimiter construction (delimsizing mult), which produces visible
// seams/jagged edges in HTML and generates <mo stretchy="true" minsize="3.0em">
// in MathML that pandoc cannot convert to OMML — the arrows are silently
// dropped from the DOCX. \big renders as a single clean glyph and produces
// plain <mo>↓</mo> MathML that pandoc handles correctly.
// ---------------------------------------------------------------------------

interface CDToken {
    type: 'cell' | 'h-arrow' | 'v-arrow';
    latex: string;
}

const CD_MARKERS: Record<string, { close: string; type: 'h-arrow' | 'v-arrow'; dir: string }> = {
    '>': { close: '>', type: 'h-arrow', dir: 'right' },
    '<': { close: '<', type: 'h-arrow', dir: 'left' },
    V: { close: 'V', type: 'v-arrow', dir: 'down' },
    A: { close: 'A', type: 'v-arrow', dir: 'up' },
};

/** Parse a single CD arrow token starting at position {@link i} in {@link row}. */
function parseCDArrow(row: string, i: number): { token: CDToken; nextIndex: number } | null {
    if (row[i] !== '@') return null;
    const ch = row[i + 1];

    if (ch === '=') {
        return { token: { type: 'h-arrow', latex: '=' }, nextIndex: i + 2 };
    }
    if (ch === '|') {
        return { token: { type: 'v-arrow', latex: '\\big\\Vert' }, nextIndex: i + 2 };
    }

    const marker = CD_MARKERS[ch];
    if (!marker) return null;

    // Syntax: @<marker>label1<close>label2<close>
    let j = i + 2;
    let label1 = '';
    while (j < row.length && row[j] !== marker.close) {
        label1 += row[j];
        j++;
    }
    if (j >= row.length) return null;
    j++; // skip first close marker

    let label2 = '';
    while (j < row.length && row[j] !== marker.close) {
        label2 += row[j];
        j++;
    }
    if (j >= row.length) return null;
    j++; // skip second close marker

    const l1 = label1.trim();
    const l2 = label2.trim();

    let latex: string;
    switch (marker.dir) {
        case 'right':
            // l1 = above, l2 = below
            latex = '\\xrightarrow';
            if (l2) latex += `[${l2}]`;
            latex += `{${l1}}`;
            break;
        case 'left':
            // l1 = below, l2 = above
            latex = '\\xleftarrow';
            if (l1) latex += `[${l1}]`;
            latex += `{${l2}}`;
            break;
        case 'down':
            // l1 = left label, l2 = right label
            latex = buildVerticalArrow('\\big\\downarrow', l1, l2);
            break;
        default: // up: l1 = left label, l2 = right label
            latex = buildVerticalArrow('\\big\\uparrow', l1, l2);
            break;
    }

    return { token: { type: marker.type, latex }, nextIndex: j };
}

/** Build a vertical arrow with optional left / right labels.
 *
 * Labels are placed next to the arrow using `\;` instead of `\overset`/`
 * \underset`, because the latter produces nested `<mo>` MathML that Word
 * renders as empty boxes.
 */
function buildVerticalArrow(arrow: string, leftLabel: string, rightLabel: string): string {
    let latex = arrow;
    if (leftLabel) {
        latex = `${leftLabel}\\;${latex}`;
    }
    if (rightLabel) {
        latex = `${latex}\\;${rightLabel}`;
    }
    return latex;
}

/** Parse a CD row into a sequence of cell / arrow tokens. */
function parseCDRow(row: string): CDToken[] {
    const tokens: CDToken[] = [];
    let current = '';
    let i = 0;

    while (i < row.length) {
        if (row[i] === '@') {
            const arrow = parseCDArrow(row, i);
            if (arrow) {
                if (current.trim()) {
                    tokens.push({ type: 'cell', latex: current.trim() });
                }
                tokens.push(arrow.token);
                current = '';
                i = arrow.nextIndex;
                continue;
            }
        }
        current += row[i];
        i++;
    }
    if (current.trim()) {
        tokens.push({ type: 'cell', latex: current.trim() });
    }
    return tokens;
}

// Invisible filler used for empty cells in arrow rows. A truly empty <mtd>
// becomes an empty <m:e> in Word OMML and is drawn as a box; a single space
// inside \text{ } keeps the cell non-empty while remaining invisible.
const CD_EMPTY_CELL = '\\text{ }';

/** Convert raw CD body text into a \begin{array}...\end{array} string. */
function convertCDToArray(content: string): string {
    const rows = content.split(/\\\\/).map(r => r.trim()).filter(r => r.length > 0);
    const parsedRows = rows.map(parseCDRow);

    // In rows that contain only vertical arrows, interleave filler cells so
    // arrows align with the cell columns of adjacent rows.
    const processedRows: string[][] = parsedRows.map(row => {
        const isArrowRow = row.length > 0 && row.every(t => t.type === 'v-arrow');
        if (isArrowRow) {
            const cells: string[] = [];
            for (let i = 0; i < row.length; i++) {
                cells.push(row[i].latex);
                if (i < row.length - 1) cells.push(CD_EMPTY_CELL);
            }
            return cells;
        }
        return row.map(t => t.latex);
    });

    const maxCols = Math.max(...processedRows.map(r => r.length), 1);
    const colSpec = 'c'.repeat(maxCols);

    const arrayRows = processedRows.map(row => {
        const cells = [...row];
        while (cells.length < maxCols) cells.push(CD_EMPTY_CELL);
        return cells.join(' & ');
    });

    return `\\begin{array}{${colSpec}} ${arrayRows.join(' \\\\ ')} \\end{array}`;
}

/** Replace all \begin{CD}...\end{CD} blocks with array equivalents. */
function preprocessAMSCD(tex: string): string {
    return tex.replace(/\\begin\{CD\}([\s\S]*?)\\end\{CD\}/g, (_match, content: string) => {
        return convertCDToArray(content);
    });
}

// ---------------------------------------------------------------------------
// AMS environment preprocessing
//
// KaTeX reliably supports `aligned`/`gathered`/`cases`/`array`/`matrix`, but
// the LaTeX document environments `align`/`gather`/`multline`/`eqnarray`/
// `split`/`equation`/`displaylines` are either unsupported or unstable when
// used bare/inline. MathJax (Typora/Obsidian) accepts all of them, so formulas
// copied from those editors hit KaTeX parse errors. Each begin/end tag is
// renamed independently (safe for nesting — `{align}` never matches
// `{aligned}` because the `}` must follow `align` directly). `equation` is a
// wrapper rather than a layout, so its tags are stripped; any inner `split`
// has already become `aligned` by the time the strip runs.
// ---------------------------------------------------------------------------
function preprocessAMS(tex: string): string {
    return tex
        .replace(/\\begin\{(align)\*?\}/g, '\\begin{aligned}')
        .replace(/\\end\{(align)\*?\}/g, '\\end{aligned}')
        .replace(/\\begin\{(gather)\*?\}/g, '\\begin{gathered}')
        .replace(/\\end\{(gather)\*?\}/g, '\\end{gathered}')
        .replace(/\\begin\{(multline)\*?\}/g, '\\begin{gathered}')
        .replace(/\\end\{(multline)\*?\}/g, '\\end{gathered}')
        .replace(/\\begin\{(eqnarray)\*?\}/g, '\\begin{aligned}')
        .replace(/\\end\{(eqnarray)\*?\}/g, '\\end{aligned}')
        .replace(/\\begin\{split\}/g, '\\begin{aligned}')
        .replace(/\\end\{split\}/g, '\\end{aligned}')
        .replace(/\\begin\{displaylines\}/g, '\\begin{gathered}')
        .replace(/\\end\{displaylines\}/g, '\\end{gathered}')
        .replace(/\\begin\{equation\*?\}/g, '')
        .replace(/\\end\{equation\*?\}/g, '');
}

// ---------------------------------------------------------------------------
// Command preprocessing
//
// Rewrite a handful of MathJax-only commands to KaTeX equivalents so common
// formulas render instead of turning red. `\DeclareMathOperator` (with optional
// `*` for limits) becomes a `\providecommand` + `\operatorname` pair;
// `\providecommand` (not `\newcommand`) is used so a name that also exists in
// COMMON_MACROS does not trigger KaTeX's "already defined" error — the
// pre-injected macro simply wins. The MathJax `\class`/`\cssId`/`\style` HTML
// hooks map to KaTeX's `\htmlClass`/`\htmlId`/`\htmlStyle`. Smart single
// quotes (U+2018/U+2019) — introduced when an editor rewrites `f'` into `f’`
// — are restored to ASCII so KaTeX treats them as primes instead of erroring.
// ---------------------------------------------------------------------------
function preprocessCommands(tex: string): string {
    return tex
        .replace(
            /\\DeclareMathOperator(\*?)\{?\\(\w+)\}?\{([^}]*)\}/g,
            (_m, star: string, name: string, body: string) =>
                `\\providecommand{\\${name}}{\\operatorname${star}{${body}}}`,
        )
        .replace(/\\class\{/g, '\\htmlClass{')
        .replace(/\\cssId\{/g, '\\htmlId{')
        .replace(/\\style\{/g, '\\htmlStyle{')
        .replace(/\\Arrowvert/g, '\\Vert')
        .replace(/\\arrowvert/g, '\\vert')
        // \bbox[opts]{content} → {content} (KaTeX has no bbox; keep content)
        .replace(/\\bbox(?:\[[^\]]*\])?(?=\{)/g, '')
        // \definecolor{name}{model}{spec} → remove (definition, no output)
        .replace(/\\definecolor\{[^}]*\}\{[^}]*\}\{[^}]*\}/g, '')
        // \unicode{x263A} or \unicode{9786} → \text{☺} (KaTeX has no \unicode)
        .replace(
            /\\unicode(?:\[[^\]]*\])?\{(x?[0-9a-fA-F]+)\}/g,
            (_m, code: string) => {
                const isHex = /^x/i.test(code);
                const num = isHex ? Number.parseInt(code.slice(1), 16) : Number.parseInt(code, 10);
                if (Number.isNaN(num) || num < 0 || num > 0x10FFFF) {
                    return '';
                }
                try {
                    return `\\text{${String.fromCodePoint(num)}}`;
                }
                catch {
                    return '';
                }
            },
        )
        // \buildrel A \over B → \stackrel{A}{B} (KaTeX has no \buildrel)
        // eslint-disable-next-line regexp/no-super-linear-backtracking -- safe: input is a single formula, not adversarial
        .replace(/\\buildrel\s+(.+?)\s+\\over\s+(.+?)(?=\s|$)/g, '\\stackrel{$1}{$2}')
        // \cancelto{value}{expr} → \overset{value}{\cancel{expr}}
        .replace(/\\cancelto\{([^{}]*)\}\{([^{}]*)\}/g, '\\overset{$1}{\\cancel{$2}}')
        // \Sb...\endSb / \Sp...\endSp → smallmatrix (AMS-TeX sub/superscript matrix)
        .replace(/\\Sb([\s\S]*?)\\endSb/g, '\\begin{smallmatrix}$1\\end{smallmatrix}')
        .replace(/\\Sp([\s\S]*?)\\endSp/g, '\\begin{smallmatrix}$1\\end{smallmatrix}')
        .replace(/[\u2018\u2019]/g, "'");
}

// Common macros injected into every KaTeX render so that formulas copied from
// MathJax/Typora (which predefine number-set shortcuts, operator names, and
// physics-package commands) render without per-document `\newcommand`. Names
// that clash with built-in KaTeX commands (`\Re`, `\Im`, `\div`, `\H`) are
// deliberately omitted to avoid changing their existing meaning. A fresh
// shallow copy is passed per call so KaTeX's `\gdef` cannot accumulate state
// across formulas.
//
// Values MUST be plain strings. The `[def, n]` array form is accepted by
// @types/katex but throws "tokens is not iterable" at runtime — KaTeX infers
// the argument count from `#1`..`#n` in the expansion itself.
const COMMON_MACROS: Record<string, string> = {
    // Number sets
    '\\R': '\\mathbb{R}',
    '\\N': '\\mathbb{N}',
    '\\Z': '\\mathbb{Z}',
    '\\Q': '\\mathbb{Q}',
    '\\C': '\\mathbb{C}',
    '\\F': '\\mathbb{F}',
    // Operator names (mimic \DeclareMathOperator)
    '\\Tr': '\\operatorname{Tr}',
    '\\rank': '\\operatorname{rank}',
    '\\diag': '\\operatorname{diag}',
    '\\sgn': '\\operatorname{sgn}',
    '\\argmax': '\\operatorname*{arg\\,max}',
    '\\argmin': '\\operatorname*{arg\\,min}',
    // Physics package core
    '\\dv': '\\frac{d#1}{d#2}',
    '\\pdv': '\\frac{\\partial #1}{\\partial #2}',
    '\\grad': '\\nabla',
    '\\curl': '\\nabla\\times',
    '\\laplacian': '\\nabla^2',
    // Abs / norm / floor / ceil shortcuts
    '\\abs': '\\lvert #1 \\rvert',
    '\\norm': '\\lVert #1 \\rVert',
    '\\floor': '\\lfloor #1 \\rfloor',
    '\\ceil': '\\lceil #1 \\rceil',
    // Physics package — vectors
    '\\vu': '\\hat{\\mathbf{#1}}',
    '\\va': '\\mathbf{#1}',
    '\\vm': '\\mathbf{#1}',
    // Physics package — differential operator
    '\\dif': '\\mathrm{d}',
    // Physics package — evaluation bar
    '\\eval': '\\Big|_{#1}^{#2}',
};

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Extract `\newcommand` / `\renewcommand` / `\providecommand` definitions
 * from a formula so they can be injected as KaTeX macros for that single
 * render. Definitions are removed from the returned text. Only acts within
 * one formula — no cross-formula state sharing, which avoids KaTeX's `\gdef`
 * accumulation problem.
 *
 * Uses balanced-brace scanning (not a fixed regex) for the definition body so
 * common nested-brace macros like `\newcommand{\R}{\mathbb{R}}` work.
 */
function extractNewcommands(tex: string): { text: string; macros: Record<string, string> } {
    const macros: Record<string, string> = {};
    // eslint-disable-next-line regexp/no-super-linear-backtracking -- safe: input is a single formula, not adversarial
    const header = /\\(?:newcommand|renewcommand|providecommand)\*?\s*\{?\\(\w+)\}?\s*(?:\[(\d)\])?\s*\{/g;
    let result = '';
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = header.exec(tex)) !== null) {
        // Append text before this definition
        result += tex.substring(lastIndex, match.index);
        const name = match[1];
        // Position of the opening `{` that starts the definition body
        const bodyStart = header.lastIndex; // just after the `{`
        let depth = 1;
        let i = bodyStart;
        while (i < tex.length && depth > 0) {
            if (tex[i] === '{') depth++;
            else if (tex[i] === '}') depth--;
            if (depth === 0) break;
            i++;
        }
        if (depth === 0) {
            macros[`\\${name}`] = tex.substring(bodyStart, i);
            lastIndex = i + 1; // skip the closing `}`
        } else {
            // Unbalanced braces — leave the text as-is
            result += tex.substring(match.index, header.lastIndex);
            lastIndex = header.lastIndex;
        }
        // Reset regex lastIndex to avoid skipping content
        header.lastIndex = lastIndex;
    }
    result += tex.substring(lastIndex);
    return { text: result, macros };
}

/**
 * Render LaTeX via KaTeX, throwing on parse error. Callers that need to
 * distinguish success from failure (e.g. the inline-math renderer, which
 * builds its own vNode) use this and catch; callers that just want an HTML
 * string use {@link renderMath} instead.
 */
export function renderMathOrThrow(tex: string, options: IRenderMathOptions = {}): string {
    const { displayMode = false } = options;
    const { text: texWithoutDefs, macros: extractedMacros } = extractNewcommands(tex);
    const processed = [preprocessAMSCD, preprocessAMS, preprocessCommands].reduce(
        (t, fn) => fn(t),
        texWithoutDefs,
    );
    return katex.renderToString(processed, {
        displayMode,
        throwOnError: true,
        strict: 'ignore',
        trust: true,
        macros: { ...COMMON_MACROS, ...extractedMacros },
    });
}

export function renderMath(tex: string, options: IRenderMathOptions = {}): string {
    try {
        return renderMathOrThrow(tex, options);
    } catch (err) {
        // Graceful gray placeholder instead of a red error. The original LaTeX
        // and the parse error are kept in the title for debugging. Use " | "
        // instead of a literal newline so the attribute survives snabbdom's
        // htmlToVNode parse in the inline-math path (a raw \n in an attribute
        // value gets dropped there, while innerHTML in the block path would
        // tolerate it). The inline-math renderer builds its own vNode via
        // renderMathOrThrow + h(), so this string path is only used by the
        // block-math renderer (innerHTML) and the marked export pipeline.
        const message = err instanceof Error ? err.message : 'parse error';
        return `<span class="math-fallback" title="${escapeHtml(`原始公式: ${tex} | 错误: ${message}`)}" role="img" aria-label="公式无法渲染">[公式]</span>`;
    }
}

/**
 * Renders a formula as standalone MathML — the format Word / Word online
 * convert into a native equation object on paste. Used by the rich-text
 * clipboard so copying a formula into Office yields a recognizable object
 * instead of literal LaTeX text. Falls back to the plain LaTeX source when
 * the formula cannot be parsed.
 */
export function renderMathToMathML(tex: string, options: IRenderMathOptions = {}): string {
    const { displayMode = false } = options;
    const { text: texWithoutDefs, macros: extractedMacros } = extractNewcommands(tex);
    const processed = [preprocessAMSCD, preprocessAMS, preprocessCommands].reduce(
        (t, fn) => fn(t),
        texWithoutDefs,
    );
    try {
        return katex.renderToString(processed, {
            displayMode,
            throwOnError: true,
            strict: 'ignore',
            trust: true,
            output: 'mathml',
            macros: { ...COMMON_MACROS, ...extractedMacros },
        });
    } catch {
        return escapeHtml(tex);
    }
}

export { katex };
