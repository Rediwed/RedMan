export const MAX_CAPTURED_OUTPUT_BYTES = 64 * 1024;

export function appendOutputTail(current, value, maxBytes = MAX_CAPTURED_OUTPUT_BYTES) {
  const combined = Buffer.from(`${current}${value}`);
  if (combined.length <= maxBytes) return combined.toString();
  return combined.subarray(combined.length - maxBytes).toString();
}

export function cleanRsyncLine(line) {
  return line
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .trim();
}

export function parseItemizeAction(flags) {
  if (!flags || flags.length < 2) return 'unknown';
  const type = flags[0];
  const kind = flags[1];
  if (type === '>' || type === '<') {
    if (flags.includes('+++++++')) return 'created';
    return 'transferred';
  }
  if (type === 'c' && kind === 'd') return 'directory';
  if (type === '.') return 'unchanged';
  return 'updated';
}

export function parseProgressLine(line, progress) {
  const match = line.match(/^\s*([\d,.]+[kKmMgGtT]?)\s+(\d+)%\s+([\d.]+\w+\/s)\s+(\S+)\s+\(xfe?r#(\d+),\s*(to-check|to-chk|ir-chk)=(\d+)\/(\d+)\)/);
  if (match) {
    progress.speed = match[3];
    const count = Number.parseInt(match[7], 10);
    const total = Number.parseInt(match[8], 10);
    if (total > 0) {
      const nextPercent = match[6] === 'to-check'
        ? Math.round((count / total) * 100)
        : Math.round(((total - count) / total) * 100);
      if (progress.percent === null || nextPercent > progress.percent) progress.percent = nextPercent;
    }
    return true;
  }

  const simple = line.match(/^\s*[\d,.]+[kKmMgGtT]?\s+\d+%\s+([\d.]+\w+\/s)/);
  if (!simple) return false;
  progress.speed = simple[1];
  return true;
}

export function parseProgress2Line(line, progress) {
  const match = line.match(/^\s*([\d,.]+[kKmMgGtT]?)\s+(\d+)%\s+([\d.]+\w+\/s)\s+(\S+)/);
  if (!match) return false;

  const bytesTransferred = parseRsyncByteCount(match[1]);
  if (bytesTransferred === null) return false;
  const percent = Number.parseInt(match[2], 10);
  if (percent < 0 || percent > 100) return false;
  if (bytesTransferred > progress.bytesTransferred) progress.bytesTransferred = bytesTransferred;
  progress.speed = match[3];
  progress.eta = match[4] === '0:00:00' ? null : match[4];
  if (progress.percent === null || percent > progress.percent) progress.percent = percent;

  const fileCounts = line.match(/\(xfr#(\d+),\s*(?:to-chk|ir-chk)=(\d+)\/(\d+)\)\s*$/);
  if (fileCounts) {
    progress.filesCopied = Number.parseInt(fileCounts[1], 10);
    progress.filesRemaining = Number.parseInt(fileCounts[2], 10);
    progress.filesTotal = Number.parseInt(fileCounts[3], 10);
  }
  return true;
}

function looksLikeProgress2Line(line) {
  return /^\s*\S+\s+\d+%\s+\S+\/s\s+\S+/.test(line);
}

export function parseRsyncByteCount(value) {
  const match = String(value).match(/^((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)([kKmMgGtT]?)$/);
  if (!match) return null;
  const normalized = match[1].replace(/,/g, '');
  const multipliers = { '': 1, k: 1_000, m: 1_000_000, g: 1_000_000_000, t: 1_000_000_000_000 };
  const result = Math.round(Number.parseFloat(normalized) * multipliers[match[2].toLowerCase()]);
  return Number.isSafeInteger(result) ? result : null;
}

export function createRsyncOutputProcessor({
  progress = {
    filesTotal: 0,
    filesCopied: 0,
    filesFailed: 0,
    bytesTransferred: 0,
    currentFile: null,
    speed: null,
    percent: null,
    filesRemaining: null,
    eta: null,
  },
  platform = process.platform,
  onFileEntry = null,
  onProgress = null,
} = {}) {
  let stdout = '';
  let stderr = '';
  let stdoutRemainder = '';
  let stderrRemainder = '';

  const processStdoutLine = (rawLine) => {
    const line = cleanRsyncLine(rawLine);
    if (!line) return;

    const itemized = line.match(/^([<>.ch*][fdLDS][cstpoguax.+? ]{7,9})\s+(\d+)\s+(.+)$/);
    if (itemized) {
      const entry = {
        path: itemized[3],
        action: parseItemizeAction(itemized[1]),
        size: Number.parseInt(itemized[2], 10) || 0,
      };
      onFileEntry?.(entry);
      progress.filesTotal++;
      progress.currentFile = entry.path;
      if (entry.action === 'transferred' || entry.action === 'created') {
        progress.filesCopied++;
        progress.bytesTransferred += entry.size;
      }
      onProgress?.(progress);
      return;
    }

    const deletion = line.match(/^\*deleting\s+(?:(\d+)\s+)?(.+)$/);
    if (deletion) {
      onFileEntry?.({
        path: deletion[2],
        action: 'deleted',
        size: deletion[1] ? Number.parseInt(deletion[1], 10) : 0,
      });
      progress.filesTotal++;
      onProgress?.(progress);
      return;
    }

    let parsedProgress;
    if (platform !== 'darwin' && looksLikeProgress2Line(line)) {
      parsedProgress = parseProgress2Line(line, progress);
    } else {
      parsedProgress = parseProgressLine(line, progress);
    }
    if (parsedProgress) {
      onProgress?.(progress);
      return;
    }

    const bytes = line.match(/Total transferred file size:\s+([\d,]+)/);
    if (bytes) {
      const total = Number.parseInt(bytes[1].replace(/,/g, ''), 10);
      if (total > progress.bytesTransferred) progress.bytesTransferred = total;
      onProgress?.(progress);
    }
  };

  const processStderrLine = (rawLine) => {
    const line = cleanRsyncLine(rawLine);
    if (line.startsWith('rsync:') && !line.startsWith('rsync error:')) {
      progress.filesFailed++;
      onProgress?.(progress);
    }
  };

  const writeChunk = (currentRemainder, value, processLine) => {
    const lines = `${currentRemainder}${value}`.split(/[\r\n]+/);
    const remainder = lines.pop() || '';
    for (const line of lines) processLine(line);
    return appendOutputTail('', remainder);
  };

  return {
    progress,
    writeStdout(value) {
      const text = value.toString();
      stdout = appendOutputTail(stdout, text);
      stdoutRemainder = writeChunk(stdoutRemainder, text, processStdoutLine);
    },
    writeStderr(value) {
      const text = value.toString();
      stderr = appendOutputTail(stderr, text);
      stderrRemainder = writeChunk(stderrRemainder, text, processStderrLine);
    },
    flush() {
      if (stdoutRemainder) processStdoutLine(stdoutRemainder);
      if (stderrRemainder) processStderrLine(stderrRemainder);
      stdoutRemainder = '';
      stderrRemainder = '';
    },
    output() {
      return { stdout, stderr, progress };
    },
  };
}