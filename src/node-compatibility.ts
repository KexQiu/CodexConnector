import baseline from './runtime-baseline.json' with { type: 'json' };

/** Deliberately supports explicit stable major lines, not every newer Node release. */
export function inspectNode(actual = process.versions.node, napi = process.versions.napi) {
  const version = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(actual);
  const supported =
    !!version &&
    baseline.nodeSupported.split(' || ').some((range) => {
      const minimum = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
      if (!minimum) throw new Error('Node 支持范围配置无效');
      return (
        version[1] === minimum[1] &&
        (Number(version[2]) > Number(minimum[2]) ||
          (version[2] === minimum[2] && Number(version[3]) >= Number(minimum[3])))
      );
    });
  return {
    expected: baseline.nodeSupported,
    bundled: baseline.node,
    actual,
    napi: napi ?? null,
    minimumNapi: baseline.nodeApiMinimum,
    ok: supported && /^\d+$/.test(napi ?? '') && Number(napi) >= baseline.nodeApiMinimum,
  };
}

export function nodeCompatibilityMessage(check = inspectNode()): string {
  return `Node 版本不兼容：实际 ${check.actual}，支持 ${check.expected}，且需要 Node-API ≥ ${check.minimumNapi}`;
}
