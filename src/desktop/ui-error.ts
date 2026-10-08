/** Tauri rejects Rust Result::Err as a string; React feedback expects an Error. */
export function desktopError(cause: unknown): Error {
  if (cause instanceof Error) return cause;
  return new Error(
    typeof cause === 'string' && cause.trim() ? cause : '后台操作失败，请检查服务状态和日志',
  );
}
