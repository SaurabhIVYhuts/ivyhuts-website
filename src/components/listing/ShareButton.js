import React, { useState } from "react";
import { Share2, Check } from "lucide-react";

// Native share sheet where available (mobile browsers, most desktop
// browsers over HTTPS); falls back to copying the link to the clipboard
// with a brief "Link copied!" confirmation everywhere else.
export default function ShareButton({ url, title, text, className = "" }) {
  const [copied, setCopied] = useState(false);

  const handleClick = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const shareUrl = url || (typeof window !== "undefined" ? window.location.href : "");

    if (navigator.share) {
      try {
        await navigator.share({ title, text, url: shareUrl });
      } catch (_) {
        // AbortError from the user dismissing the native share sheet — not an error
      }
      return;
    }

    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch (_) {}
  };

  return (
    <span className="share-btn-wrap">
      <button
        type="button"
        className={`share-btn ${className}`.trim()}
        onClick={handleClick}
        aria-label="Share this property"
      >
        {copied ? <Check size={18} /> : <Share2 size={17} />}
      </button>
      {copied && <span className="share-btn-tooltip">Link copied!</span>}
    </span>
  );
}
