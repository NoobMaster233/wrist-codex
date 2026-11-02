"""Select the single focused Android window; ignore inactive displays."""
import subprocess
import time


def focused_window(status):
    windows = {line.strip() for line in status.splitlines()
               if 'mCurrentFocus=Window{' in line}
    # Multiple active windows are ambiguous: leave UI automation stopped.
    return next(iter(windows)) if len(windows) == 1 else ''


def read_focused_window():
    # HyperOS briefly reports no window while opening/closing an overlay.
    # Retry that empty state only. A known foreign window still stops input.
    deadline = time.monotonic() + 1.5
    while True:
        status = subprocess.check_output(['adb','shell','dumpsys','window'], text=True, timeout=10)
        window = focused_window(status)
        if window or time.monotonic() >= deadline:
            return window
        time.sleep(.1)
