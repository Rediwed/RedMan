import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Hook for tracking live progress of running backup jobs.
 * Polls a run detail endpoint every 2s for active runs.
 *
 * @param {Function} fetchRunDetail - API function that takes (runId) and returns run detail with liveProgress
 * @param {Function} onCompleted - Called when a tracked run completes (for refreshing page data)
 * @returns {{ trackRun, detectRunning, getProgressForConfig, hasActive }}
 */
export default function useJobProgress(fetchRunDetail, onCompleted) {
  const [activeRuns, setActiveRuns] = useState({});
  const activeRunsRef = useRef({});
  const onCompletedRef = useRef(onCompleted);

  // Keep refs in sync without causing re-renders
  useEffect(() => { activeRunsRef.current = activeRuns; }, [activeRuns]);
  useEffect(() => { onCompletedRef.current = onCompleted; }, [onCompleted]);

  // Track a newly-triggered run
  const trackRun = useCallback((runId, configId) => {
    setActiveRuns(prev => ({ ...prev, [String(runId)]: { configId, status: 'running' } }));
  }, []);

  // Detect already-running jobs from initial page load data
  const detectRunning = useCallback((runs) => {
    const running = {};
    for (const run of runs) {
      if (run.status === 'running') {
        running[String(run.id)] = { configId: run.config_id, status: 'running' };
      }
    }
    if (Object.keys(running).length > 0) {
      setActiveRuns(prev => ({ ...prev, ...running }));
    }
  }, []);

  // Only re-create the polling interval when the SET of tracked IDs changes
  const runIdsKey = Object.keys(activeRuns).sort().join(',');

  useEffect(() => {
    if (!runIdsKey) return;

    const poll = async () => {
      const ids = Object.keys(activeRunsRef.current);
      for (const runId of ids) {
        try {
          const detail = await fetchRunDetail(parseInt(runId));
          if (detail.status === 'completed' || detail.status === 'failed') {
            setActiveRuns(prev => {
              const next = { ...prev };
              delete next[runId];
              return next;
            });
            onCompletedRef.current?.();
          } else if (detail.liveProgress) {
            setActiveRuns(prev => ({
              ...prev,
              [runId]: { ...prev[runId], ...detail.liveProgress },
            }));
          }
        } catch { /* silent — will retry next poll */ }
      }
    };

    poll(); // Initial fetch
    const interval = setInterval(poll, 1000);
    return () => clearInterval(interval);
  }, [runIdsKey, fetchRunDetail]);

  // Get progress for a specific config/job ID
  const getProgressForConfig = useCallback((configId) => {
    for (const progress of Object.values(activeRuns)) {
      if (String(progress.configId) === String(configId)) return progress;
    }
    return null;
  }, [activeRuns]);

  return {
    activeRuns,
    trackRun,
    detectRunning,
    getProgressForConfig,
    hasActive: !!runIdsKey,
  };
}
