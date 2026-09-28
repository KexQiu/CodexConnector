/** The wire contract used by this adapter, independent of a Codex release number.
 * Keep requests, events and replies here in sync with their actual consumers.
 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ObjectValue = { [key: string]: Json };
const object = (value: Json | undefined): ObjectValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const array = (value: Json | undefined): Json[] => (Array.isArray(value) ? value : []);
export const clientMethods = {
  initialize: 'InitializeResponse',
  'thread/start': 'v2/ThreadStartResponse',
  'thread/resume': 'v2/ThreadResumeResponse',
  'thread/read': 'v2/ThreadReadResponse',
  'thread/list': 'v2/ThreadListResponse',
  'thread/loaded/list': 'v2/ThreadLoadedListResponse',
  'thread/turns/list': 'v2/ThreadTurnsListResponse',
  'turn/start': 'v2/TurnStartResponse',
  'turn/steer': 'v2/TurnSteerResponse',
  'turn/interrupt': 'v2/TurnInterruptResponse',
  'project/list': 'v2/ProjectListResponse',
  'config/read': 'v2/ConfigReadResponse',
  'configRequirements/read': 'v2/ConfigRequirementsReadResponse',
  'model/list': 'v2/ModelListResponse',
  'account/read': 'v2/GetAccountResponse',
  'account/rateLimits/read': 'v2/GetAccountRateLimitsResponse',
};
const serverMethods = {
  'item/commandExecution/requestApproval': 'CommandExecutionRequestApprovalResponse',
  'item/fileChange/requestApproval': 'FileChangeRequestApprovalResponse',
  'item/permissions/requestApproval': 'PermissionsRequestApprovalResponse',
  'item/tool/requestUserInput': 'ToolRequestUserInputResponse',
};
const notifications = [
  'turn/started',
  'turn/completed',
  'item/started',
  'item/completed',
  'serverRequest/resolved',
  'thread/closed',
  'thread/settings/updated',
  'thread/tokenUsage/updated',
  'model/rerouted',
  'account/updated',
  'account/rateLimits/updated',
];
const annotations = new Set([
  'description',
  'title',
  '$schema',
  '$id',
  'default',
  'examples',
  'deprecated',
]);
// Only retain fields sent or consumed by the gateway for these broad types.
// Other definitions are intentionally conservative: changes require review.
const projection: Record<string, string[]> = {
  '#/definitions/v2/ThreadStartParams': [
    'cwd',
    'runtimeWorkspaceRoots',
    'sandbox',
    'approvalPolicy',
    'approvalsReviewer',
    'config',
    'historyMode',
    'ephemeral',
  ],
  '#/definitions/v2/ThreadResumeParams': [
    'threadId',
    'cwd',
    'runtimeWorkspaceRoots',
    'sandbox',
    'approvalPolicy',
    'approvalsReviewer',
    'config',
    'excludeTurns',
  ],
  '#/definitions/v2/TurnStartParams': [
    'threadId',
    'clientUserMessageId',
    'input',
    'cwd',
    'runtimeWorkspaceRoots',
    'approvalPolicy',
    'approvalsReviewer',
    'sandboxPolicy',
  ],
  '#/definitions/v2/ThreadStartResponse': ['thread', 'approvalPolicy', 'sandbox'],
  '#/definitions/v2/ThreadResumeResponse': ['thread', 'approvalPolicy', 'sandbox'],
  '#/definitions/v2/Thread': [
    'id',
    'cwd',
    'path',
    'name',
    'preview',
    'updatedAt',
    'historyMode',
    'model',
    'reasoningEffort',
    'status',
    'turns',
  ],
  '#/definitions/v2/Model': ['model', 'isDefault', 'defaultReasoningEffort'],
  '#/definitions/v2/GetAccountResponse': ['account'],
  '#/definitions/v2/ThreadSettings': ['model', 'effort'],
  '#/definitions/v2/WebSearchItem': ['id'],
  '#/definitions/v2/Config': ['model', 'model_reasoning_effort', 'features', 'mcp_servers'],
  '#/definitions/v2/ConfigRequirements': ['models'],
};
function reference(document: Json, ref: string): Json {
  if (!ref.startsWith('#/definitions/')) throw new Error('Unsupported schema reference');
  let result: Json | undefined = document;
  for (const key of ref.slice(2).split('/')) result = object(result)[key];
  if (result === undefined) throw new Error(`Missing schema reference: ${ref}`);
  return result;
}
function projected(value: Json, ref: string, candidate = false): Json {
  const select = (value: Json, fields: string[]): Json => {
    const obj = object(value);
    if (!obj.properties) return value;
    return {
      ...obj,
      properties: Object.fromEntries(
        Object.entries(object(obj.properties)).filter(([k]) => fields.includes(k)),
      ),
      // Never discard newly required candidate inputs, including unknown fields.
      ...(candidate
        ? {}
        : {
            required: array(obj.required).filter(
              (k) => typeof k === 'string' && fields.includes(k),
            ),
          }),
    };
  };
  if (ref === '#/definitions/v2/ThreadItem') {
    const item = (v: Json): Json => {
      const o = object(v);
      if (Array.isArray(o.allOf)) return { ...o, allOf: o.allOf.map(item) };
      const tag = array(object(object(o.properties).type).enum)[0];
      return select(v, [
        'id',
        'type',
        ...(tag === 'agentMessage' ? ['text'] : tag === 'fileChange' ? ['changes'] : []),
      ]);
    };
    const obj = object(value);
    return { ...obj, oneOf: array(obj.oneOf).map(item) };
  }
  if (ref === '#/definitions/v2/UserInput') {
    const obj = object(value);
    return {
      ...obj,
      oneOf: array(obj.oneOf).filter((v) =>
        array(object(object(object(v).properties).type).enum).includes('text'),
      ),
    };
  }
  return projection[ref] ? select(value, projection[ref]) : value;
}

function method(document: Json, family: string, name: string): Json {
  const root = object(reference(document, `#/definitions/${family}`));
  const matches = array(root.oneOf).filter((v) =>
    array(object(object(object(v).properties).method).enum).includes(name),
  );
  if (matches.length !== 1) throw new Error(`Missing or ambiguous method: ${name}`);
  return matches[0]!;
}
export type Contract = {
  id: string;
  sourceVersion: string;
  definitions: ObjectValue;
  entries: {
    name: string;
    direction: 'send' | 'receive';
    schema: Json;
    family?: string;
    method?: string;
    response?: string;
  }[];
};
export function buildContract(document: Json, sourceVersion: string): Contract {
  const entries: Contract['entries'] = [];
  for (const [name, response] of Object.entries(clientMethods)) {
    entries.push({
      name: `${name}:request`,
      direction: 'send',
      family: 'ClientRequest',
      method: name,
      schema: method(document, 'ClientRequest', name),
    });
    entries.push({
      name: `${name}:response`,
      direction: 'receive',
      response,
      schema: { $ref: `#/definitions/${response}` },
    });
  }
  entries.push({
    name: 'initialized',
    direction: 'send',
    family: 'ClientNotification',
    method: 'initialized',
    schema: method(document, 'ClientNotification', 'initialized'),
  });
  for (const name of notifications)
    entries.push({
      name,
      direction: 'receive',
      family: 'ServerNotification',
      method: name,
      schema: method(document, 'ServerNotification', name),
    });
  for (const [name, response] of Object.entries(serverMethods)) {
    entries.push({
      name,
      direction: 'receive',
      family: 'ServerRequest',
      method: name,
      schema: method(document, 'ServerRequest', name),
    });
    entries.push({
      name: `${name}:response`,
      direction: 'send',
      response,
      schema: { $ref: `#/definitions/${response}` },
    });
  }
  const definitions: ObjectValue = {};
  const seen = new Set<string>();
  function visit(value: Json): Json {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    if (typeof value.$ref === 'string' && !seen.has(value.$ref)) {
      const ref = value.$ref;
      seen.add(ref);
      const parts = ref.slice('#/definitions/'.length).split('/');
      let dest = definitions;
      for (const p of parts.slice(0, -1)) {
        dest[p] ??= {};
        dest = object(dest[p]);
      }
      dest[parts.at(-1)!] = visit(projected(reference(document, ref), ref));
    }
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !annotations.has(key))
        .map(([key, v]) => [key, visit(v)]),
    );
  }
  for (const e of entries) e.schema = visit(e.schema);
  return { id: 'gateway-v1', sourceVersion, definitions, entries };
}
const canonical = (value: Json | undefined): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
};
/** Conservative directional comparison, not a general JSON Schema implication prover.
 * Additive methods/optional request fields/response fields are tolerated. Union,
 * constraint and permission shape changes fail closed for adapter review.
 */
