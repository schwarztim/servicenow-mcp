import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Execute a file securely without shell injection risk.
 * Uses execFile instead of exec to prevent command injection.
 *
 * @param command - Command to execute
 * @param args - Arguments array
 * @param options - Execution options (timeout, cwd, etc.)
 * @returns Promise with stdout, stderr, and exit code
 */
export async function execFileNoThrow(
  command: string,
  args: string[] = [],
  options: { timeout?: number; cwd?: string } = {},
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: options.timeout || 10000,
      cwd: options.cwd,
      encoding: "utf-8",
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error: any) {
    return {
      stdout: error.stdout || "",
      stderr: error.stderr || error.message || "",
      exitCode: error.code || 1,
    };
  }
}
