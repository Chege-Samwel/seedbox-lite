import React, { useState, useEffect } from 'react';
import { Play } from 'lucide-react';

// ---------- Image with graceful fallback ----------
export function PosterImage({ src, alt, className }) {
  const [failed, setFailed] = useState(!src);
  useEffect(() => { setFailed(!src); }, [src]);
  if (failed) {
    return (
      <div className={`poster-fallback ${className || ''}`}>
        <span className="glyph">🎬</span>
        <span className="t">{alt || 'No artwork'}</span>
      </div>
    );
  }
  return <img src={src} alt={alt || ''} className={className} loading="lazy" onError={() => setFailed(true)} />;
}

// ---------- Badge ----------
export function ReadyBadge({ state }) {
  if (!state) return null;
  const label = state === 'ready' ? 'Ready'
    : state === 'warming' ? 'Warming up'
    : state === 'stored' ? 'Stored'
    : state === 'sleeping' ? 'Sleeping'
    : state === 'loading' ? 'Loading'
    : 'Connecting';
  return (
    <span className={`badge-dot ${state}`}>
      <span className="pulse" />
      {label}
    </span>
  );
}

// ---------- Cards ----------
export function MediaCard({ title, subtitle, poster, wide, badge, progress, onClick }) {
  return (
    <div className={`card ${wide ? 'card-wide' : ''}`} onClick={onClick} role="button" tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onClick?.()}>
      <div className="card-poster">
        <PosterImage src={poster} alt={title} />
        <div className="card-badges">{badge}</div>
        <div className="card-play"><span className="ring"><Play size={22} fill="currentColor" /></span></div>
        {progress != null && progress > 0 && (
          <div className="progress-track"><div className="progress-fill" style={{ width: `${Math.min(progress * 100, 100)}%` }} /></div>
        )}
      </div>
      <div className="card-title">{title}</div>
      {subtitle && <div className="card-meta">{subtitle}</div>}
    </div>
  );
}

// ---------- Horizontal row ----------
export function Row({ title, hint, children }) {
  const items = React.Children.toArray(children).filter(Boolean);
  if (!items.length) return null;
  return (
    <section className="row">
      <div className="row-head">
        <h2 className="row-title">{title}</h2>
        {hint && <span className="row-hint">{hint}</span>}
      </div>
      <div className="row-scroller">{items}</div>
    </section>
  );
}

// ---------- State blocks ----------
export function Spinner({ label }) {
  return (
    <div className="center-wrap">
      <div className="spinner" />
      {label && <p>{label}</p>}
    </div>
  );
}

export function EmptyState({ emoji, title, children }) {
  return (
    <div className="empty-state">
      <div className="big">{emoji || '🍿'}</div>
      <h3>{title}</h3>
      <div>{children}</div>
    </div>
  );
}

// ---------- Modal ----------
export function Modal({ title, subtitle, onClose, children, wide }) {
  useEffect(() => {
    const h = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={wide ? { maxWidth: 720 } : undefined} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {subtitle && <p className="modal-sub">{subtitle}</p>}
        {children}
      </div>
    </div>
  );
}
