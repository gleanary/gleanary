import Link from 'next/link';

export default function ArticleNotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--reader-bg)]">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-[rgb(var(--reader-text))]">Article not found</h1>
        <p className="mt-2 text-[rgb(var(--reader-text))]/60">
          This article may have been deleted or doesn&apos;t exist.
        </p>
        <Link
          href="/"
          className="mt-6 inline-block text-sm text-[rgb(var(--reader-text))]/60 underline underline-offset-2 hover:text-[rgb(var(--reader-text))]"
        >
          Back to inbox
        </Link>
      </div>
    </div>
  );
}
