const { Marked } = require('marked')
const { markedHighlight } = require('marked-highlight')
const Prism = require('prismjs')

function highlight(code, lang) {
  if (!lang) return code
  const grammar = Prism.languages[lang]
  if (!grammar) {
    console.warn(`Unable to find grammar for "${lang}".`)
    return code
  }
  return Prism.highlight(code, grammar, lang)
}

const m = new Marked(markedHighlight({ highlight }))

const md1 = `| a | b |
|---|---|
| 1 | 2 |
`
const md2 = 'inline `code` here'
const md3 = `\`\`\`python
def f():
    pass
\`\`\`
`

console.log('TABLE:')
console.log(m.parse(md1))
console.log('INLINE CODE:')
console.log(m.parse(md2))
console.log('BLOCK CODE:')
console.log(m.parse(md3))
