/**
 * Static application configuration derived from environment variables.
 * Infrastructure-level values only — feature settings (API keys, voices, speeds)
 * are managed via getConfig() from @/lib/settings.
 */
export const config = {
  database: {
    url: process.env.DATABASE_URL ?? 'file:./data/gleanary.db',
  },
  logging: {
    level: process.env.LOG_LEVEL ?? 'info',
    betterStackToken: process.env.BETTERSTACK_SOURCE_TOKEN,
  },
  tts: {
    /** Whether TTS is enabled (has API key or mock mode) */
    enabled: !!process.env.INWORLD_API_KEY || process.env.MOCK_TTS === 'true',
    /** Use mock TTS (silent audio with timestamps) for development */
    mock: process.env.MOCK_TTS === 'true',
    /** TTS model identifier */
    model: process.env.INWORLD_TTS_MODEL ?? 'inworld-tts-1.5-max',
    /** Audio encoding format */
    audioEncoding: 'MP3' as const,
    /** Audio sample rate in Hz */
    sampleRate: 24000,
    /** File-system cache settings */
    cache: {
      enabled: process.env.TTS_CACHE_ENABLED !== 'false',
      dir: process.env.TTS_CACHE_DIR ?? '/data/tts-cache',
      maxSizeBytes:
        (parseInt(process.env.TTS_CACHE_MAX_SIZE_MB ?? '5120', 10) || 5120) * 1024 * 1024,
    },
  },
  app: {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port: parseInt(process.env.PORT ?? '3000', 10),
  },
} as const;
