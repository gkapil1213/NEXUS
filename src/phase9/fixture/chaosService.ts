import http from 'http';
import { URL } from 'url';

export class ChaosFixture {
  private server: http.Server | null = null;
  private mode: 'normal' | 'delay' | 'error' = 'normal';
  private delayMs: number = 2000;
  public port: number = 0;

  async start(port: number = 0): Promise<void> {
    this.port = port;
    this.server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${this.port}`);
      if (url.pathname === '/health') {
        if (this.mode === 'error') {
          res.statusCode = 503;
          res.end('Service Unavailable');
        } else if (this.mode === 'delay') {
          setTimeout(() => {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ status: 'ok', delayed: true, delayMs: this.delayMs }));
          }, this.delayMs);
        } else {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ status: 'ok' }));
        }
      } else if (url.pathname === '/api') {
        if (this.mode === 'error') {
          res.statusCode = 503;
          res.end('Service Unavailable');
        } else if (this.mode === 'delay') {
          setTimeout(() => {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ data: 'hello', delayed: true }));
          }, this.delayMs);
        } else {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ data: 'hello' }));
        }
      } else if (url.pathname === '/toggle' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const { mode, delayMs } = JSON.parse(body);
            if (['normal', 'delay', 'error'].includes(mode)) {
              this.mode = mode;
              if (delayMs !== undefined) this.delayMs = delayMs;
              res.statusCode = 200;
              res.end(JSON.stringify({ mode: this.mode, delayMs: this.delayMs }));
            } else {
              res.statusCode = 400;
              res.end('Invalid mode');
            }
          } catch {
            res.statusCode = 400;
            res.end('Invalid JSON');
          }
        });
      } else if (url.pathname === '/timeout' && req.method === 'GET') {
        // Simulate a request that never responds (until timeout)
        // We do not send any response, causing client timeout.
        // Node will automatically timeout if the client aborts, but we just keep connection open.
        // We can set a timer to never end, but that's okay for test.
        // No response is sent; the client will timeout.
      } else {
        res.statusCode = 404;
        res.end('Not found');
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, () => {
        const address = this.server!.address();
        if (address && typeof address === 'object') {
          this.port = address.port;
        }
        resolve();
      });
      this.server!.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server!.close(() => resolve());
        this.server!.on('error', reject);
      });
      this.server = null;
    }
  }

  getMode(): string {
    return this.mode;
  }

  getDelayMs(): number {
    return this.delayMs;
  }
}
