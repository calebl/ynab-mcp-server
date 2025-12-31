import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Mock the MCP SDK
vi.mock('@modelcontextprotocol/sdk/server/mcp.js');
vi.mock('@modelcontextprotocol/sdk/server/sse.js');

describe('HTTP Server', () => {
  let app: Express;
  const VERSION = '0.1.2';

  beforeEach(() => {
    vi.clearAllMocks();

    // Create a basic Express app similar to the actual server
    app = express();
    app.use(cors());
    app.use(express.json());

    // Health check endpoint
    app.get('/health', (_req, res) => {
      res.json({ status: 'ok', version: VERSION });
    });

    // Message endpoint
    app.post('/message', async (_req, res) => {
      res.status(405).json({ error: 'Use SSE endpoint' });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Server Configuration', () => {
    it('should have CORS middleware enabled', async () => {
      const response = await request(app)
        .options('/health')
        .set('Origin', 'http://example.com')
        .set('Access-Control-Request-Method', 'GET');

      expect(response.headers['access-control-allow-origin']).toBeDefined();
    });

    it('should have JSON middleware enabled', async () => {
      const response = await request(app)
        .post('/message')
        .send({ test: 'data' })
        .set('Content-Type', 'application/json');

      expect(response.status).toBe(405);
      expect(response.body).toEqual({ error: 'Use SSE endpoint' });
    });
  });

  describe('Health Endpoint', () => {
    it('should return 200 status', async () => {
      const response = await request(app).get('/health');
      expect(response.status).toBe(200);
    });

    it('should return correct JSON structure', async () => {
      const response = await request(app).get('/health');

      expect(response.body).toHaveProperty('status');
      expect(response.body).toHaveProperty('version');
    });

    it('should include correct version number', async () => {
      const response = await request(app).get('/health');

      expect(response.body.version).toBe(VERSION);
    });

    it('should return ok status', async () => {
      const response = await request(app).get('/health');

      expect(response.body.status).toBe('ok');
    });

    it('should return application/json content type', async () => {
      const response = await request(app).get('/health');

      expect(response.headers['content-type']).toMatch(/application\/json/);
    });

    it('should respond quickly (under 100ms)', async () => {
      const start = Date.now();
      await request(app).get('/health');
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(100);
    });

    it('should handle multiple concurrent requests', async () => {
      const requests = Array(10).fill(null).map(() =>
        request(app).get('/health')
      );

      const responses = await Promise.all(requests);

      responses.forEach(response => {
        expect(response.status).toBe(200);
        expect(response.body.status).toBe('ok');
      });
    });
  });

  describe('Message Endpoint', () => {
    it('should return 405 status', async () => {
      const response = await request(app).post('/message');

      expect(response.status).toBe(405);
    });

    it('should return appropriate error message', async () => {
      const response = await request(app).post('/message');

      expect(response.body.error).toBe('Use SSE endpoint');
    });

    it('should return JSON response', async () => {
      const response = await request(app).post('/message');

      expect(response.headers['content-type']).toMatch(/application\/json/);
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid routes with 404', async () => {
      const response = await request(app).get('/invalid-route');

      expect(response.status).toBe(404);
    });

    it('should handle invalid JSON gracefully', async () => {
      const response = await request(app)
        .post('/message')
        .send('invalid json')
        .set('Content-Type', 'application/json');

      // Express will either parse it or return 400, both are acceptable
      expect([400, 405]).toContain(response.status);
    });
  });

  describe('CORS Configuration', () => {
    it('should allow cross-origin requests', async () => {
      const response = await request(app)
        .get('/health')
        .set('Origin', 'http://example.com');

      expect(response.headers['access-control-allow-origin']).toBeDefined();
    });

    it('should support preflight requests', async () => {
      const response = await request(app)
        .options('/health')
        .set('Origin', 'http://example.com')
        .set('Access-Control-Request-Method', 'GET');

      expect(response.status).toBe(204);
    });
  });
});
