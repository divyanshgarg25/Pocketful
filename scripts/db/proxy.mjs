// Tiny reverse proxy: supabase-js talks to <url>/rest/v1/*, PostgREST serves at /.
import http from 'node:http';
const listen = Number(process.env.PROXY_PORT ?? 54321);
const target = Number(process.env.PGRST_PORT ?? 3000);
http.createServer((req, res) => {
  const url = (req.url ?? '/').replace(/^\/rest\/v1/, '') || '/';
  const up = http.request({ host: '127.0.0.1', port: target, path: url, method: req.method, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on('error', () => { res.statusCode = 502; res.end('upstream down'); });
  req.pipe(up);
}).listen(listen, '127.0.0.1', () => console.log(`proxy :${listen} -> :${target}`));
