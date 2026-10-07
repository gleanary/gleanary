'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'react-pdf/node_modules/pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

interface PdfViewerProps {
  articleId: number;
  pageCount: number | null;
}

/**
 * Client component for rendering a stored PDF inline using react-pdf.
 * Features: responsive width (ResizeObserver), lazy page rendering (IntersectionObserver),
 * text layer for native selection, range-request streaming from the original route.
 */
export function PdfViewer({ articleId, pageCount }: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  // Stores sentinel elements so the IntersectionObserver can re-observe them after
  // numPages is known (sentinels mount before onLoadSuccess fires when pageCount is null).
  const sentinelEls = useRef<Map<number, HTMLDivElement>>(new Map());

  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const [numPages, setNumPages] = useState<number>(pageCount ?? 0);
  const [renderedPages, setRenderedPages] = useState<Set<number>>(() => new Set([1]));
  const [loadError, setLoadError] = useState(false);

  // Hold off rendering pages until container width is measured (prevents mobile overflow)
  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setContainerWidth(Math.floor(entry.contentRect.width));
    });
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  // Lazy page rendering — re-created when numPages becomes known.
  // Re-observes already-mounted sentinels so pages 3+ work when pageCount was null on mount.
  useEffect(() => {
    if (!numPages) return;
    const obs = new IntersectionObserver(
      (entries) => {
        setRenderedPages((prev) => {
          const prevSize = prev.size;
          const next = new Set(prev);
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              const p = parseInt(entry.target.getAttribute('data-page') ?? '0', 10);
              if (p > 0) {
                for (let i = Math.max(1, p - 1); i <= Math.min(numPages, p + 1); i++) next.add(i);
              }
            }
          });
          return next.size === prevSize ? prev : next;
        });
      },
      { rootMargin: '300px' },
    );
    observerRef.current = obs;
    sentinelEls.current.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, [numPages]);

  const setSentinelRef = useCallback((el: HTMLDivElement | null, pageNum: number) => {
    if (el) {
      el.setAttribute('data-page', String(pageNum));
      sentinelEls.current.set(pageNum, el);
      observerRef.current?.observe(el);
    } else {
      sentinelEls.current.delete(pageNum);
    }
  }, []);

  const handleLoadSuccess = useCallback(({ numPages: n }: { numPages: number }) => {
    setNumPages(n);
  }, []);

  const skeletonHeight = containerWidth ? Math.round(containerWidth * 1.414) : 960;
  const totalPages = numPages || pageCount || 1;

  if (loadError) {
    return (
      <div className="rounded border border-[rgb(var(--reader-text))]/10 bg-[rgb(var(--reader-text))]/5 px-4 py-3 text-sm text-[rgb(var(--reader-text))]/60">
        Could not load PDF.{' '}
        <a
          href={`/api/articles/${articleId}/original`}
          download
          className="underline hover:text-[rgb(var(--reader-text))]/80"
        >
          Download instead
        </a>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="w-full">
      <Document
        file={`/api/articles/${articleId}/original`}
        onLoadSuccess={handleLoadSuccess}
        onLoadError={() => setLoadError(true)}
      >
        {containerWidth === null
          ? Array.from({ length: totalPages }, (_, i) => (
              <div
                key={i}
                className="mb-2 animate-pulse rounded bg-[rgb(var(--reader-text))]/8"
                style={{ height: skeletonHeight }}
              />
            ))
          : Array.from({ length: totalPages }, (_, i) => {
              const pageNum = i + 1;
              const skeleton = (
                <div
                  className="animate-pulse rounded bg-[rgb(var(--reader-text))]/8"
                  style={{ height: skeletonHeight, width: containerWidth }}
                />
              );
              return (
                <div key={pageNum} ref={(el) => setSentinelRef(el, pageNum)} className="mb-2">
                  {renderedPages.has(pageNum) ? (
                    <Page
                      pageNumber={pageNum}
                      width={containerWidth}
                      renderTextLayer
                      renderAnnotationLayer
                      loading={skeleton}
                      onRenderSuccess={
                        pageNum === 1
                          ? () => {
                              sentinelEls.current
                                .get(1)
                                ?.setAttribute('data-testid', 'pdf-page-rendered');
                            }
                          : undefined
                      }
                    />
                  ) : (
                    skeleton
                  )}
                </div>
              );
            })}
      </Document>
    </div>
  );
}
