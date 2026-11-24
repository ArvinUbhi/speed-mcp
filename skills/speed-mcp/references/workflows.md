# Workflow language v1

## Envelope

```json
{
  "version": 1,
  "timeoutMs": 120000,
  "maxCalls": 100,
  "maxItems": 500,
  "steps": [],
  "return": {"$ref": "steps.last"}
}
```

`steps` must contain 1–50 entries. Each entry has unique `id` and `call`. Unknown envelope, call, step or pagination fields are rejected. Expressions are JSON objects as described below. No arbitrary code is executed.

## A call

```json
{
  "id": "jobs",
  "call": {
    "server": "actual-server-name",
    "tool": "actual-tool-name",
    "arguments": {"state": "failed"}
  },
  "select": {"jobs": {"$ref": "result.items"}}
}
```

`call.server` and `call.tool` must be literal strings. Arguments are an object evaluated recursively. Use exact input fields from `speed_mcp_describe`.

Results normalize as follows: use `structuredContent` if present; otherwise parse a single text block as JSON if possible; otherwise return `{ "text": "..." }` for a single text block. Multiple/nontext blocks return `{ "content": [...] }`, with image/audio payloads omitted. Treat resource blocks as data; they are not fetched automatically. An upstream `isError` fails the workflow.

`select` is optional and evaluates with `result` set to the normalized response. The stored value of `steps.jobs` is the selected value, so references in subsequent steps must reflect your selection.

## References

Use an object containing only `$ref`: `{"$ref":"steps.jobs.items"}`. References preserve JSON types. Do not interpolate with `${...}`, `{{...}}` or strings like `$steps.jobs`.

Paths are dot-separated own-property names; use numeric segments for arrays (`steps.jobs.0.id`). Keys containing dots cannot be addressed with this grammar. Missing paths fail; use an earlier discovery read instead of guessing. Prototype-related keys are blocked.

Available roots:

| Root | Available in |
| --- | --- |
| `steps` | Every expression; contains completed earlier steps only |
| `item`, `index` | `forEach` call arguments and selection; also map/filter expressions |
| `result` | A step's `select` only |

`{"$literal": VALUE}` returns VALUE without evaluating references inside it. Other plain objects/arrays are recursively evaluated. No reference to the workflow's environment, filesystem, network or globals exists.

## Repetition

```json
{
  "id": "logs",
  "forEach": {"$ref":"steps.jobs"},
  "concurrency": 2,
  "call": {
    "server":"processes",
    "tool":"get_log",
    "arguments":{"jobId":{"$ref":"item.id"}}
  },
  "select":{"id":{"$ref":"item.id"},"error":{"$ref":"result.error"}}
}
```

The step stores an array of selected results in original input order. Default concurrency is 1, maximum 8. Iterations can use results of earlier steps, not siblings. Nested step blocks are unsupported. An error aborts further scheduling and requests cancellation of in-flight calls; already completed work remains.

## Pagination

```json
{
  "id":"jobs",
  "call":{"server":"processes","tool":"list_jobs","arguments":{}},
  "paginate":{"cursorArgument":"cursor","nextCursor":"nextCursor","items":"items","maxPages":10}
}
```

The first call uses the supplied arguments. Later calls copy those arguments and set the top-level `cursorArgument` to the prior response's next cursor. The next-cursor field MUST exist and finish with `null` or `""`; omitted fields fail. `items` and `nextCursor` are paths relative to each normalized response, with no `result.` prefix. `items` must be an array. The step stores the concatenated array; a `select` sees that array as `result`.

Repeated cursors, excess items or remaining pages beyond `maxPages` cause explicit failure. No silent truncation. Numeric offset pagination and nested cursor arguments are unsupported; use direct tools or a separately constructed bounded series of steps.

## Conditions

`"when": EXPRESSION` evaluates before a step or foreach collection. A falsey value skips the entire step and stores `null`. Use boolean expressions, not strings containing code. There is no per-item `when`; filter the input array first.

## Transformations

Expressions use `$op` and `input`:

| Operation | Other fields | Result |
| --- | --- | --- |
| `count` | None | Array/string length |
| `take` | `limit`: integer 0–500 | First N array entries; deliberately partial |
| `flatten` | None | Flatten one array level |
| `unique` | None | Deduplicate array entries by JSON representation |
| `equals` | `value`: expression | Compare JSON representations |
| `filter` | `where`: expression using `item`/`index` | Retain matching array entries |
| `map` | `select`: expression using `item`/`index` | Transform array entries |

Examples:

```json
{"$op":"count","input":{"$ref":"steps.logs"}}
```

```json
{
  "$op":"filter",
  "input":{"$ref":"steps.jobs"},
  "where":{"$op":"equals","input":{"$ref":"item.state"},"value":"failed"}
}
```

The language intentionally has no regex, shell, arithmetic code, arbitrary functions or unbounded loops. Return data to Copilot for reasoning or use an explicitly authorized separate local analysis tool when needed.

## Complete example

The names and response fields below are illustrative. Replace them using actual tool descriptions and observed responses. This example assumes `list_jobs` returns `{items:[{id:...}],nextCursor:null|"..."}` and `get_log` returns `{error:"..."}`.

```json
{
  "version":1,
  "maxCalls":40,
  "maxItems":30,
  "timeoutMs":120000,
  "steps":[
    {
      "id":"jobs",
      "call":{"server":"processes","tool":"list_jobs","arguments":{"state":"failed"}},
      "paginate":{"cursorArgument":"cursor","nextCursor":"nextCursor","items":"items","maxPages":5}
    },
    {
      "id":"logs",
      "forEach":{"$ref":"steps.jobs"},
      "concurrency":2,
      "call":{"server":"processes","tool":"get_log","arguments":{"jobId":{"$ref":"item.id"}}},
      "select":{"id":{"$ref":"item.id"},"error":{"$ref":"result.error"}}
    }
  ],
  "return":{"jobsChecked":{"$op":"count","input":{"$ref":"steps.logs"}},"evidence":{"$ref":"steps.logs"}}
}
```

## Preflight and dry-run

Offline `validate` checks structure, expression operands, reference scope and step order. A typo such as `steps.jobz` is rejected before any application call. JSON literal values remain possible through `$literal`.

Use gateway `speed_mcp_run` with `dryRun: true`, or CLI `plan --file PLAN --workspace PATH` / `run --dry-run --file PLAN --workspace PATH`. The engine starts approved servers to check live catalogs, exact tool grants and input schemas. All arguments without references are evaluated and validated before execution, including arguments on later steps. No application tools are invoked by a dry-run. Arguments with references are resolved and validated at execution; actual output paths cannot be guaranteed in advance.

The dry-run report contains per-step conservative maximum call counts, effective limits, static/dynamic argument status and advisory read-only annotations. A dynamic collection assumes maxItems, and pagination assumes maxPages; the estimate may exceed actual work. A budget warning means the runtime could stop before completing the full collection. Narrow the plan instead of treating the warning as proof it will finish.

## Results and failures

Success: `{ok:true,result:...,trace:[...],stats:{calls,intermediateBytes,returnedBytes,durationMs}}`.
Failure: `{ok:false,error:{code,message,step},trace:[...],stats:...,notice:...}`. CLI exits nonzero; the gateway sets MCP `isError`. A failure can occur after successful tool calls. There is no transaction or rollback. Trace excludes tool arguments and returned data to avoid logging secrets; final evidence is the workflow author's explicit projection. Bytes measure normalized response data, not actual tokens.
