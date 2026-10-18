"use client";

import { useEffect, useMemo, useState } from "react";
import { Sheet } from "@/components/ui/sheet";
import { cardFileName, renderCard, type ShareCard } from "@/lib/share-card";

/**
 * Shows a PnL card as an image with the ways to post it: the system share sheet (phones), download, copy the image,
 * copy the link. Nothing is uploaded anywhere; the image is drawn in this browser.
 */
export function ShareSheet({ card, title, text, link, onClose }: { card: ShareCard; title: string; text: string; link: string; onClose: () => void }) {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const name = useMemo(() => cardFileName(card), [card]);

  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    setBlob(null);
    setUrl(null);
    setError(null);
    renderCard(card)
      .then((b) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(b);
        setBlob(b);
        setUrl(objectUrl);
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : "Could not draw the card"));
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [card]);

  const file = useMemo(() => (blob ? new File([blob], name, { type: "image/png" }) : null), [blob, name]);
  const canShare = !!file && typeof navigator !== "undefined" && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });
  const canCopyImage = typeof window !== "undefined" && typeof ClipboardItem !== "undefined" && !!navigator.clipboard?.write;

  const flash = (what: string) => {
    setDone(what);
    setTimeout(() => setDone(null), 1_800);
  };

  const share = async () => {
    if (!file) return;
    try {
      await navigator.share({ files: [file], title, text: `${text} ${link}` });
    } catch {
      // Dismissed, or the target refused the file: nothing to report.
    }
  };
  const copyImage = async () => {
    if (!blob) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      flash("image");
    } catch {
      setError("This browser would not copy the image; download it instead.");
    }
  };
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(link);
      flash("link");
    } catch {
      setError("Could not copy the link.");
    }
  };

  return (
    <Sheet
      title={title}
      description="Drawn in this browser from on-chain figures; nothing is uploaded."
      onClose={onClose}
      wide
      testId="share-sheet"
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => void copyLink()} data-testid="share-copy-link">
            {done === "link" ? "Link copied" : "Copy link"}
          </button>
          {canCopyImage ? (
            <button type="button" className="btn btn-sm" disabled={!blob} onClick={() => void copyImage()}>
              {done === "image" ? "Image copied" : "Copy image"}
            </button>
          ) : null}
          {url ? (
            <a className="btn btn-sm" href={url} download={name} data-testid="share-download">
              Download
            </a>
          ) : null}
          {canShare ? (
            <button type="button" className="btn btn-sm btn-primary" onClick={() => void share()} data-testid="share-native">
              Share
            </button>
          ) : null}
        </div>
      }
    >
      <div className="overflow-hidden rounded-md border border-line bg-bg" style={{ aspectRatio: "16 / 9" }}>
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={`${title}: ${text}`} className="block h-full w-full" data-testid="share-image" />
        ) : (
          <div className="flex h-full items-center justify-center gap-2 text-muted" role="status">
            {error ? <span className="text-short">{error}</span> : <><span className="spinner" aria-hidden="true" /> Drawing</>}
          </div>
        )}
      </div>
      {error && url ? <p className="mt-2 text-xs text-short">{error}</p> : null}
    </Sheet>
  );
}
