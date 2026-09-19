const { Marked } = require('marked')
const m = new Marked()

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
