import { renderMath, renderMathToMathML } from '../../katex';

export interface IMathToken {
    type: 'inlineMath' | 'multiplemath';
    raw: string;
    text: string;
    displayMode: boolean;
    mathStyle?: '' | 'gitlab';
}

interface IOptions {
    throwOnError?: boolean;
    useKatexRender?: boolean;
    // 'html' renders KaTeX's full HTML+MathML markup, 'mathml' renders
    // standalone MathML (Word converts it to a native equation on paste).
    mathOutput?: 'html' | 'mathml';
}

// A `$` may open inline math. `(?!\s)` keeps `$ 100` out; a leading digit is
// allowed here and filtered in `start()`, because banning all digits also bans
// real math such as `$0.1^\circ$`.
const inlineStartRule = /(^|[^a-zA-Z0-9_])\${1,2}(?!\$)(?!\s)/;
// A currency span: `$<digit>` whose content has whitespace but no LaTeX syntax
// at all (`The price is $5 and $ 100.`). Anything else digit-initial — `$2$`,
// `$0.976$`, `$10\text{ m}$` — is treated as math, matching the editor's own
// inline renderer, which has no digit ban.
const CURRENCY_CONTENT_REG = /^\s*[0-9][0-9.,]*\s/;
const inlineRule
    = /^(\${1,2})(?!\$)((?:\\.|[^\\\n])*?(?:\\.|[^\\\n$]))\1(?=[\s?!.,:，。、；：？！…—～（）()【】\[\]《》""''「」]|$)/;
const blockSingleLineRule = /^(\${2})(?!\$)((?:\\.|[^\\\n])+?)\1[ \t]*(?:\r?\n|$)/;
// Block math requires $$ (double dollar) as the delimiter. Single $ is for
// inline math only. Accepting single $ as a block delimiter causes cascading
// failures with malformed input like "$\n$\bigcup...\n$\n$" — the orphan $
// gets treated as a block opener and consumes subsequent formulas' $$
// delimiters, breaking everything after it.
const blockRule = /^(\${2})\r?\n((?:\\[\s\S]|[^\\])+?)(?:\r?\n\1|\1)[ \t]*(?:\r?\n|$)/;
// Allow the opening $$ to share its line with the first line of math:
// $$\begin{aligned}
//   ...
// \end{aligned}
// $$
// The closing $$ may either be on its own line or share the last line
// (e.g. \end{aligned}$$).
// Also allow the opening $$ to sit on its own line (group 2 may be empty).
const blockSameLineRule = /^(\$\$)(?!\$)((?:\\.|[^\\\n])*)\r?\n((?:\\[\s\S]|[^\\])+?)(?:\r?\n\1|\1)[ \t]*(?:\r?\n|$)/;

