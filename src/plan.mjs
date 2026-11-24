import { fail } from './config.mjs';
const reserved = new Set(['__proto__','prototype','constructor']);
const operations = {
  count: ['input'], take: ['input','limit'], flatten: ['input'], unique: ['input'],
  equals: ['input','value'], filter: ['input','where'], map: ['input','select']
};
function pathParts(value) {
  if (typeof value !== 'string' || !value) fail('EXPRESSION_INVALID', 'Reference paths must be nonempty strings.');
  const parts = value.split('.');
  if (parts.some(p => !p || reserved.has(p))) fail('EXPRESSION_INVALID', 'Reference contains an empty or reserved path segment.');
  return parts;
}
export function inspectExpression(value, { steps = new Set(), roots = new Set(['steps']) } = {}, depth = 0) {
  if (depth > 40) fail('EXPRESSION_LIMIT', 'Expression nesting exceeds 40.');
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const v of value) inspectExpression(v, { steps, roots }, depth + 1); return; }
  const keys = Object.keys(value);
  if (keys.some(k => reserved.has(k))) fail('EXPRESSION_INVALID', 'Unsafe expression object key.');
  if (Object.hasOwn(value, '$literal')) {
    if (keys.length !== 1) fail('EXPRESSION_INVALID', '$literal must be the only key in its object.');
    return;
  }
  if (Object.hasOwn(value, '$ref')) {
    if (keys.length !== 1) fail('EXPRESSION_INVALID', '$ref must be the only key in its object.');
    const parts = pathParts(value.$ref);
    if (!roots.has(parts[0])) fail('REFERENCE_SCOPE', `Reference root ${parts[0]} is unavailable here.`);
    if (parts[0] === 'steps' && parts.length > 1 && !steps.has(parts[1])) fail('REFERENCE_ORDER', `Step ${parts[1]} has not completed before this expression. Fix the step ID or order.`);
    return;
  }
  if (Object.hasOwn(value, '$op')) {
    const fields = operations[value.$op];
    if (!Array.isArray(fields) || fields.some(k => !Object.hasOwn(value,k)) || keys.some(k => k !== '$op' && !fields.includes(k))) fail('EXPRESSION_INVALID', 'Unknown operation, missing operand or unexpected expression field.');
    if (value.$op === 'take' && (!Number.isInteger(value.limit) || value.limit < 0 || value.limit > 500)) fail('EXPRESSION_INVALID', 'take requires a limit from 0 to 500.');
    inspectExpression(value.input, { steps, roots }, depth + 1);
    if (value.$op === 'equals') inspectExpression(value.value, { steps, roots }, depth + 1);
    if (value.$op === 'filter' || value.$op === 'map') {
      inspectExpression(value[value.$op === 'filter' ? 'where' : 'select'], { steps, roots: new Set([...roots,'item','index']) }, depth + 1);
    }
    return;
  }
  for (const v of Object.values(value)) inspectExpression(v, { steps, roots }, depth + 1);
}
export function hasReference(value) {
  if (!value || typeof value !== 'object') return false;
  if (Object.hasOwn(value, '$literal')) return false;
  if (Object.hasOwn(value, '$ref')) return true;
  return Object.values(value).some(hasReference);
}
export function inspectPlan(plan) {
  const steps = new Set();
  for (const step of plan.steps) {
    if (Object.hasOwn(step,'when')) inspectExpression(step.when, { steps });
    if (Object.hasOwn(step,'forEach')) inspectExpression(step.forEach, { steps });
    const roots = new Set(['steps', ...(Object.hasOwn(step,'forEach') ? ['item','index'] : [])]);
    inspectExpression(step.call.arguments ?? {}, { steps, roots });
    if (Object.hasOwn(step,'select')) inspectExpression(step.select, { steps, roots: new Set([...roots,'result']) });
    if (step.paginate) { pathParts(step.paginate.items); pathParts(step.paginate.nextCursor); }
    steps.add(step.id);
  }
  inspectExpression(plan.return, { steps });
}
