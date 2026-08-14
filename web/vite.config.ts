import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const backend = process.env.AGENT_SERVER_PORT ?? '4001'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rolldownOptions: {
      output: {
        // An entries-aware group names each chunk after every route sharing it, which produces
        // 100+ character filenames. Trim to the group prefix and let the hash disambiguate.
        chunkFileNames: (chunk) => `assets/${(chunk.name ?? 'chunk').slice(0, 24)}-[hash].js`,
        codeSplitting: {
          groups: [
            // React and the router are needed before anything renders, so they get their own
            // long-lived chunks rather than riding along with app code that changes every commit.
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 30 },
            { name: 'router', test: /node_modules[\\/]react-router/, priority: 30 },
            // antd is ~70% of the bundle. `entriesAware` splits it by which routes actually pull
            // each part in, so the Table/Form/DatePicker machinery only a couple of pages use
            // lands beside those pages instead of in everyone's first load. The merge threshold
            // folds the resulting slivers back together so this doesn't become 30 tiny requests.
            {
              name: 'antd',
              test: /node_modules[\\/](antd|@ant-design|rc-[^\\/]+|@rc-component)[\\/]/,
              priority: 20,
              entriesAware: true,
              entriesAwareMergeThreshold: 40 * 1024,
            },
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
