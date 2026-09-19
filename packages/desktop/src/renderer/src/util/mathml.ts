// KaTeX MathML cleanup for the DOCX converters (pandoc and mathml2omml).
//
// Two shapes in KaTeX's MathML layer break Word conversion:
//
//  1. Script elements with too many children. KaTeX emits its invisible
//     function-application marker (U+2061) as a trailing `<mo>` even when the
//     operator is being subscripted, so `$x_{\max}$` becomes
//     `<msub><mi>x</mi><mi>max</mi><mo>⁡</mo></msub>` — three children where
//     MathML allows two. pandoc rejects the entire `<math>` for that and falls
//     back to flattened text, which is how the formula reached the document
//     garbled.
//
//  2. The raw-TeX payload. KaTeX carries the source in
//     `<semantics><annotation encoding="application/x-tex">…`; pandoc prefers
//     an annotation over the MathML body, and when conversion fails the TeX
//     leaks into the document as literal text. A sanitizer that unwraps
//     `<semantics>` makes it worse: the annotation collapses into a bare text
//     node as a direct child of `<math>`, which browsers *and* pandoc read as
//     math content.
//
// Neither carries semantics that Word needs, so dropping them loses nothing.

const MATHML_NS = 'http://www.w3.org/1998/Math/MathML'

// KaTeX's invisible operators: function application, invisible times and
// invisible separator. Pure typesetting markers, never a math object.
const INVISIBLE_OPS = '\u2061\u2062\u2063'

// MathML tag -> number of element children the spec allows.
const SCRIPT_ARITY: Record<string, number> = {
  msub: 2,
  msup: 2,
  msubsup: 3,
  munder: 2,
  mover: 2,
  munderover: 3
}

const TEXT_NODE = 3

const isInvisibleOperator = (el: Element): boolean => {
  if (el.tagName.toLowerCase() !== 'mo') return false
  const text = (el.textContent || '').trim()
  return text.length > 0 && [...text].every(ch => INVISIBLE_OPS.includes(ch))
}

/**
 * Give every script element the number of children MathML allows, so a
 * converter is not forced to reject the whole expression. KaTeX's invisible
 * operators are dropped outright (they are the usual cause); any remaining
 * overflow is folded into the last script slot inside an `<mrow>`.
 */
const fixScriptArity = (math: Element): void => {
  const doc = math.ownerDocument
  for (const el of math.querySelectorAll(Object.keys(SCRIPT_ARITY).join(','))) {
    const max = SCRIPT_ARITY[el.tagName.toLowerCase()]
    for (const child of Array.from(el.children)) {
      if (isInvisibleOperator(child)) child.remove()
    }
    const kids = Array.from(el.children)
    if (kids.length <= max) continue
    const overflow = doc.createElementNS(MATHML_NS, 'mrow')
    for (const kid of kids.slice(max - 1)) overflow.appendChild(kid)
    el.appendChild(overflow)
  }
}

/**
 * Strip the raw-TeX annotation, then flatten `<semantics>` — once its
 * annotations are gone it is pure nesting — and defend against a bare text
 * node left behind as a direct child of `<math>`.
 */
const removeTexPayload = (math: Element): void => {
  for (const annotation of math.querySelectorAll('annotation')) annotation.remove()

  for (const semantics of math.querySelectorAll('semantics')) {
    const parent = semantics.parentNode
    if (!parent) continue
    let child = semantics.firstChild
    while (child) {
      const next = child.nextSibling
      parent.insertBefore(child, semantics)
      child = next
    }
    semantics.remove()
  }

  for (const node of Array.from(math.childNodes)) {
    if (node.nodeType === TEXT_NODE && (node.textContent || '').trim()) node.remove()
  }
}

/**
 * Clean one KaTeX `<math>` element in place so a DOCX converter receives
 * semantic MathML only: no raw TeX, no KaTeX layout placeholders, and no
 * spec-invalid element arity.
 */
export const cleanKaTeXMathML = (math: Element): void => {
  removeTexPayload(math)

  // Remove layout-only table cells KaTeX emits for centered / numbered
  // environments (gather, align); Word renders the empty ones as visible boxes.
  for (const mtd of math.querySelectorAll('mtd')) {
    const cls = (mtd.getAttribute('class') || '').trim()
    if (cls.includes('mtr-glue')) {
      mtd.remove()
      continue
    }
    if (cls.includes('mml-eqn-num') && (mtd.textContent || '').trim() === '') {
      mtd.remove()
    }
  }

  // Remove stray red newline markers that KaTeX occasionally emits after `\\`.
  for (const mstyle of math.querySelectorAll('mstyle[mathcolor="#cc0000"]')) {
    const children = Array.from(mstyle.children)
    if (children.length === 1 && children[0].tagName.toLowerCase() === 'mtext') {
      const text = (children[0].textContent || '').trim()
      if (text === '' || text === '\\n') {
        mstyle.remove()
      }
    }
  }

  fixScriptArity(math)
}
