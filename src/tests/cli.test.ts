import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';

describe('CLI Arguments', () => {
  let program: Command;
  const VERSION = '0.1.2';

  beforeEach(() => {
    program = new Command();
    program
      .name('ynab-mcp-server')
      .description('YNAB MCP Server - provides AI tools for interacting with YNAB budgets')
      .version(VERSION);

    program
      .option('--http', 'Run as HTTP server with SSE transport')
      .option('-p, --port <port>', 'Port for HTTP server', '3000');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Mode Selection', () => {
    it('should default to stdio mode when no arguments provided', () => {
      program.parse(['node', 'index.js']);
      const options = program.opts();

      expect(options.http).toBeUndefined();
    });

    it('should enable HTTP mode with --http flag', () => {
      program.parse(['node', 'index.js', '--http']);
      const options = program.opts();

      expect(options.http).toBe(true);
    });

    it('should parse multiple arguments together', () => {
      program.parse(['node', 'index.js', '--http', '--port', '8080']);
      const options = program.opts();

      expect(options.http).toBe(true);
      expect(options.port).toBe('8080');
    });

    it('should handle stdio mode without explicit flag', () => {
      program.parse(['node', 'index.js']);
      const options = program.opts();

      expect(options.http).toBeFalsy();
    });
  });

  describe('Port Configuration', () => {
    it('should set custom port with --port flag', () => {
      program.parse(['node', 'index.js', '--http', '--port', '8080']);
      const options = program.opts();

      expect(options.port).toBe('8080');
    });

    it('should set custom port with -p short flag', () => {
      program.parse(['node', 'index.js', '--http', '-p', '8080']);
      const options = program.opts();

      expect(options.port).toBe('8080');
    });

    it('should default to port 3000 in HTTP mode', () => {
      program.parse(['node', 'index.js', '--http']);
      const options = program.opts();

      expect(options.port).toBe('3000');
    });

    it('should accept valid port numbers', () => {
      const validPorts = ['80', '443', '3000', '8080', '65535'];

      validPorts.forEach(port => {
        const testProgram = new Command();
        testProgram
          .name('ynab-mcp-server')
          .version(VERSION)
          .option('--http', 'Run as HTTP server')
          .option('-p, --port <port>', 'Port for HTTP server', '3000');

        testProgram.parse(['node', 'index.js', '--http', '--port', port]);
        const options = testProgram.opts();

        expect(options.port).toBe(port);
      });
    });

    it('should handle low port numbers', () => {
      program.parse(['node', 'index.js', '--http', '--port', '80']);
      const options = program.opts();

      expect(options.port).toBe('80');
    });

    it('should handle high port numbers', () => {
      program.parse(['node', 'index.js', '--http', '--port', '65535']);
      const options = program.opts();

      expect(options.port).toBe('65535');
    });

    it('should parse port as string (requires conversion to number)', () => {
      program.parse(['node', 'index.js', '--http', '--port', '8080']);
      const options = program.opts();

      expect(typeof options.port).toBe('string');
      expect(parseInt(options.port)).toBe(8080);
    });
  });

  describe('Version and Help', () => {
    it('should have correct version', () => {
      expect(program.version()).toBe(VERSION);
    });

    it('should have correct name', () => {
      expect(program.name()).toBe('ynab-mcp-server');
    });

    it('should have description', () => {
      const description = program.description();
      expect(description).toContain('YNAB');
      expect(description).toContain('MCP');
    });

    it('should register --http option', () => {
      const httpOption = program.options.find(opt => opt.long === '--http');
      expect(httpOption).toBeDefined();
      expect(httpOption?.description).toContain('HTTP');
    });

    it('should register --port option', () => {
      const portOption = program.options.find(opt => opt.long === '--port');
      expect(portOption).toBeDefined();
      expect(portOption?.description).toContain('Port');
    });

    it('should have -p as short flag for port', () => {
      const portOption = program.options.find(opt => opt.short === '-p');
      expect(portOption).toBeDefined();
      expect(portOption?.long).toBe('--port');
    });
  });

  describe('Argument Combinations', () => {
    it('should handle only port flag without http flag', () => {
      program.parse(['node', 'index.js', '--port', '8080']);
      const options = program.opts();

      expect(options.http).toBeUndefined();
      expect(options.port).toBe('8080');
    });

    it('should handle flags in different order', () => {
      program.parse(['node', 'index.js', '--port', '8080', '--http']);
      const options = program.opts();

      expect(options.http).toBe(true);
      expect(options.port).toBe('8080');
    });

    it('should handle short and long flags together', () => {
      program.parse(['node', 'index.js', '--http', '-p', '9000']);
      const options = program.opts();

      expect(options.http).toBe(true);
      expect(options.port).toBe('9000');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty port value gracefully', () => {
      // Commander will use default value if port is not provided
      program.parse(['node', 'index.js', '--http']);
      const options = program.opts();

      expect(options.port).toBe('3000');
    });

    it('should parse arguments correctly with equals sign', () => {
      program.parse(['node', 'index.js', '--http', '--port=8080']);
      const options = program.opts();

      expect(options.port).toBe('8080');
    });

    it('should handle no arguments', () => {
      program.parse(['node', 'index.js']);
      const options = program.opts();

      expect(options.http).toBeUndefined();
      expect(options.port).toBe('3000'); // default value
    });
  });
});
