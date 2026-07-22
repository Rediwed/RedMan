export async function terminateChildProcesses(processes, timeoutMs = 10000) {
  const children = [...new Set(processes)].filter(Boolean);
  if (children.length === 0) return { terminated: 0, forced: 0 };

  const waits = children.map(child => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode) {
      resolve();
      return;
    }
    child.once('close', resolve);
    child.once('error', resolve);
  }));

  for (const child of children) {
    if (child.exitCode === null && !child.signalCode) {
      try { child.kill('SIGTERM'); } catch { /* already exited */ }
    }
  }

  let timedOut = false;
  await Promise.race([
    Promise.allSettled(waits),
    new Promise(resolve => { setTimeout(() => { timedOut = true; resolve(); }, timeoutMs); }),
  ]);

  let forced = 0;
  if (timedOut) {
    for (const child of children) {
      if (child.exitCode === null && !child.signalCode) {
        try { child.kill('SIGKILL'); forced++; } catch { /* already exited */ }
      }
    }
    await Promise.race([
      Promise.allSettled(waits),
      new Promise(resolve => { setTimeout(resolve, 1000); }),
    ]);
  }
  return { terminated: children.length, forced };
}