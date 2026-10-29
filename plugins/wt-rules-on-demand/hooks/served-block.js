// The exact text the engine serves for a rule. The engine's only "already served" record is a conversation holding this
// text verbatim, so every producer of a served copy renders it here. Pure: the hooks module host refuses Node imports.
export const servedBlock = (rule) => '<rule name="' + rule.name + '">\n' + rule.content + '\n</rule>';
