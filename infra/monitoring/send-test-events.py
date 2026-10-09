#!/usr/bin/env python3
"""Sends fake error events to a Bugsink project, for the install checks in README.md.

Usage: send-test-events.py <dsn> [count] [threads]
"""

import json
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from collections import Counter
from urllib.parse import urlparse


def build_envelope(event_id: str, message: str) -> bytes:
    event = {
        "event_id": event_id,
        "timestamp": time.time(),
        "platform": "python",
        "level": "error",
        "message": message,
    }
    lines = [
        json.dumps({"event_id": event_id}),
        json.dumps({"type": "event"}),
        json.dumps(event),
    ]
    return "\n".join(lines).encode()


def send_events(dsn: str, count: int, threads: int) -> Counter:
    parsed = urlparse(dsn)
    url = f"{parsed.scheme}://{parsed.hostname}:{parsed.port}/api/{parsed.path.strip('/')}/envelope/"
    headers = {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": f"Sentry sentry_version=7, sentry_key={parsed.username}, sentry_client=lm-test/1.0",
    }
    run_label = time.strftime("%H:%M:%S")
    results: Counter = Counter()
    lock = threading.Lock()

    def worker(first: int, last: int) -> None:
        for number in range(first, last):
            body = build_envelope(
                uuid.uuid4().hex, f"test event {number} from run {run_label}"
            )
            request = urllib.request.Request(
                url, data=body, headers=headers, method="POST"
            )
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    status = response.status
            except urllib.error.HTTPError as error:
                status = error.code
            except urllib.error.URLError as error:
                status = f"network error: {error.reason}"
            with lock:
                results[status] += 1

    chunk = -(-count // threads)
    pool = [
        threading.Thread(target=worker, args=(i * chunk, min((i + 1) * chunk, count)))
        for i in range(threads)
    ]
    started = time.time()
    for thread in pool:
        thread.start()
    for thread in pool:
        thread.join()
    print(f"sent {count} events in {time.time() - started:.1f}s")
    return results


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    dsn = sys.argv[1]
    count = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    threads = int(sys.argv[3]) if len(sys.argv) > 3 else 4
    for status, total in sorted(send_events(dsn, count, threads).items(), key=str):
        print(f"  HTTP {status}: {total}")


if __name__ == "__main__":
    main()
