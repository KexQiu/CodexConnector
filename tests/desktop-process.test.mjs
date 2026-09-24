import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { it, expect, vi } from 'vitest';
import { stopOwnedChild, ownedChildAlive } from '../src/service/child.ts';
import { ServiceLeases } from '../src/service/state.ts';

it('terminates only its detached process group, including a TERM-resistant descendant', async () => {
  const unrelated = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  const owned = spawn(
    process.execPath,
    [
      '-e',
      `const{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);console.log('ready')"],{stdio:['ignore','pipe','ignore']});child.stdout.once('data',()=>console.log('ready'));setInterval(()=>{},1000);`,
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  try {
    await once(owned.stdout, 'data');
    await stopOwnedChild(owned, true, 150, 3000);
    expect(ownedChildAlive(owned, true)).toBe(false);
    expect(unrelated.exitCode).toBeNull();
    expect(unrelated.signalCode).toBeNull();
  } finally {
    await Promise.all([stopOwnedChild(owned, true, 100), stopOwnedChild(unrelated)]);
  }
});
it('retains uncertainty on a denied group probe and does not report successful cleanup', async () => {
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('denied'), { code: 'EPERM' });
  });
  try {
    const child = { pid: 123456 };
    expect(ownedChildAlive(child, true)).toBe(true);
    await expect(stopOwnedChild(child, true, 1, 1)).rejects.toThrow('尚未退出');
  } finally {
    kill.mockRestore();
  }
});
it('cleans descendants after the direct owned parent has already exited', async () => {
  const owned = spawn(
    process.execPath,
    [
      '-e',
      `const{spawn}=require('node:child_process');spawn('/bin/sleep',['30'],{stdio:'ignore'}).unref();`,
    ],
    { detached: true, stdio: 'ignore' },
  );
  await once(owned, 'exit');
  expect(ownedChildAlive(owned, true)).toBe(true);
  const root = mkdtempSync(join(tmpdir(), 'cc-group-'));
  const leases = new ServiceLeases(root);
  const token = leases.acquire('app-server');
  leases.child(token, owned.pid, true);
  leases.db.prepare('UPDATE leases SET pid=?').run(2147483647);
  try {
    expect(() => leases.acquire('app-server')).toThrow('拒绝抢占');
    await stopOwnedChild(owned, true, 100);
    expect(ownedChildAlive(owned, true)).toBe(false);
    expect(leases.acquire('app-server')).not.toBe(token);
  } finally {
    await stopOwnedChild(owned, true, 100);
    leases.close();
    rmSync(root, { recursive: true, force: true });
  }
});
