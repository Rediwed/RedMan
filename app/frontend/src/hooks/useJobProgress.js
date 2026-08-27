import { useState, useEffect, useRef, useCallback } from 'react';
import { isTerminalRunStatus } from '../utils/runStatus.js';

/**
 * Hook for tracking live progress of running backup jobs.
 * Polls a lightweight progress endpoint for active runs.
 *
 * @param {Function} fetchRunProgress - API function that takes (runId) and returns status with liveProgress
 * @param {Function} onCompleted - Called when a tracked run completes (for refreshing page data)
 * @returns {{ trackRun, detectRunning, getProgressForConfig, hasActive }}
 */
export default function useJobProgress(fetchRunProgress, onCompleted) {
  const [activeRuns, setActiveRuns] = useState({});
  const activeRunsRef = useRef({});
  const onCompletedRef = useRef(onCompleted);

  // Keep refs in sync without causing re-renders
  useEffect(() => { activeRunsRef.current = activeRuns; }, [activeRuns]);
  useEffect(() => { onCompletedRef.current = onCompleted; }, [onCompleted]);

  // Track a newly-triggered run
  const trackRun = useCallback((runId, configId, initialProgress = {}) => {
    setActiveRuns(prev => ({
      ...prev,
      [String(runId)]: { ...initialProgress, configId, status: 'running' },
    }));
  }, []);

  // Detect already-running jobs from initial page load data
  const detectRunning = useCallback((runs) => {
    setActiveRuns(prev => {
      const next = { ...prev };
      for (const run of runs) {
        if (!['running', 'cancelling'].includes(run.status)) continue;
        const runId = String(run.id);
        next[runId] = {
          ...next[runId],
          configId: run.config_id,
          status: run.status,
          ...(run.dry_run !== undefined ? { dryRun: !!run.dry_run } : {}),
        };
      }
      return next;
    });
  }, []);

  // Only re-create the polling interval when the SET of tracked IDs changes
  const runIdsKey = Object.keys(activeRuns).sort().join(',');

  useEffect(() => {
    if (!runIdsKey) return;

    let stopped = false;
    let timer = null;
    let pollCount = 0;
    let inFlight = false;

    const scheduleNext = () => {
      if (stopped || document.visibilityState === 'hidden') return;
      const delay = pollCount < 15 ? 2000 : 5000;
      timer = setTimeout(poll, delay);
    };

    const poll = async () => {
      if (stopped || inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      const ids = Object.keys(activeRunsRef.current);
      const results = await Promise.all(ids.map(async runId => {
        try {
          return { runId, detail: await fetchRunProgress(parseInt(runId)) };
        } catch {
          return { runId, detail: null };
        }
      }));
      inFlight = false;
      if (stopped) return;

      const terminalIds = new Set();
      for (const { runId, detail } of results) {
        if (detail && isTerminalRunStatus(detail.status)) terminalIds.add(runId);
      }

      setActiveRuns(prev => {
        const next = { ...prev };
        for (const { runId, detail } of results) {
          if (terminalIds.has(runId)) delete next[runId];
          else if (detail?.liveProgress && next[runId]) {
            next[runId] = { ...next[runId], ...detail.liveProgress };
          }
        }
        activeRunsRef.current = next;
        return next;
      });

      if (terminalIds.size > 0) onCompletedRef.current?.();
      pollCount++;
      if (ids.some(runId => !terminalIds.has(runId))) scheduleNext();
    };

    const handleVisibility = () => {
      clearTimeout(timer);
      if (document.visibilityState === 'visible') {
        pollCount = 0;
        poll();
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [runIdsKey, fetchRunProgress]);

  // Get progress for a specific config/job ID
  const getProgressForConfig = useCallback((configId) => {
    for (const progress of Object.values(activeRuns)) {
      if (String(progress.configId) === String(configId)) return progress;
    }
    return null;
  }, [activeRuns]);

  // Get the runId for a specific config/job ID (for cancel)
  const getRunIdForConfig = useCallback((configId) => {
    for (const [runId, progress] of Object.entries(activeRuns)) {
      if (String(progress.configId) === String(configId)) return parseInt(runId);
    }
    return null;
  }, [activeRuns]);

  return {
    activeRuns,
    trackRun,
    detectRunning,
    getProgressForConfig,
    getRunIdForConfig,
    hasActive: !!runIdsKey,
  };
}
