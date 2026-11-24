import Ajv from 'ajv';
import { authorize, fail } from './config.mjs';
const ajv = new Ajv({ allErrors: true, strict: false });
const stepSchema = {
  type: 'object', additionalProperties: false, required: ['id', 'call'],
  properties: {
    id: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_-]{0,63}$' },
    call: { type: 'object', additionalProperties: false, required: ['server','tool'], properties: {
      server: { type: 'string', minLength: 1 }, tool: { type: 'string', minLength: 1 }, arguments: { type: 'object' }
    } },
    forEach: {}, when: {}, select: {},
    concurrency: { type: 'integer', minimum: 1, maximum: 8 },
    paginate: { type: 'object', additionalProperties: false, required: ['cursorArgument','nextCursor','items','maxPages'], properties: {
      cursorArgument: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_]*$' },
      nextCursor: { type: 'string', minLength: 1 }, items: { type: 'string', minLength: 1 },
      maxPages: { type: 'integer', minimum: 1, maximum: 50 }
    } }
  }
};
export const workflowSchema = {
  type: 'object', additionalProperties: false, required: ['version','steps','return'],
  properties: {
    version: { const: 1 }, steps: { type: 'array', minItems: 1, maxItems: 50, items: stepSchema }, return: {},
    timeoutMs: { type: 'integer', minimum: 100, maximum: 300000 },
    maxCalls: { type: 'integer', minimum: 1, maximum: 200 },
    maxItems: { type: 'integer', minimum: 1, maximum: 500 }
  }
};
const validate = ajv.compile(workflowSchema);
const unsafe = new Set(['__proto__','prototype','constructor']);
export function get(value, dotted) {
  if (typeof dotted !== 'string') fail('EXPRESSION_INVALID', 'Reference path must be a string.');
  for (const part of dotted.split('.')) {
    if (!part || unsafe.has(part) || value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) fail('REFERENCE_MISSING', `Reference ${dotted} does not exist. Inspect the actual schema/result; do not guess paths.`);
    value = value[part];
  }
  return value;
}
export function expression(value, context, depth = 0) {
  if (depth > 40) fail('EXPRESSION_LIMIT', 'Expression nesting exceeds 40.');
  if (Array.isArray(value)) return value.map(v => expression(v, context, depth + 1));
  if (value === null || typeof value !== 'object') return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === '$ref') return get(context, value.$ref);
  if (keys.length === 1 && keys[0] === '$literal') return value.$literal;
  if (Object.hasOwn(value, '$op')) {
    const input = expression(value.input, context, depth + 1);
    switch (value.$op) {
      case 'count': if (!Array.isArray(input) && typeof input !== 'string') fail('EXPRESSION_INVALID', 'count needs an array or string.'); return input.length;
      case 'take': if (!Array.isArray(input) || !Number.isInteger(value.limit) || value.limit < 0 || value.limit > 500) fail('EXPRESSION_INVALID', 'take needs an array and limit 0..500.'); return input.slice(0, value.limit);
      case 'flatten': if (!Array.isArray(input)) fail('EXPRESSION_INVALID', 'flatten needs an array.'); return input.flat();
      case 'unique': if (!Array.isArray(input)) fail('EXPRESSION_INVALID', 'unique needs an array.'); return [...new Map(input.map(v => [JSON.stringify(v), v])).values()];
      case 'equals': return JSON.stringify(input) === JSON.stringify(expression(value.value, context, depth + 1));
      case 'filter':
        if (!Array.isArray(input)) fail('EXPRESSION_INVALID', 'filter needs an array.');
        return input.filter((item, index) => Boolean(expression(value.where, { ...context, item, index }, depth + 1)));
      case 'map':
        if (!Array.isArray(input)) fail('EXPRESSION_INVALID', 'map needs an array.');
        return input.map((item, index) => expression(value.select, { ...context, item, index }, depth + 1));
      default: fail('EXPRESSION_INVALID', `Unknown operation ${value.$op}.`);
    }
  }
  return Object.fromEntries(keys.map(k => {
    if (unsafe.has(k)) fail('EXPRESSION_INVALID', 'Unsafe object key.');
    return [k, expression(value[k], context, depth + 1)];
  }));
}
export function checkWorkflow(plan) {
  if (!validate(plan)) fail('WORKFLOW_INVALID', `Invalid workflow: ${ajv.errorsText(validate.errors)}.`);
  const ids = new Set();
  for (const step of plan.steps) {
    if (unsafe.has(step.id)) fail('WORKFLOW_INVALID', 'Reserved step id.');
    if (ids.has(step.id)) fail('WORKFLOW_INVALID', `Duplicate step id ${step.id}.`);
    ids.add(step.id);
    if (!Object.hasOwn(step, 'forEach') && step.concurrency !== undefined) fail('WORKFLOW_INVALID', 'concurrency requires forEach.');
  }
}
export async function runWorkflow(plan, pool, { signal, maxOutputBytes = 65536, maxMemoryBytes = 8 * 1024 * 1024 } = {}) {
  const started = Date.now(); const trace = []; let calls = 0; let memoryBytes = 0;
  const steps = Object.create(null); let currentStep = null;
  const controller = new AbortController();
  const abort = () => controller.abort();
  controller.signal.addEventListener('abort', () => pool.abort?.(), { once: true });
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  let timer;
  const ensureActive = () => { if (controller.signal.aborted) fail('WORKFLOW_ABORTED', 'Workflow canceled or deadline exceeded. Completed calls are not rolled back; an interrupted call may have taken effect.'); };
  try {
    checkWorkflow(plan);
    timer = setTimeout(abort, plan.timeoutMs ?? 120000);
    // Validate every named tool and grant before the first operation can have effects.
    for (const step of plan.steps) {
      ensureActive();
      authorize(pool.entry(step.call.server), pool.policy, step.call.tool);
      const tools = await pool.catalog(step.call.server);
      if (!tools.some(t => t.name === step.call.tool)) fail('TOOL_UNAVAILABLE', `${step.call.server}/${step.call.tool} is unavailable.`);
    }
    async function invoke(step, local) {
      ensureActive();
      let args = expression(step.call.arguments ?? {}, local);
      const paged = []; let cursor; const seen = new Set(); let result;
      for (let page = 0; page < (step.paginate?.maxPages ?? 1); page++) {
        ensureActive();
        if (calls >= (plan.maxCalls ?? 100)) fail('CALL_LIMIT', 'Workflow call budget reached. Narrow the query.');
        calls++;
        const event = { step: step.id, server: step.call.server, tool: step.call.tool, status: 'started' };
        trace.push(event); const callStarted = Date.now();
        try {
          result = await pool.call(step.call.server, step.call.tool, args, controller.signal);
          event.status = 'completed';
        } catch (e) { event.status = 'failed_or_unknown'; throw e; }
        finally { event.durationMs = Date.now() - callStarted; }
        memoryBytes += Buffer.byteLength(JSON.stringify(result));
        if (memoryBytes > maxMemoryBytes) fail('MEMORY_LIMIT', 'Workflow intermediate data budget exceeded. Filter at the source.');
        if (!step.paginate) break;
        const items = get(result, step.paginate.items);
        if (!Array.isArray(items)) fail('PAGINATION_INVALID', 'Pagination items must be an array.');
        paged.push(...items);
        if (paged.length > (plan.maxItems ?? 500)) fail('ITEM_LIMIT', 'Pagination item limit reached. Narrow the query.');
        cursor = get(result, step.paginate.nextCursor);
        if (cursor === null || cursor === undefined || cursor === '') break;
        const key = JSON.stringify(cursor);
        if (seen.has(key)) fail('PAGINATION_LOOP', 'Server repeated a pagination cursor.');
        seen.add(key);
        if (page + 1 === step.paginate.maxPages) fail('PAGE_LIMIT', 'More pages remain. Increase maxPages within limits or narrow the query; results are incomplete.');
        args = { ...args, [step.paginate.cursorArgument]: cursor };
      }
      const normalized = step.paginate ? paged : result;
      return Object.hasOwn(step, 'select') ? expression(step.select, { ...local, result: normalized }) : normalized;
    }
    for (const step of plan.steps) {
      currentStep = step.id; ensureActive();
      const context = { steps };
      if (Object.hasOwn(step, 'when') && !expression(step.when, context)) { steps[step.id] = null; continue; }
      if (!Object.hasOwn(step, 'forEach')) steps[step.id] = await invoke(step, context);
      else {
        const items = expression(step.forEach, context);
        if (!Array.isArray(items) || items.length > (plan.maxItems ?? 500)) fail('ITEM_LIMIT', 'forEach requires an array within maxItems.');
        const output = new Array(items.length); let next = 0; let failed;
        const workers = Array.from({ length: Math.min(step.concurrency ?? 1, items.length) }, async () => {
          while (next < items.length && !failed) {
            const index = next++;
            try { output[index] = await invoke(step, { steps, item: items[index], index }); }
            catch (e) { failed ??= e; controller.abort(); }
          }
        });
        await Promise.allSettled(workers);
        if (failed) throw failed;
        steps[step.id] = output;
      }
    }
    ensureActive();
    const result = expression(plan.return, { steps });
    const bytes = Buffer.byteLength(JSON.stringify(result));
    if (bytes > maxOutputBytes) fail('OUTPUT_LIMIT', 'Final result exceeds 64 KiB. Use select/map/take/count to return less data. Completed calls are not repeated.');
    return { ok: true, result, trace, stats: { calls, intermediateBytes: memoryBytes, returnedBytes: bytes, durationMs: Date.now() - started } };
  } catch (e) {
    controller.abort();
    return { ok: false, error: { code: e.code ?? 'WORKFLOW_FAILED', message: pool.sanitize(e.message), step: currentStep }, trace, stats: { calls, intermediateBytes: memoryBytes, durationMs: Date.now() - started }, notice: 'Stopped without automatic retries. Completed calls are not rolled back. Failed or interrupted calls may have taken effect.' };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
