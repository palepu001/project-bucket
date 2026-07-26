const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const outdir = path.join(__dirname, 'build');
fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(outdir, { recursive: true });

esbuild
  .build({
    entryPoints: [path.join(__dirname, 'src', 'index.tsx'), path.join(__dirname, 'src', 'styles.css')],
    bundle: true,
    minify: true,
    sourcemap: false,
    outdir,
    target: ['chrome100', 'firefox100', 'safari15'],
    loader: { '.svg': 'text' },
  })
  .then(() => {
    fs.copyFileSync(path.join(__dirname, 'public', 'index.html'), path.join(outdir, 'index.html'));
    // Served as a same-origin static file (not bundled) so pdfjs can load its worker
    // via a plain relative URL — Forge's CSP does not permit blob: in worker-src/script-src.
    fs.copyFileSync(
      path.join(__dirname, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs'),
      path.join(outdir, 'pdf.worker.min.mjs')
    );
    console.log('[project-bucket-panel] build complete');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
