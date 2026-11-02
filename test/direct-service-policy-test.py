"""A working link recovers immediately; repeated failed opens remain bounded."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('direct_service', Path(__file__).resolve().parents[1] / 'scripts/direct-service.py')
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)


class ReconnectPolicyTest(unittest.TestCase):
    def test_short_failure_burst_cannot_reconnect_forever_without_backoff(self):
        failures, delays = 0, []
        for _ in range(12):
            delay, failures = service.reconnect_delay(0, failures)
            delays.append(delay)
        self.assertEqual(delays[:4], [0, 0, 0, 2])
        self.assertEqual(delays[-4:], [30, 30, 30, 30])

    def test_minute_disconnects_do_not_accumulate_outage_delays(self):
        failures = 7
        for _ in range(20):
            delay, failures = service.reconnect_delay(57000, failures)
            self.assertEqual((delay, failures), (0, 0))
        _, failures = service.reconnect_delay(200, failures)
        self.assertEqual(failures, 1)

    def test_only_private_service_gets_bounded_bootstrap(self):
        self.assertFalse(service.bootstrap_due('spp', 20, 1000, 0))
        self.assertFalse(service.bootstrap_due('private-spp', 2, 1000, 0))
        self.assertFalse(service.bootstrap_due('private-spp', 3, 299, 0))
        self.assertTrue(service.bootstrap_due('private-spp', 3, 300, 0))
        self.assertFalse(service.bootstrap_due('private-spp', 4, 599, 300))


if __name__ == '__main__':
    unittest.main()
