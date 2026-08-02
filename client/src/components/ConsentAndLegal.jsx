import React, { useState } from 'react';
import { Cookie, Scale } from 'lucide-react';
import { getConsent, setConsent } from '../services/api';
import { Modal } from './ui';

/**
 * Storage-consent banner (GDPR-style): the app stores the login session and
 * UI preferences in this browser, and watch data on the operator's server.
 * "Essential only" keeps everything tab-scoped (no auto-login next visit).
 */
export function ConsentBanner() {
  const [visible, setVisible] = useState(() => getConsent() === null);
  if (!visible) return null;

  const choose = (mode) => {
    setConsent(mode);
    setVisible(false);
  };

  return (
    <div className="consent-banner" role="dialog" aria-label="Storage consent">
      <div className="consent-text">
        <strong><Cookie size={15} style={{ verticalAlign: -3 }} /> Storage &amp; cookies</strong>
        <span>
          We keep your login session and preferences in this browser (so you're signed in next
          time), and your watch history, pipeline and favorites on the server that hosts this app.
          No trackers, no ads, nothing shared with third parties. Read the legal notice after signing in.
        </span>
      </div>
      <div className="consent-actions">
        <button className="btn btn-dark btn-sm" onClick={() => choose('denied')}>Essential only</button>
        <button className="btn btn-primary btn-sm" onClick={() => choose('granted')}>Accept &amp; stay signed in</button>
      </div>
    </div>
  );
}

const LEGAL_VERSION = 'v1';
const LEGAL_KEY = `sb_legal_${LEGAL_VERSION}`;

/**
 * First-run legal notice: content responsibility sits with each user; the
 * operator ships no content and no pirate indexes.
 */
export function LegalNotice() {
  const [visible, setVisible] = useState(() => !localStorage.getItem(LEGAL_KEY));
  if (!visible) return null;

  const accept = () => {
    localStorage.setItem(LEGAL_KEY, String(Date.now()));
    setVisible(false);
  };

  return (
    <Modal
      title={<><Scale size={18} style={{ verticalAlign: -3 }} /> Content responsibility</>}
      subtitle="Please read — one time, before you start streaming"
      onClose={accept}
    >
      <div className="legal-text">
        <p><strong>1. No content is provided.</strong> This software ships with no media and no links
        to copyrighted catalogs. Built-in browsing uses the Internet Archive's public-domain and
        openly licensed collections only.</p>
        <p><strong>2. You are responsible for what you add.</strong> Any magnet link or torrent file
        you add to your pipeline is fetched and played back solely at your initiative. You must only
        add content you own, have a license for, or are otherwise legally entitled to access in your
        country (Kenya's Copyright Act and your local laws apply).</p>
        <p><strong>3. Operator liability.</strong> The operator and authors of this software act as a
        neutral storage/transmission tool and accept no liability for content users choose to retrieve,
        store, or view through it. Misuse may expose you, not the operator, to civil or criminal liability.</p>
        <p><strong>4. Your data stays on this server.</strong> History, watch progress, pipeline items,
        favorites, and tickets are stored on the operator's machine (disk), tied to your login ticket.
        Chunks of streamed files are buffered temporarily on server disk and deleted automatically
        as you watch.</p>
      </div>
      <div className="modal-actions">
        <button className="btn btn-primary" onClick={accept}>I understand</button>
      </div>
    </Modal>
  );
}
