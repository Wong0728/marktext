import type { Token } from 'marked';
// mhchem and the KaTeX stylesheet load in utils/katex, which every render
// below goes through (renderMath / renderMathToMathML).
import { renderMath, renderMathToMathML } from '../../katex';

// Each inline math tokenizer must emit its registered extension name; shared types shadow other extensions.
export type TInlineMathType
    = | 'inlineMath'
        | 'inlineMathGfm'
        | 'inlineMathSingleBackslash'
        | 'displayMathSingleBackslash'
        | 'inlineMathDoubleBackslash'
        | 'displayMathDoubleBackslash';

const INLINE_MATH_TYPES = new Set<string>([
    'inlineMath',
    'inlineMathGfm',
    'inlineMathSingleBackslash',
    'displayMathSingleBackslash',
    'inlineMathDoubleBackslash',
    'displayMathDoubleBackslash',
]);

const DISPLAY_MATH_MARKERS = new Set(['$$', '\\[', '\\\\[']);

export interface IMathToken {
    type: TInlineMathType | 'multiplemath';
    raw: string;
    text: string;
    displayMode: boolean;
    marker?: string;
    // Only `` $`…`$ `` needs this: every other form closes on its own marker.
    closeMarker?: string;
    mathStyle?: '' | 'gfm';
}

interface IOptions {
    throwOnError?: boolean;
    useKatexRender?: boolean;
    // The single-backslash delimiters travel with the dollar rules by default
    // (a caller that passes no flags gets muya's `\(…\)`/`\[…\]` semantics),
    // but an explicit false restores pandoc's contract: on a composed pipeline
    // the spelling belongs to `singleBackslashMathExtension` alone.
    texMathSingleBackslash?: boolean;
    // 'html' renders KaTeX's full HTML+MathML markup, 'mathml' renders
    // standalone MathML (Word converts it to a native equation on paste).
    mathOutput?: 'html' | 'mathml';
    // muya's authored-syntax display claims beyond the editor's
    // display-only-when-the-paragraph-is-all-math rule (#4904/#5481): a
    // `$$…$$` on a single line (or with the opener sharing the first math
    // line) claimed as a block, and a math-only table cell promoted to
    // display. The state-building and preview/export pipelines turn this off
    // and keep the paragraph rule alone; the clipboard and the bare render
    // paths keep it.
    authoredDisplayMath?: boolean;
}

// Kept in lockstep with the editor's `inline_math` rule
// (inlineRenderer/rules.ts) so that a document reads the same while editing and
// on export (#5446). Same shape, minus bare newlines: math never spans a line
// on this path. A `$` may open a span mid-word, as pandoc and the editor both
// allow, so the start hint carries no flanking requirement of its own.
const inlineStartRule = /\${1,2}(?!\$)/g;
const inlineRule
    = /^(?!\$(?!\$)(?:[^$\\\n]|\\.)*(?:\s\$|\$\d))(\$\$(?!\$)|\$(?=\S))((?:(?!\1)[^\\\n]|\\.)+)\1(?!\1)/;
const blockRule = /^(\${1,2})\n((?:\\[\s\S]|[^\\])+?)\n\1[ \t]*(?:\n|$)/;
// A `$$…$$` that fills a single line is block display math even when more
// text follows on later lines: the `start` hint cuts the paragraph at `\n$`
// and this rule claims the formula (#4935). A bare `$` is not admitted in the
// content — otherwise backtracking would run one claim over two formulas
// sharing a line (`$$a$$ $$b$$`), while `$$x$y$$` belongs to the inline rule,
// which does allow a lone `$`.
const blockSingleLineRule = /^(\${2})((?:\\.|[^\\\n$])+)\1[ \t]*(?:\n|$)/;
// The opening `$$` may share its line with the first line of math and the
// closing `$$` may share the last (`$$\begin{aligned} … \end{aligned}$$`);
// the opener may also sit alone (group 2 empty). `$$` only — a single `$`
// block delimiter cascades into later formulas' delimiters on malformed
// input (#4935). Group 2 keeps the same no-bare-`$` guard as the single-line
// rule for the same reason.
const blockSameLineRule
    = /^(\$\$)((?:\\.|[^\\\n$])*)\n((?:\\[\s\S]|[^\\])+?)(?:\n\1|\1)[ \t]*(?:\n|$)/;
