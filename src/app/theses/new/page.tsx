'use client';

import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { TopBar, TopBarButton } from '@/components/layout/top-bar';
import { ThesisForm } from '@/components/theses/thesis-form';
import type { ThesisFormData } from '@/components/theses/thesis-form';

export default function NewThesisPage() {
  const router = useRouter();

  const handleCreate = async (data: ThesisFormData) => {
    const res = await fetch('/api/theses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const body = (await res.json()) as { error?: string };
      throw new Error(body.error ?? 'Failed to create thesis');
    }
    const { thesis } = (await res.json()) as { thesis: { id: number } };
    router.push(`/theses/${thesis.id}`);
  };

  return (
    <main className="px-4 pt-3 pb-6">
      <TopBar>
        <TopBarButton onClick={() => router.back()}>
          <ArrowLeft className="h-4 w-4" />
          <span className="hidden sm:inline">Back</span>
        </TopBarButton>
        <span className="text-foreground mr-1 px-2 text-sm font-semibold">New Thesis</span>
      </TopBar>
      <div className="mx-auto max-w-2xl py-6">
        <ThesisForm
          onSubmit={handleCreate}
          onCancel={() => router.back()}
          submitLabel="Create thesis"
        />
      </div>
    </main>
  );
}
