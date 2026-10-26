require('esbuild').buildSync({
  entryPoints: ['preload.js'], outfile: 'generated/preload.cjs', bundle: true,
  platform: 'browser', format: 'cjs', external: ['electron'], target: 'chrome156', legalComments: 'none'
});
