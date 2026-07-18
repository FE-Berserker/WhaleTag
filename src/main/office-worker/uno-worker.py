#!/usr/bin/env python3
"""
uno-worker.py — Whale Office->PDF persistent UNO bridge.

Long-running Python process spawned by the Node host
(src/main/office-worker/office-worker-host.ts). On boot it launches a
LibreOffice `soffice` listener with an INDEPENDENT user profile (so it never
contends with Whale's fallback execFile path — which uses the default profile
— or any user-launched LO), connects to it via the UNO bridge, caches a
Desktop, then converts documents on demand:

    stdin  (one JSON object per line):
        {"reqId": "...", "srcPath": "...", "outPdfPath": "..."}
    stdout (one JSON object per line):
        {"kind": "ready", "listenerPid": <int>}            # once, at boot
        {"kind": "fatal", "reason": "no-uno" | "no-listener"}
        {"kind": "log", "level": "...", "message": "..."}  # diagnostics
        {"reqId": "...", "ok": true}                       # per request
        {"reqId": "...", "ok": false, "error": {...}}      # per request

The PDF is written directly to `outPdfPath` via `storeToURL` — it does NOT
round-trip through stdout (PDFs are MBs to tens-of-MBs; base64 over JSON
would inflate 33% and force a full in-memory buffer).

Why a Python bridge at all: Node.js has no native UNO client (2026).
LibreOffice ships `pythonuno` with its bundled python, which is the only
cross-platform way to drive a persistent listener. See docs/17-office-worker.md.

UNO gotchas baked into this file (each cost real debugging time):
  * `--accept` does NOT support port=0 (silently fails to accept) -> we
    pre-bind a free port in Python and pass the literal.
  * `UnoUrlResolver.resolve` blocks indefinitely if the listener isn't up
    -> retry loop (~6s).
  * The `--accept` value and the resolve connect-string have DIFFERENT
    trailing segments (`;urp;` vs `;urp;StarOffice.ComponentContext`).
  * `PropertyValue` has no kwargs constructor -> set `.Name`/`.Value`.
  * `loadComponentFromURL` needs `(Hidden, True)` even under --headless.
  * `doc.close(False)` is mandatory — without it, document handles leak and
    the listener OOMs after ~100 docs.
  * `storeToURL` (not `store` — `store` writes back to the SOURCE url).
  * All paths go through `uno.systemPathToFileUrl()` (hand-built file:///
    breaks on Windows backslashes + spaces).
"""

import sys
import json
import socket
import subprocess
import signal
import atexit
import time
import traceback
import argparse


# ---------------------------------------------------------------------------
# stdout protocol — every line is one JSON object. `flush=True` is mandatory;
# without it stdout block-buffers over a pipe and the Node host never sees
# `ready` (it then hits its 10s ready-timeout). The host also launches us with
# `python -u` as a belt-and-braces unbuffered guarantee.
# ---------------------------------------------------------------------------

def emit(msg):
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(level, message):
    emit({"kind": "log", "level": level, "message": message})


# ---------------------------------------------------------------------------
# Module-level UNO state. Populated by boot(); one context + one Desktop for
# the whole worker lifetime. UNO loadComponentFromURL is not concurrency-safe,
# so the Node host serializes requests via sofficeSemaphore regardless.
# ---------------------------------------------------------------------------

_ctx = None
_desktop = None
_listener_proc = None


def make_prop(name, value):
    """PropertyValue has NO kwargs constructor — assign fields separately."""
    from com.sun.star.beans import PropertyValue
    p = PropertyValue()
    p.Name = name
    p.Value = value
    return p


def filter_for_doc(doc):
    """Pick the PDF export filter by document service. `writer_pdf_Export` is
    a safe default — LO dispatches PDF export by content for unknown types."""
    try:
        if doc.supportsService("com.sun.star.sheet.SpreadsheetDocument"):
            return "calc_pdf_Export"
        if doc.supportsService("com.sun.star.presentation.PresentationDocument"):
            return "impress_pdf_Export"
        if doc.supportsService("com.sun.star.drawing.DrawingDocument"):
            return "draw_pdf_Export"
    except Exception:
        pass
    return "writer_pdf_Export"


