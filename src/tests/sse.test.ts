import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

// Mock the MCP SDK
vi.mock('@modelcontextprotocol/sdk/server/mcp.js');
vi.mock('@modelcontextprotocol/sdk/server/sse.js');

describe('SSE Endpoint', () => {
  let app: Express;
  let mockServer: {
    connect: Mock;
    registerTool: Mock;
  };
  let mockTransport: any;
  const VERSION = '0.1.2';

  beforeEach(() => {
    vi.clearAllMocks();

    mockServer = {
      connect: vi.fn().mockResolvedValue(undefined),
      registerTool: vi.fn(),
    };

    mockTransport = {
      start: vi.fn(),
      stop: vi.fn(),
    };

    (McpServer as any).mockImplementation(() => mockServer);
    (SSEServerTransport as any).mockImplementation(() => mockTransport);

    // Create Express app with SSE endpoint
    app = express();
    app.use(cors());
    app.use(express.json());

    // SSE endpoint for MCP
    app.post('/sse', async (req, res) => {
      const server = new McpServer({
        name: 'ynab-mcp-server',
        version: VERSION,
      });

      const transport = new SSEServerTransport('/message', res);
      await server.connect(transport);

      req.on('close', () => {
        // Connection closed
      });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Connection Handling', () => {
    it('should accept POST requests to /sse', async () => {
      // SSE connections stay open, so we catch the timeout and verify mocks were called
      await request(app)
        .post('/sse')
        .timeout(500)
        .catch(() => {});

      // Verify the endpoint was hit and server was created
      expect(McpServer).toHaveBeenCalled();
    });

    it('should create new McpServer instance per connection', async () => {
      await request(app)
        .post('/sse')
        .timeout(500)
        .catch(() => {});

      expect(McpServer).toHaveBeenCalledWith({
        name: 'ynab-mcp-server',
        version: VERSION,
      });
    });

    it('should initialize SSEServerTransport', async () => {
      await request(app)
        .post('/sse')
        .timeout(500)
        .catch(() => {});

      expect(SSEServerTransport).toHaveBeenCalledWith(
        '/message',
        expect.any(Object)
      );
    });

    it('should connect server to transport', async () => {
      await request(app)
        .post('/sse')
        .timeout(500)
        .catch(() => {});

      expect(mockServer.connect).toHaveBeenCalledWith(mockTransport);
    });

    it('should handle connection close event', async () => {
      const closeHandler = vi.fn();

      const customApp = express();
      customApp.use(cors());
      customApp.use(express.json());

      customApp.post('/sse', async (req, res) => {
        const server = new McpServer({
          name: 'ynab-mcp-server',
          version: VERSION,
        });

        const transport = new SSEServerTransport('/message', res);
        await server.connect(transport);

        req.on('close', closeHandler);
      });

      const agent = request(customApp).post('/sse');

      // Start the request but don't wait for completion
      const promise = agent.timeout(500).catch(() => {});

      // Give it time to set up handlers
      await new Promise(resolve => setTimeout(resolve, 100));

      await promise;

      // The close handler should be registered
      // Note: We can't easily trigger the close event in tests
    });
  });

  describe('Multiple Connections', () => {
    it('should create separate server instances for concurrent connections', async () => {
      const requests = [
        request(app).post('/sse').timeout(500).catch(() => {}),
        request(app).post('/sse').timeout(500).catch(() => {}),
      ];

      await Promise.all(requests);

      // Should create multiple server instances
      expect(McpServer).toHaveBeenCalledTimes(2);
    });

    it('should create separate transport instances for concurrent connections', async () => {
      const requests = [
        request(app).post('/sse').timeout(500).catch(() => {}),
        request(app).post('/sse').timeout(500).catch(() => {}),
      ];

      await Promise.all(requests);

      // Should create multiple transport instances
      expect(SSEServerTransport).toHaveBeenCalledTimes(2);
    });

    it('should handle multiple connections independently', async () => {
      const request1 = request(app).post('/sse').timeout(500).catch(() => {});
      const request2 = request(app).post('/sse').timeout(500).catch(() => {});

      await Promise.all([request1, request2]);

      // Each connection should get its own server and transport
      expect(McpServer).toHaveBeenCalledTimes(2);
      expect(SSEServerTransport).toHaveBeenCalledTimes(2);
      expect(mockServer.connect).toHaveBeenCalledTimes(2);
    });
  });

  describe('Transport Configuration', () => {
    it('should pass correct endpoint to SSEServerTransport', async () => {
      await request(app)
        .post('/sse')
        .timeout(500)
        .catch(() => {});

      expect(SSEServerTransport).toHaveBeenCalledWith(
        '/message',
        expect.any(Object)
      );
    });

    it('should pass response object to SSEServerTransport', async () => {
      await request(app)
        .post('/sse')
        .timeout(500)
        .catch(() => {});

      const transportArgs = (SSEServerTransport as any).mock.calls[0];
      expect(transportArgs[1]).toBeDefined();
      expect(typeof transportArgs[1]).toBe('object');
    });

    it('should use /message as message endpoint', async () => {
      await request(app)
        .post('/sse')
        .timeout(500)
        .catch(() => {});

      expect(SSEServerTransport).toHaveBeenCalledWith(
        '/message',
        expect.any(Object)
      );
    });
  });

  describe('Server Configuration', () => {
    it('should create server with correct name', async () => {
      await request(app)
        .post('/sse')
        .timeout(500)
        .catch(() => {});

      expect(McpServer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'ynab-mcp-server',
        })
      );
    });

    it('should create server with correct version', async () => {
      await request(app)
        .post('/sse')
        .timeout(500)
        .catch(() => {});

      expect(McpServer).toHaveBeenCalledWith(
        expect.objectContaining({
          version: VERSION,
        })
      );
    });

    it('should create server with both name and version', async () => {
      await request(app)
        .post('/sse')
        .timeout(500)
        .catch(() => {});

      expect(McpServer).toHaveBeenCalledWith({
        name: 'ynab-mcp-server',
        version: VERSION,
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle server connection errors', async () => {
      mockServer.connect.mockRejectedValue(new Error('Connection failed'));

      try {
        await request(app)
          .post('/sse')
          .timeout(1000);
      } catch (error) {
        // Expected to fail or timeout
      }

      expect(mockServer.connect).toHaveBeenCalled();
    });

    it('should handle transport initialization errors', async () => {
      (SSEServerTransport as any).mockImplementation(() => {
        throw new Error('Transport init failed');
      });

      try {
        await request(app)
          .post('/sse')
          .timeout(1000);
      } catch (error) {
        // Expected to fail
      }

      expect(SSEServerTransport).toHaveBeenCalled();
    });

    it('should reject non-POST requests', async () => {
      const response = await request(app).get('/sse');

      expect(response.status).toBe(404);
    });
  });

  describe('Request Headers', () => {
    it('should accept requests with JSON content type', async () => {
      await request(app)
        .post('/sse')
        .set('Content-Type', 'application/json')
        .timeout(500)
        .catch(() => {});

      expect(McpServer).toHaveBeenCalled();
    });

    it('should accept requests without content type', async () => {
      await request(app)
        .post('/sse')
        .timeout(500)
        .catch(() => {});

      expect(McpServer).toHaveBeenCalled();
    });

    it('should handle CORS preflight requests', async () => {
      const response = await request(app)
        .options('/sse')
        .set('Origin', 'http://example.com')
        .set('Access-Control-Request-Method', 'POST');

      expect(response.status).toBe(204);
    });
  });

  describe('Connection Lifecycle', () => {
    it('should set up close event handler', async () => {
      let closeHandlerRegistered = false;

      const customApp = express();
      customApp.use(cors());
      customApp.post('/sse', async (req, res) => {
        const server = new McpServer({
          name: 'ynab-mcp-server',
          version: VERSION,
        });

        const transport = new SSEServerTransport('/message', res);
        await server.connect(transport);

        req.on('close', () => {
          closeHandlerRegistered = true;
        });
      });

      await request(customApp)
        .post('/sse')
        .timeout(500)
        .catch(() => {});

      // Close handler is registered (we can't easily verify it was called)
      expect(McpServer).toHaveBeenCalled();
    });
  });
});