// `\[` and `\]` on their own lines is the ordinary spelling of a display
// formula; on the file-load path it is a math BLOCK (a `math-block` state),
// not a paragraph holding inline math (#5481-era semantics).
const blockBracketRule = /^\\\[ *\n((?:\\[\s\S]|[^\\])+?)\n *\\\][ \t]*(?:\n|$)/;

// GitHub's inline math, pandoc's `tex_math_gfm` — mirrors the editor's
// `inline_math_gfm` rule.
const gfmStartRule = /\$`/g;
const gfmRule = /^(\$`)((?:[^`\\\n]|\\.)+)`\$/;

// pandoc's `tex_math_single_backslash` — mirrors the editor's
// `inline_math_single_backslash` / `display_math_single_backslash` rules.
// Unlike the dollar rules these admit newlines: `\[` and `\]` on their own
// lines is the ordinary spelling of a display formula, and pandoc reads a soft
// line break inside `\(…\)` too. A blank line still ends the span, because
// marked has already cut the paragraph by the time the rule runs.
const singleInlineStartRule = /\\\(/g;
const singleInlineRule = /^(\\\()((?:[^\\]|\\[^)])+)\\\)/;
const singleDisplayStartRule = /\\\[/g;
const singleDisplayRule = /^(\\\[)((?:[^\\]|\\[^\]])+)\\\]/;

// pandoc's `tex_math_double_backslash`. The closer is taken literally, with
// none of the escape rule above: pandoc ends the span at the first `\\)` it
// sees, so `\\(a\\)b\\)` holds `a` rather than running on.
const doubleInlineStartRule = /\\\\\(/g;
const doubleInlineRule = /^(\\\\\()((?:(?!\\\\\))[\s\S])+)\\\\\)/;
const doubleDisplayStartRule = /\\\\\[/g;
const doubleDisplayRule = /^(\\\\\[)((?:(?!\\\\\])[\s\S])+)\\\\\]/;

const DEFAULT_OPTIONS = {
    throwOnError: false,
    useKatexRender: false,
};

export default function (options: IOptions = {}) {
    const opts = Object.assign({}, DEFAULT_OPTIONS, options);

    return {
        // The single-backslash LaTeX delimiters travel with the dollar rules
        // unless the caller passes the flag: `use()` unshifts each tokenizer,
        // so the entries later in this array run first and `\(`/`\[` are
        // claimed before a `$` can be (#5481).
        extensions: [
            inlineKatex(createRenderer(opts, false)),
            blockKatex(createRenderer(opts, true), opts.authoredDisplayMath !== false),
            ...(opts.texMathSingleBackslash === false
                ? []
                : singleBackslashMathExtension(opts).extensions),
        ],
        walkTokens: createDisplayMathWalker(opts.authoredDisplayMath !== false),
    };
}

// Registered separately, and after the dollar extension: `Marked.use` unshifts,
// so the later registration is tried first and `` $`…`$ `` is claimed before
// `$…$` can take it with the backticks inside.
export function gfmMathExtension(options: IOptions = {}) {
    const opts = Object.assign({}, DEFAULT_OPTIONS, options);

    return {
        extensions: [inlineGfmKatex(createRenderer(opts, false))],
    };
}

// Each backslash extension supplies display classification even when dollar math is disabled.
export function singleBackslashMathExtension(options: IOptions = {}) {
    const opts = Object.assign({}, DEFAULT_OPTIONS, options);

    return {
        extensions: [
            backslashKatex(
                'inlineMathSingleBackslash',
                singleInlineStartRule,
                singleInlineRule,
                '\\)',
                createRenderer(opts, false),
            ),
            backslashKatex(
                'displayMathSingleBackslash',
                singleDisplayStartRule,
                singleDisplayRule,
                '\\]',
                createRenderer(opts, false),
            ),
        ],
        walkTokens: createDisplayMathWalker(opts.authoredDisplayMath !== false),
    };
}

export function doubleBackslashMathExtension(options: IOptions = {}) {
    const opts = Object.assign({}, DEFAULT_OPTIONS, options);

    return {
        extensions: [
            backslashKatex(
                'inlineMathDoubleBackslash',
                doubleInlineStartRule,
                doubleInlineRule,
                '\\\\)',
                createRenderer(opts, false),
            ),
            backslashKatex(
                'displayMathDoubleBackslash',
                doubleDisplayStartRule,
                doubleDisplayRule,
                '\\\\]',
                createRenderer(opts, false),
            ),
        ],
        walkTokens: createDisplayMathWalker(opts.authoredDisplayMath !== false),
    };
}

// The block half of muya's own `\[...\]` delimiters for callers that have not
// picked a pandoc backslash mode: a `\[`/`\]`-delimited display formula on its
// own lines becomes a `multiplemath` block (a `math-block` state on load),
// exactly like `$$` on its own lines. With `texMathSingleBackslash` chosen the
// formula stays a paragraph-level inline span, as pandoc reads it.
export function bracketBlockMathExtension(options: IOptions = {}) {
    const opts = Object.assign({}, DEFAULT_OPTIONS, options);

    return {
        extensions: [
            {
                name: 'multiplemath',
                level: 'block' as const,
                start(src: string) {
                    return src.search(/(?:^|\n)\\\[ */);
                },
                tokenizer(src: string) {
                    const match = src.match(blockBracketRule);
                    if (match) {
                        return {
                            type: 'multiplemath',
                            raw: match[0],
                            text: match[1].trim(),
                            displayMode: true,
                            mathStyle: '',
                        };
                    }
                },
                renderer: createRenderer(opts, true),
            },
        ],
    };
}

function isDisplayMathSpan(token: Token): token is Token & IMathToken {
    const { marker } = token as Partial<IMathToken>;

    return INLINE_MATH_TYPES.has(token.type) && marker !== undefined && DISPLAY_MATH_MARKERS.has(marker);
}

// Same rule as the editor: a display formula is display math only in a
// paragraph that holds nothing but such formulas. A tight list item's paragraph
// comes as a block-level `text` token; inline `text` tokens carry no `tokens`.
// `promoteTableCells` carries muya's extra claim — a math-only table cell drawn
// as display math — which the preview/export pipeline does not share.
function createDisplayMathWalker(promoteTableCells: boolean) {
    return function markDisplayMath(token: Token) {
        if (promoteTableCells && token.type === 'table') {
            // Table cells never arrive as paragraph tokens: marked's
            // walkTokens descends straight into each cell's inline tokens, so
            // promote math-only cells here.
            const table = token as Token & { header?: { tokens?: Token[] }[]; rows?: { tokens?: Token[] }[][] };
            const cells = [...(table.header ?? []), ...(table.rows ?? []).flat()];
            for (const cell of cells)
                promoteMathOnlySpans(cell.tokens);
            return;
        }

        const children = token.type === 'paragraph' || token.type === 'text' ? token.tokens : undefined;
        if (!children)
            return;

        promoteMathOnlySpans(children);
    };
}

function promoteMathOnlySpans(children: Token[] | undefined): void {
    if (!children)
        return;

    const onlyMath = children.some(isDisplayMathSpan)
        && children.every(child =>
            isDisplayMathSpan(child)
            || child.type === 'br'
            || (child.type === 'text' && child.raw.trim() === ''),
        );

    if (!onlyMath)
        return;

    for (const child of children) {
        if (isDisplayMathSpan(child))
            child.displayMode = true;
    }
}

function createRenderer(options: IOptions, newlineAfter: boolean) {
    return (token: IMathToken) => {
        const { useKatexRender, throwOnError, mathOutput = 'html' } = options;
        const { type, text, displayMode, marker = '$', closeMarker = marker, mathStyle } = token;
        if (useKatexRender && mathOutput === 'mathml') {
            const mathText = text.replace(/\\n/g, '\n');
            return renderMathToMathML(mathText, { displayMode }) + (newlineAfter ? '\n' : '');
        }
        if (useKatexRender) {
            // Marked treats `\\` at end of line as a Markdown hard line break
            // and escapes the trailing newline into the literal two-character
            // sequence `\n` (backslash + n) when passing token.text to inline
            // renderers. KaTeX then parses `\n` as an undefined control
            // sequence. Restore those literal `\n` back to real newlines; `\n`
            // is not a valid LaTeX command, so the reverse is safe.
            const mathText = text.replace(/\\n/g, '\n');
            return (
                renderMath(mathText, {
                    displayMode,
                    throwOnError,
                }) + (newlineAfter ? '\n' : '')
            );
        }
        else {
            return type === 'multiplemath'
                ? `<pre class="multiple-math" data-math-style="${mathStyle}">${text}</pre>\n`
                : `${marker}${text}${closeMarker}`;
        }
    };
}

function inlineGfmKatex(renderer: (token: IMathToken) => string) {
    return {
        name: 'inlineMathGfm',
        level: 'inline' as const,
        start(src: string) {
            gfmStartRule.lastIndex = 0;
            for (
                let match = gfmStartRule.exec(src);
                match;
                match = gfmStartRule.exec(src)
            ) {
                if (gfmRule.test(src.substring(match.index)))
                    return match.index;
            }
        },
        tokenizer(src: string) {
            const match = src.match(gfmRule);
            if (match) {
                return {
                    type: 'inlineMathGfm',
                    raw: match[0],
                    text: match[2].trim(),
                    marker: match[1],
                    closeMarker: '`$',
                    displayMode: false,
                };
            }
        },
        renderer,
    };
}

function backslashKatex(
    name: TInlineMathType,
    startRule: RegExp,
    rule: RegExp,
    closeMarker: string,
    renderer: (token: IMathToken) => string,
) {
    return {
        name,
        level: 'inline' as const,
        // Every opener is a candidate, not just the first: marked ends the
        // surrounding text token here, so bailing out on one that turns out not
        // to open a formula would hide every later formula on the line.
        start(src: string) {
            startRule.lastIndex = 0;
            for (
                let match = startRule.exec(src);
                match;
                match = startRule.exec(src)
            ) {
                if (rule.test(src.substring(match.index)))
                    return match.index;
            }
        },
        tokenizer(src: string) {
            const match = src.match(rule);
            if (match) {
                return {
                    type: name,
                    raw: match[0],
                    text: match[2].trim(),
                    marker: match[1],
                    closeMarker,
                    displayMode: false,
                };
            }
        },
        renderer,
    };
}

function inlineKatex(renderer: (token: IMathToken) => string) {
    return {
        name: 'inlineMath',
        level: 'inline' as const,
        // Every `$` is a candidate, not just the first one: marked stops the
        // surrounding text token here, so returning early on a `$` that turns
        // out not to open a formula would hide every later formula on the line
        // — "from $13B to $24B and $x+y$" must still find `$x+y$` (#5446).
        start(src: string) {
            inlineStartRule.lastIndex = 0;
            for (
                let match = inlineStartRule.exec(src);
                match;
                match = inlineStartRule.exec(src)
            ) {
                if (inlineRule.test(src.substring(match.index)))
                    return match.index;
            }
        },
        tokenizer(src: string) {
            const match = src.match(inlineRule);
            if (match) {
                return {
                    type: 'inlineMath',
                    raw: match[0],
                    text: match[2].trim(),
                    marker: match[1],
                    displayMode: false,
                };
            }
        },
        renderer,
    };
}

function blockKatex(renderer: (token: IMathToken) => string, claimSameLineMath: boolean) {
    return {
        name: 'multiplemath',
        level: 'block' as const,
        start(src: string) {
            return src.indexOf('\n$');
        },
        tokenizer(src: string) {
            const match = src.match(blockRule);
            if (match) {
                return {
                    type: 'multiplemath',
                    raw: match[0],
                    text: match[2].trim(),
                    displayMode: match[1].length === 2,
                    mathStyle: '',
                };
            }
            if (!claimSameLineMath)
                return;
            const singleLineMatch = src.match(blockSingleLineRule);
            if (singleLineMatch) {
                return {
                    type: 'multiplemath',
                    raw: singleLineMatch[0],
                    text: singleLineMatch[2].trim(),
                    displayMode: true,
                    mathStyle: '',
                };
            }
            const sameLineMatch = src.match(blockSameLineRule);
            if (sameLineMatch) {
                return {
                    type: 'multiplemath',
                    raw: sameLineMatch[0],
                    text: `${sameLineMatch[2].trim()}\n${sameLineMatch[3].trim()}`,
                    displayMode: true,
                    mathStyle: '',
                };
            }
        },
        renderer,
    };
}
