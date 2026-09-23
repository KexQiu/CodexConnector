import { describe, expect, it } from 'vitest';
import { canTransition, holdsExecutionLock, isTerminal } from '../src/domain/model.js';

describe('task lifecycle contract', () => {
  it('accepts a terminal event before the start response', () => {
    expect(canTransition('starting', 'completed')).toBe(true);
    expect(canTransition('completed', 'running')).toBe(false);
    expect(canTransition('failed', 'running')).toBe(false);
    expect(canTransition('interrupted', 'starting')).toBe(false);
  });
  it('retains uncertain execution ownership and requires reconciliation', () => {
    expect(isTerminal('unknown')).toBe(false);
    expect(holdsExecutionLock('unknown')).toBe(true);
    expect(canTransition('unknown', 'queued')).toBe(false);
    expect(canTransition('unknown', 'starting')).toBe(false);
    expect(canTransition('unknown', 'completed')).toBe(true);
  });
  it('does not reserve a checkout for queued tasks', () => {
    expect(holdsExecutionLock('queued')).toBe(false);
    expect(holdsExecutionLock('starting')).toBe(true);
    expect(holdsExecutionLock('completed')).toBe(false);
  });
});
