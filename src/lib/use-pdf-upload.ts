'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { uploadPdf } from '@/lib/article-api';
import { validatePdfUpload } from '@/lib/upload-validation';

/**
 * Shared hook for PDF file upload — validates, uploads, and redirects.
 * Used by PdfDropZone (home page) and PdfModal (sidebar).
 * @param onSuccess - Called immediately before navigation on a successful upload
 * Returns handleFile (stable via useCallback), isPending, error, and setError.
 */
export function useHandlePdfUpload(onSuccess?: () => void) {
  const router = useRouter();
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = useCallback(
    async (file: File) => {
      const err = validatePdfUpload(file);
      if (err) {
        setError(err);
        return;
      }
      setIsPending(true);
      setError(null);
      let result: Awaited<ReturnType<typeof uploadPdf>>;
      try {
        result = await uploadPdf(file);
      } catch {
        setError('Upload failed.');
        setIsPending(false);
        return;
      }
      setIsPending(false);
      if (result.duplicate && result.existingId) {
        onSuccess?.();
        router.push(`/reader/${result.existingId}`);
        return;
      }
      if (!result.ok) {
        setError(result.error ?? 'Upload failed.');
        return;
      }
      onSuccess?.();
      router.push(`/reader/${result.article!.id}`);
    },
    [router, onSuccess],
  );

  return { handleFile, isPending, error, setError };
}
