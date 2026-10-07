import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Gleanary',
    short_name: 'Gleanary',
    description: 'Personal read-it-later',
    start_url: '/',
    display: 'standalone',
    background_color: '#FAFAF7',
    theme_color: '#1A1A1A',
    icons: [
      {
        src: '/icons/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
    ],
    // share_target is not typed in Next.js MetadataRoute.Manifest but is valid
    // per the Web App Manifest spec. Android uses this to register the app as a
    // share target in the OS share sheet.
    ...({
      share_target: {
        action: '/save',
        method: 'GET',
        params: {
          title: 'title',
          text: 'text',
          url: 'url',
        },
      },
    } as Record<string, unknown>),
  };
}
