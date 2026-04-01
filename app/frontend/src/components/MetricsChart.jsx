import { useRef, useEffect } from 'react';
import './MetricsChart.css';

export default function MetricsChart({ data, dataKey, label, color, maxValue, unit = '%' }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!canvasRef.current || !data || data.length === 0) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    canvas.width = canvas.offsetWidth * dpr;
    canvas.height = canvas.offsetHeight * dpr;
    ctx.scale(dpr, dpr);

    const w = canvas.offsetWidth;
    const h = canvas.offsetHeight;
    const padding = { top: 8, right: 8, bottom: 20, left: 40 };
    const plotW = w - padding.left - padding.right;
    const plotH = h - padding.top - padding.bottom;

    // Clear
    ctx.clearRect(0, 0, w, h);

    // Determine max
    const max = maxValue || Math.max(...data.map(d => d[dataKey]), 1) * 1.1;

    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padding.top + (plotH * i) / 4;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(w - padding.right, y);
      ctx.stroke();

      // Y-axis labels
      const val = max - (max * i) / 4;
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.font = '10px system-ui';
      ctx.textAlign = 'right';
      ctx.fillText(formatValue(val, unit), padding.left - 4, y + 3);
    }

    // Plot line
    if (data.length < 2) return;

    ctx.beginPath();
    ctx.strokeStyle = color || 'var(--color-primary)';
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';

    for (let i = 0; i < data.length; i++) {
      const x = padding.left + (i / (data.length - 1)) * plotW;
      const y = padding.top + plotH - (data[i][dataKey] / max) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Fill area under line
    ctx.lineTo(padding.left + plotW, padding.top + plotH);
    ctx.lineTo(padding.left, padding.top + plotH);
    ctx.closePath();
    ctx.fillStyle = (color || '#4f8ff7') + '15';
    ctx.fill();

    // Time labels (first and last)
    if (data.length > 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.font = '10px system-ui';
      ctx.textAlign = 'left';
      const first = new Date(data[0].recorded_at);
      ctx.fillText(formatTime(first), padding.left, h - 2);
      ctx.textAlign = 'right';
      const last = new Date(data[data.length - 1].recorded_at);
      ctx.fillText(formatTime(last), w - padding.right, h - 2);
    }
  }, [data, dataKey, color, maxValue, unit]);

  return (
    <div className="metrics-chart">
      {label && <span className="metrics-chart-label">{label}</span>}
      <canvas ref={canvasRef} className="metrics-canvas" />
    </div>
  );
}

function formatValue(val, unit) {
  if (unit === 'bytes') {
    if (val >= 1073741824) return `${(val / 1073741824).toFixed(1)}G`;
    if (val >= 1048576) return `${(val / 1048576).toFixed(0)}M`;
    if (val >= 1024) return `${(val / 1024).toFixed(0)}K`;
    return `${Math.round(val)}B`;
  }
  return `${val.toFixed(1)}${unit}`;
}

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
