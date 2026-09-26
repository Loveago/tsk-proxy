import app from '../src/app.js';

export default function handler(req, res) {
  const urlString = req.url || '';
  if (urlString.includes('__path=')) {
    try {
      const urlObj = new URL(urlString, 'http://localhost');
      const originalPath = urlObj.searchParams.get('__path');
      if (originalPath) {
        urlObj.searchParams.delete('__path');
        const remainingQuery = urlObj.searchParams.toString();
        req.url = (originalPath.startsWith('/') ? originalPath : `/${originalPath}`) + (remainingQuery ? `?${remainingQuery}` : '');
      }
    } catch {}
  } else if (req.headers['x-matched-path'] && !req.headers['x-matched-path'].includes('/api/index')) {
    req.url = req.headers['x-matched-path'];
  }

  return app(req, res);
}
