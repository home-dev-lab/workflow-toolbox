function memberName(node) {
  const property = node.property
  if (!node.computed && property.type === 'Identifier') return property.name
  if (node.computed && property.type === 'Literal') return property.value
  if (node.computed && property.type === 'TemplateLiteral' && property.expressions.length === 0) {
    return property.quasis[0]?.value.cooked
  }
  return null
}

function isReplacementMember(node) {
  if (node.type !== 'MemberExpression') return false
  const name = memberName(node)
  return name === 'replace' || name === 'replaceAll'
}

function isSafeReplacement(node) {
  if (node.type === 'Literal') return typeof node.value === 'string'
  if (node.type === 'TemplateLiteral') return node.expressions.length === 0
  return node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression'
}

export const noDynamicReplace = {
  meta: {
    type: 'problem',
    docs: { description: 'Require dynamic String.replace replacements to use a callback' },
    schema: [],
    messages: {
      dynamicReplacement: 'To comply, wrap it as () => value or pass an inline function so String.replace does not expand $ replacement patterns.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isReplacementMember(node.callee)) return
        const spread = node.arguments.find((argument) => argument.type === 'SpreadElement')
        if (spread) {
          context.report({ node: spread, messageId: 'dynamicReplacement' })
          return
        }
        const replacement = node.arguments[1]
        if (replacement && !isSafeReplacement(replacement)) {
          context.report({ node: replacement, messageId: 'dynamicReplacement' })
        }
      },
      MemberExpression(node) {
        if (memberName(node) === 'bind' && isReplacementMember(node.object)) {
          context.report({ node, messageId: 'dynamicReplacement' })
        }
      },
    }
  },
}
