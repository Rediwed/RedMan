import Docker from 'dockerode';

export function createDockerClient(endpoint) {
  const target = String(endpoint || '').trim();
  if (target.startsWith('http://') || target.startsWith('https://') || target.startsWith('tcp://')) {
    const normalized = target.startsWith('tcp://') ? `http://${target.slice(6)}` : target;
    const parsed = new URL(normalized);
    if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
      throw new Error('Docker proxy endpoint must be a credential-free origin URL');
    }
    return new Docker({
      host: `${parsed.protocol}//${parsed.hostname}`,
      port: Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 2375)),
    });
  }
  throw new Error('Docker endpoint must be an HTTP proxy origin');
}

export async function executeDockerControlAction(readClient, controlClient, containerId, action) {
  if (!['start', 'stop', 'restart'].includes(action)) {
    throw new Error(`Action '${action}' not allowed. Allowed: start, stop, restart`);
  }

  const controlContainer = controlClient.getContainer(containerId);
  if (action === 'restart') {
    const matches = await readClient.listContainers({
      all: true,
      filters: { id: [containerId] },
    });
    if (matches[0]?.State === 'running') await controlContainer.stop();
    await controlContainer.start();
  } else {
    await controlContainer[action]();
  }

  return { success: true, action, containerId };
}