def pick_free_port():
    """LO `--accept` does not support port=0, so pre-bind to discover a free
    port, then close and hand the literal to soffice. There is a tiny TOCTOU
    race (port could be grabbed between close and soffice bind) — boot()
    retries the whole sequence to tolerate it."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("localhost", 0))
        return s.getsockname()[1]
    finally:
        s.close()


def boot_listener(soffice_path, profile_dir, port):
    """Launch the persistent soffice listener with an INDEPENDENT user
    profile (`-env:UserInstallation`) so it can't contend with Whale's
    fallback execFile runs (default profile) or a user-launched LO."""
    import uno
    accept = "socket,host=localhost,port={0};urp;".format(port)
    profile_url = uno.systemPathToFileUrl(profile_dir)
    args = [
        soffice_path,
        "--headless",
        "--norestore",
        "--nologo",
        "--nofirststartwizard",
        "--accept=" + accept,
        "-env:UserInstallation=" + profile_url,
    ]
    return subprocess.Popen(
        args,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def resolve_context(local_ctx, port):
    """Connect to the listener. `UnoUrlResolver.resolve` BLOCKS INDEFINITELY
    if the listener isn't accepting yet, so retry for ~6s (30 x 200ms). We
    catch broadly (`Exception`) because the connection-not-ready failure type
    varies across pyuno builds; a genuine fatal error still surfaces after the
    retry budget as `last_err`. Note the connect-string's trailing
    `StarOffice.ComponentContext` — the `--accept` arg has NO such suffix."""
    resolver = local_ctx.ServiceManager.createInstanceWithContext(
        "com.sun.star.bridge.UnoUrlResolver", local_ctx
    )
    connect = (
        "uno:socket,host=localhost,port={0};urp;StarOffice.ComponentContext"
    ).format(port)
    last_err = None
    for _ in range(30):
        try:
            return resolver.resolve(connect)
        except Exception as e:  # NoConnectException varies by build
            last_err = e
            time.sleep(0.2)
    raise RuntimeError("listener never accepted: {0}".format(last_err))


def boot(soffice_path, profile_dir):
    """Full boot: import uno -> spawn listener -> resolve context -> Desktop.
    Returns the listener Popen (so main can report/kill it). Sets the
    module-level `_listener_proc` BEFORE resolve so a resolve failure still
    gets cleaned up by teardown_listener()."""
    global _ctx, _desktop, _listener_proc
    import uno
    local_ctx = uno.getComponentContext()
    port = pick_free_port()
    proc = boot_listener(soffice_path, profile_dir, port)
    _listener_proc = proc
    ctx = resolve_context(local_ctx, port)
    desktop = ctx.ServiceManager.createInstanceWithContext(
        "com.sun.star.frame.Desktop", ctx
    )
    _ctx = ctx
    _desktop = desktop
    return proc


def teardown_listener():
    """Graceful listener shutdown. Wired to atexit + SIGTERM/SIGINT. SIGKILL
    can't be caught, so the Node host ALSO defensively kills listenerPid
    (and on Windows uses `taskkill /t /f` to cascade)."""
    global _listener_proc
    proc = _listener_proc
    _listener_proc = None
    if proc is None:
        return
    if proc.poll() is None:
        try:
            proc.terminate()
        except Exception:
            pass
        try:
            proc.wait(timeout=2)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass


def convert(src_path, out_pdf_path):
    """Load -> export PDF -> close. `doc.close(False)` in finally is mandatory
    (handle leak -> listener OOM after ~100 docs)."""
    import uno
    desktop = _desktop
    if desktop is None:
        raise RuntimeError("worker not booted")
    src_url = uno.systemPathToFileUrl(src_path)
    out_url = uno.systemPathToFileUrl(out_pdf_path)
    doc = desktop.loadComponentFromURL(
        src_url, "_blank", 0, (make_prop("Hidden", True),)
    )
    try:
        doc.storeToURL(
            out_url, (make_prop("FilterName", filter_for_doc(doc)),)
        )
    finally:
        try:
            doc.close(False)
        except Exception:
            pass


def handle_request(req):
    req_id = req.get("reqId")
    try:
        convert(req["srcPath"], req["outPdfPath"])
        emit({"reqId": req_id, "ok": True})
    except Exception as e:
        emit({
            "reqId": req_id,
            "ok": False,
            "error": {
                "name": type(e).__name__,
                "message": str(e),
                "stack": traceback.format_exc(),
            },
        })


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--soffice", required=True)
    parser.add_argument("--profile-dir", required=True)
    args = parser.parse_args()

    # Install teardown BEFORE boot so a boot failure still reaps a
    # half-spawned listener. SIGTERM/SIGINT fire on POSIX when the host
    # sends a graceful kill; on Windows the host uses taskkill /t instead.
    def _on_signal(_signum, _frame):
        teardown_listener()
        sys.exit(0)

    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)
    atexit.register(teardown_listener)

    # Deferred uno import — emit a clean fatal if pythonuno is missing (some
    # Linux distros package `libreoffice-script-provider-python` / `python3-uno`
    # separately) WITHOUT first paying for a listener boot.
    try:
        import uno  # noqa: F401
    except Exception as e:
        emit({"kind": "fatal", "reason": "no-uno", "message": str(e)})
        sys.exit(0)

    # Retry the whole boot 3x with a fresh port each attempt — covers the
    # pick_free_port TOCTOU race and transient listener flakiness.
    proc = None
    last_err = None
    for attempt in range(3):
        try:
            proc = boot(args.soffice, args.profile_dir)
            break
        except Exception as e:
            last_err = e
            teardown_listener()
            log("warn", "boot attempt {0} failed: {1}".format(attempt + 1, e))
    if proc is None:
        emit({
            "kind": "fatal",
            "reason": "no-listener",
            "message": str(last_err),
        })
        sys.exit(0)

    emit({"kind": "ready", "listenerPid": proc.pid})

    # stdin loop — one JSON request per line. EOF / KeyboardInterrupt ->
    # clean exit (atexit reaps the listener).
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            log("warn", "ignoring malformed stdin line: {0}".format(e))
            continue
        handle_request(req)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        teardown_listener()
        sys.exit(0)
