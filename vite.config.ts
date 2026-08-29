import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/',
  // SPA fallback per React Router — tutte le rotte tornano a index.html
  // Vercel gestisce questo automaticamente con vercel.json rewrites
  build: {
    chunkSizeWarningLimit: 500,
    // Enable source map for production debugging
    sourcemap: false,
    // Minification target for modern browsers
    target: 'es2020',
    // CSS code splitting
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        /**
         * Split only external vendor packages.
         *
         * App-local modules are intentionally left to Rollup's dependency graph.
         * Previous manual chunks for ai-core/audio/education/data-layer created
         * cross-chunk cycles (ai-core -> audio/education -> ai-core) and caused
         * runtime TDZ/blank-screen failures even when TypeScript and Vite builds
         * succeeded. Letting Rollup co-locate application modules removes that
         * artificial cycle without changing prompts, agent configuration, or the
         * orchestrator implementation.
         */
        manualChunks(id) {
          // Three.js — heavy 3D library, loaded only by carousel
          if (id.includes('node_modules/three')) return 'three';
          // React core
          if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/')) return 'react-vendor';
          // Router
          if (id.includes('node_modules/react-router')) return 'router';
          // Supabase
          if (id.includes('node_modules/@supabase')) return 'supabase';
          // PDF/DOCX/XLSX parsing libs
          if (id.includes('node_modules/mammoth') || id.includes('node_modules/pdf-parse') || id.includes('node_modules/xlsx')) return 'file-parsers';
          // GSAP animation
          if (id.includes('node_modules/gsap')) return 'gsap';
        },
      },
    },
  },
  // Optimize dependency pre-bundling
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-router-dom'],
  },
})
