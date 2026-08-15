import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const backend = process.env.AGENT_SERVER_PORT ?? '4001'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // The antd chunk is ~1 MB uncompressed (~320 KB gzip) and can't be split further -- see the
    // note below -- so the default 500 kB warning fires on every build for a size we've accepted.
    // Raised to just above it, not switched off, so a chunk that genuinely grows still says so.
    chunkSizeWarningLimit: 1200,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // React and the router are needed before anything renders, so they get their own
            // long-lived chunks rather than riding along with app code that changes every commit.
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 30 },
            { name: 'router', test: /node_modules[\\/]react-router/, priority: 30 },
            // antd is ~70% of the bundle, and splitting it by route (`entriesAware`) is tempting.
            // Don't: it partitions antd into chunks that import each other *circularly*, and antd
            // has module-level initialization that can't survive an ESM cycle -- `modal/locale`
            // does `{...enUS.Modal}` at the top level, which runs before the chunk holding `en_US`
            // is evaluated and throws "Cannot read properties of undefined (reading 'Modal')".
            // That kills the whole render, so the console serves a blank page in production while
            // `npm run web:dev` (no chunking) looks fine. One antd chunk, cached across deploys.
            { name: 'antd', test: /node_modules[\\/](antd|@ant-design|rc-[^\\/]+|@rc-component)[\\/]/, priority: 20 },
            { name: 'vendor', test: /node_modules/, priority: 10 },
          ],
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': `http://localhost:${backend}`,
      '/ws': {
        target: `ws://localhost:${backend}`,
        ws: true,
      },
    },
  },
})
