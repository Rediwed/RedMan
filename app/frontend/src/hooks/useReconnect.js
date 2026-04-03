import { useEffect } from 'react';

const EVENT_NAME = 'redman:reconnected';

export function dispatchReconnect() {
  window.dispatchEvent(new Event(EVENT_NAME));
}

export default function useReconnect(callback) {
  useEffect(() => {
    window.addEventListener(EVENT_NAME, callback);
    return () => window.removeEventListener(EVENT_NAME, callback);
  }, [callback]);
}
