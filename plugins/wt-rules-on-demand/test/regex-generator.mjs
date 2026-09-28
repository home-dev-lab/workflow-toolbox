export function generator(seed) {
  let state = seed >>> 0;
  const next = (n) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % n; };
  const atoms = ['a', 'b', 'c', ' ', '[ab]', '[^a ]', '\\s', '\\S'];
  const quantifiers = ['', '', '?', '*', '+', '{2}', '{0,2}', '{1,3}'];
  const item = (depth) => {
    if (depth < 2 && next(4) === 0) return `(?:${body(depth + 1)})${quantifiers[next(quantifiers.length)]}`;
    return `${atoms[next(atoms.length)]}${quantifiers[next(quantifiers.length)]}`;
  };
  const sequence = (depth) => Array.from({ length: 1 + next(3) }, () => item(depth)).join('');
  const body = (depth) => next(3) === 0 ? `${sequence(depth)}|${sequence(depth)}` : sequence(depth);
  const runs = ['a', 'b', '\\S', '\\s', '[ab]', '[^ ]', 'c'];
  const terminators = ['b', 'c', ' ', '\\s', '\\S', 'a', '(?:ab)', '(?:a|b)', '(?:cc|ca)', 'c?'];
  const near = () => Array.from({ length: 1 + next(3) }, () => `${runs[next(runs.length)]}${['+', '*', '{1,3}', '?'][next(4)]}${terminators[next(terminators.length)]}`).join(next(4) === 0 ? '|' : '');
  const outer = ['+', '*', '{0,6}', '{2,5}'];
  return () => `^(?:${next(2) ? near() : body(0)})${outer[next(outer.length)]}$`;
}