// LaTeX `\(...\)` inline and `\[...\]` block delimiters. The `$`/`$$` rules
// above are unchanged; these mirror them so documents authored with the
// backslash delimiters render too.
//
// Start rules look for the delimiter while ignoring an escaped delimiter (an
// odd number of preceding backslashes), matching the inline renderer's
// `isLengthEven` check.
const inlineParenStartRule = /(?:^|[^\\])(?:\\\\)*\\\(/;
const inlineParenRule = /^\\\(((?:\\.|[^\\\n])+?)\\\)/;
const inlineBracketStartRule = /(?:^|[^\\])(?:\\\\)*\\\[/;
const inlineBracketRule = /^\\\[((?:\\.|[^\\\n])+?)\\\]/;
const blockBracketRule
    = /^\\\[ *\r?\n((?:\\[\s\S]|[^\\])+?)\r?\n *\\\][ \t]*(?:\r?\n|$)/;

const DEFAULT_OPTIONS = {
    throwOnError: false,
    useKatexRender: false,
};

export default function (options: IOptions = {}) {
    const opts = Object.assign({}, DEFAULT_OPTIONS, options);

    return {
        extensions: [
            inlineKatex(createRenderer(opts, false)),
            inlineKatexParen(createRenderer(opts, false)),
            inlineKatexBracket(createRenderer(opts, false)),
            blockKatex(createRenderer(opts, true)),
        ],
    };
}

function createRenderer(options: IOptions, newlineAfter: boolean) {
    return (token: IMathToken) => {
        const { useKatexRender, throwOnError, mathOutput = 'html' } = options;
        const { type, text, displayMode, mathStyle } = token;
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
            return type === 'inlineMath'
                ? `$${text}$`
                : `<pre class="multiple-math" data-math-style="${mathStyle}">${text}</pre>\n`;
        }
    };
}

function inlineKatex(renderer: (token: IMathToken) => string) {
    return {
        name: 'inlineMath',
        level: 'inline' as const,
        start(src: string) {
            const match = src.match(inlineStartRule);
            if (!match)
                return;

            const index = (match.index || 0) + match[1].length;
            const possibleKatex = src.substring(index);
            const math = possibleKatex.match(inlineRule);
            if (!math)
                return;
            // Returning nothing here is not a neutral outcome: Marked's text
            // rule only stops where an extension reports a start, so a missed
            // candidate swallows the rest of the paragraph as plain text and
            // every formula after it leaks as literal `$…$`.
            if (CURRENCY_CONTENT_REG.test(math[2]))
                return;
            return index;
        },
        tokenizer(src: string) {
            const match = src.match(inlineRule);
            if (match) {
                return {
                    type: 'inlineMath',
                    raw: match[0],
                    text: match[2].trim(),
                    displayMode: match[1].length === 2,
                };
            }
        },
        renderer,
    };
}

function inlineKatexParen(renderer: (token: IMathToken) => string) {
    return {
        name: 'inlineMathParen',
        level: 'inline' as const,
        start(src: string) {
            const match = src.match(inlineParenStartRule);
            if (!match)
                return;

            const index = (match.index || 0) + match[0].length - 2;
            const possibleKatex = src.substring(index);

            if (inlineParenRule.test(possibleKatex))
                return index;
        },
        tokenizer(src: string) {
            const match = src.match(inlineParenRule);
            if (match) {
                return {
                    type: 'inlineMath',
                    raw: match[0],
                    text: match[1].trim(),
                    displayMode: false,
                };
            }
        },
        renderer,
    };
}

function inlineKatexBracket(renderer: (token: IMathToken) => string) {
    return {
        name: 'inlineMathBracket',
        level: 'inline' as const,
        start(src: string) {
            const match = src.match(inlineBracketStartRule);
            if (!match)
                return;

            const index = (match.index || 0) + match[0].length - 2;
            const possibleKatex = src.substring(index);

            if (inlineBracketRule.test(possibleKatex))
                return index;
        },
        tokenizer(src: string) {
            const match = src.match(inlineBracketRule);
            if (match) {
                return {
                    type: 'inlineMath',
                    raw: match[0],
                    text: match[1].trim(),
                    displayMode: true,
                };
            }
        },
        renderer,
    };
}

function blockKatex(renderer: (token: IMathToken) => string) {
    return {
        name: 'multiplemath',
        level: 'block' as const,
        start(src: string) {
            // Only search for $$ (double dollar) for block math. Single $ is
            // handled by the inline math tokenizer and should not trigger
            // block-level matching.
            const dollar = src.search(/(?:^|\n)\${2}(?!\$)/);
            const bracket = src.search(/(?:^|\n)\\\[ */);
            if (dollar === -1)
                return bracket;
            if (bracket === -1)
                return dollar;
            return Math.min(dollar, bracket);
        },
        tokenizer(src: string) {
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
            const sameLineMatch = src.match(blockSameLineRule);
            if (sameLineMatch) {
                return {
                    type: 'multiplemath',
                    raw: sameLineMatch[0],
                    text: `${sameLineMatch[2].trim()}\n${sameLineMatch[3].trim()}`,
                    displayMode: sameLineMatch[1].length === 2,
                    mathStyle: '',
                };
            }
            const bracketMatch = src.match(blockBracketRule);
            if (bracketMatch) {
                return {
                    type: 'multiplemath',
                    raw: bracketMatch[0],
                    text: bracketMatch[1].trim(),
                    displayMode: true,
                    mathStyle: '',
                };
            }
        },
        renderer,
    };
}
