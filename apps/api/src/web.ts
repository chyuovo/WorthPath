import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Express, static as serveStatic } from 'express';

/** Serve only the current Vite assets and page entries; leave service routes to Nest/OAuth. */
export function installWeb(app: Express, directory = join(__dirname, '../public')) {
  const index = join(directory, 'index.html');
  if (!existsSync(index)) return false;

  app.use('/assets', serveStatic(join(directory, 'assets'), { index: false, redirect: false }));
  const pages = new Set(['/', '/agent/authorize', '/agent/operation']);
  app.use((req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method) || !pages.has(req.path)) return next();
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(index, (error) => {
      if (error) next(error);
    });
  });
  return true;
}
