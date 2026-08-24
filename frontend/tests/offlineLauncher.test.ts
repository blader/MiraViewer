import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('offline launcher storage origin', () => {
  it('reuses its exact origin across restarts and refuses an occupied durable port', () => {
    const program = [
      'import contextlib, errno, importlib.util, io, json, pathlib',
      'source = pathlib.Path("distribution/run_miraviewer.py").resolve()',
      'spec = importlib.util.spec_from_file_location("miraviewer_launcher", source)',
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'bindings = []',
      'urls = []',
      'class FakeServer:',
      '  def __init__(self, address, handler): bindings.append(address)',
      '  def serve_forever(self): pass',
      '  def server_close(self): pass',
      'module.http.server.ThreadingHTTPServer = FakeServer',
      'module.webbrowser.open = lambda url, new=2: urls.append(url)',
      'output = io.StringIO()',
      'with contextlib.redirect_stdout(output):',
      '  first = module.main()',
      '  second = module.main()',
      'def occupied(*args): raise OSError(errno.EADDRINUSE, "occupied")',
      'module.http.server.ThreadingHTTPServer = occupied',
      'conflict_output = io.StringIO()',
      'with contextlib.redirect_stdout(conflict_output): conflict = module.main()',
      'def forbidden(*args): raise OSError(errno.EPERM, "restricted")',
      'module.http.server.ThreadingHTTPServer = forbidden',
      'permission_output = io.StringIO()',
      'with contextlib.redirect_stdout(permission_output): permission = module.main()',
      'print(json.dumps({"bindings": bindings, "urls": urls, "exitCodes": [first, second], "conflictExitCode": conflict, "conflictMessage": conflict_output.getvalue(), "permissionExitCode": permission, "permissionMessage": permission_output.getvalue()}))',
    ].join('\n');

    const result = spawnSync('python3', ['-B', '-c', program], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout.trim()) as {
      bindings: Array<[string, number]>;
      urls: string[];
      exitCodes: number[];
      conflictExitCode: number;
      conflictMessage: string;
      permissionExitCode: number;
      permissionMessage: string;
    };
    expect(output.bindings).toEqual([
      ['127.0.0.1', 43125],
      ['127.0.0.1', 43125],
    ]);
    expect(output.urls).toEqual(['http://127.0.0.1:43125/', 'http://127.0.0.1:43125/']);
    expect(output.exitCodes).toEqual([0, 0]);
    expect(output.conflictExitCode).toBe(1);
    expect(output.conflictMessage).toMatch(/required port 43125 is already in use/i);
    expect(output.permissionExitCode).toBe(1);
    expect(output.permissionMessage).toMatch(/local network access is restricted/i);
    expect(output.permissionMessage).not.toMatch(/already in use/i);
    expect(output.urls).toHaveLength(2);
  });
});