export function compareContract(contract: Contract, candidate: Json): string[] {
  const issues: string[] = [],
    seen = new Set<string>();
  const fail = (path: string, detail: string) => {
    if (issues.length < 12) issues.push(`${path}: ${detail}`);
  };
  let visits = 0;
  function compare(
    a: Json | undefined,
    b: Json | undefined,
    direction: 'send' | 'receive',
    path: string,
    strict = false,
    depth = 0,
  ) {
    if (++visits > 50000 || depth > 150) throw new Error('Schema complexity limit');
    const x = object(a),
      y = object(b);
    if (typeof x.$ref === 'string' || typeof y.$ref === 'string') {
      const refA = typeof x.$ref === 'string' ? x.$ref : null,
        refB = typeof y.$ref === 'string' ? y.$ref : null;
      // Unknown constraints next to $ref need review, including when only one side uses a ref.
      for (const schema of [x, y])
        if (typeof schema.$ref === 'string') {
          if (Object.keys(schema).some((k) => k !== '$ref' && !annotations.has(k)))
            fail(path, 'reference sibling constraints require review');
        }
      const key = `${direction}:${refA}:${refB}:${strict}`;
      if (refA && refB) {
        if (seen.has(key)) return;
        seen.add(key);
      }
      const locked = strict || /Permission|Sandbox|Approval/.test(refA ?? '');
      compare(
        refA ? reference(contract, refA) : a,
        refB ? projected(reference(candidate, refB), refB, true) : b,
        direction,
        path,
        locked,
        depth + 1,
      );
      return;
    }
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
        fail(path, 'union/array shape changed');
        return;
      }
      a.forEach((v, i) => compare(v, b[i], direction, `${path}[${i}]`, strict, depth + 1));
      return;
    }
    if (!a || typeof a !== 'object' || !b || typeof b !== 'object') {
      if (canonical(a) !== canonical(b)) fail(path, 'type/value changed');
      return;
    }
    const ap = object(x.properties),
      bp = object(y.properties);
    const required = (value: Json | undefined): string[] => {
      if (value === undefined) return [];
      if (!Array.isArray(value) || value.some((k) => typeof k !== 'string'))
        throw new Error('Malformed required list');
      return value as string[];
    };
    const ar = required(x.required),
      br = required(y.required);
    if (direction === 'send') {
      for (const k of br) if (!ar.includes(k)) fail(path, `new required input ${k}`);
    } else {
      for (const k of ar) if (!br.includes(k)) fail(path, `required output lost ${k}`);
    }
    for (const key of Object.keys(ap)) {
      if (!Object.hasOwn(bp, key)) fail(`${path}.${key}`, 'field removed');
      else compare(ap[key], bp[key], direction, `${path}.${key}`, strict, depth + 1);
    }
    if (strict)
      for (const key of Object.keys(bp))
        if (!Object.hasOwn(ap, key))
          fail(`${path}.${key}`, 'permission field added; review required');
    for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (annotations.has(key) || ['properties', 'required'].includes(key)) continue;
      if (key === 'enum' || key === 'type') {
        const sort = (v: Json | undefined) =>
          Array.isArray(v) ? [...v].sort((l, r) => canonical(l).localeCompare(canonical(r))) : v;
        if (canonical(sort(x[key])) !== canonical(sort(y[key])))
          fail(`${path}.${key}`, 'type/enum changed');
      } else compare(x[key], y[key], direction, `${path}.${key}`, strict, depth + 1);
    }
  }
  for (const entry of contract.entries) {
    try {
      const actual = entry.response
        ? { $ref: `#/definitions/${entry.response}` }
        : method(candidate, entry.family!, entry.method!);
      compare(entry.schema, actual, entry.direction, entry.name);
    } catch {
      fail(entry.name, 'schema missing, malformed or too complex');
    }
  }
  return issues;
}
