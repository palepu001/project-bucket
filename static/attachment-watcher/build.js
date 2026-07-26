const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const outdir = path.join(__dirname, 'build');
fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(outdir, { recursive: true });

esbuild
  .build({
    entryPoints: [path.join(__dirname, 'src', 'index.ts')],
    bundle: true,
    minify: true,
    sourcemap: false,
    outdir,
    target: ['chrome100', 'firefox100', 'safari15'],
  })
  .then(() => {
    fs.copyFileSync(path.join(__dirname, 'public', 'index.html'), path.join(outdir, 'index.html'));
    fs.copyFileSync(
      path.join(__dirname, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs'),
      path.join(outdir, 'pdf.worker.min.mjs')
    );
    console.log('[project-bucket-attachment-watcher] build complete');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
