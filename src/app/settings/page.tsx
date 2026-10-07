import { Suspense } from 'react';
import { SettingsPage } from '@/components/settings/settings-page';
import { TopBar } from '@/components/layout/top-bar';

export default function Settings() {
  return (
    <main className="px-4 pt-3 pb-6">
      <TopBar>
        <span className="text-foreground mr-1 px-2 text-sm font-semibold">Settings</span>
      </TopBar>
      <div className="mx-auto max-w-4xl py-6">
        <Suspense
          fallback={
            <div className="text-muted-foreground py-8 text-center">Loading settings...</div>
          }
        >
          <SettingsPage />
        </Suspense>
      </div>
    </main>
  );
}
