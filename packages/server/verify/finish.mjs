/**
 * End a verify script cleanly.
 *
 * `process.exit()` tears the process down immediately, while fetch's
 * keep-alive sockets may still be closing. On Windows that intermittently
 * aborts inside libuv —
 *
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c
 *
 * — with exit code 0xC0000409, *after* every check has already passed. It
 * reproduced on roughly a third of runs, which is exactly the kind of flake
 * that teaches people to ignore a red suite.
 *
 * So: set `exitCode` and let Node drain. Undici holds its keep-alive sockets
 * open for a few seconds afterwards, which would otherwise stall the suite,
 * so a short unref'd timer closes the process once the checks are done.
 *
 * It exits QUIETLY. An earlier version warned every time it fired, which it
 * did on every clean run of any script that talked to two hosts — a warning
 * printed on success is a warning nobody reads.
 */
export function finish(failures, label) {
  console.log(failures === 0 ? `${label} OK` : `${failures} check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;

  // Unref'd, so it never keeps the process alive by itself: if Node can exit
  // sooner on its own, it does and this never fires.
  const drain = setTimeout(() => process.exit(process.exitCode ?? 0), 1500);
  drain.unref();
}
