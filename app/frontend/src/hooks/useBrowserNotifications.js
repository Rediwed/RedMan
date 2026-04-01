import { useEffect, useRef } from 'react';

/**
 * Hook that connects to the backend SSE notification stream
 * and shows browser Notification popups for each event.
 * Reconnects automatically on disconnect.
 */
export default function useBrowserNotifications() {
  const esRef = useRef(null);

  useEffect(() => {
    // Only run if browser supports notifications and permission is granted
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    let reconnectTimer = null;

    function connect() {
      const es = new EventSource('/api/settings/notifications/stream');
      esRef.current = es;

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.title) {
            new Notification(data.title, {
              body: data.body || '',
              icon: '/favicon.ico',
              tag: data.type || 'redman',
            });
          }
        } catch { /* ignore malformed events */ }
      };

      es.onerror = () => {
        es.close();
        // Reconnect after 5s
        reconnectTimer = setTimeout(connect, 5000);
      };
    }

    connect();

    return () => {
      if (esRef.current) esRef.current.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, []);
}
