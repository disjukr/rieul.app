#!/usr/bin/env python3
import importlib.util
import io
from pathlib import Path
import subprocess
import unittest

spec = importlib.util.spec_from_file_location("stapler_retry", Path(__file__).with_name("stapler-retry.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def network(action="validate"):
    return ('error is Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost." '
            f'UserInfo={{NSErrorFailingURLStringKey={m.TICKET_URL}, NSLocalizedDescription=The network connection was lost.}}\n'
            f'The {"staple and validate" if action == "staple" else action} action failed! Error 68.\n')


class RetryTests(unittest.TestCase):
    def invoke(self, results, action="validate"):
        calls, sleeps, log = [], [], io.StringIO()
        def execute(command, **kwargs):
            calls.append(command)
            self.assertEqual(command, ["/usr/bin/xcrun", "stapler", action, str(Path("candidate.app").absolute())])
            self.assertEqual(kwargs["timeout"], 120)
            self.assertEqual(kwargs["env"]["LC_ALL"], "C")
            result = results[len(calls) - 1]
            if isinstance(result, Exception):
                raise result
            return subprocess.CompletedProcess(command, result[0], stdout=result[1])
        code = m.run(action, "candidate.app", execute=execute, sleep=sleeps.append, output=log)
        return code, calls, sleeps, log.getvalue()

    def test_transient_then_success_for_both_actions_preserves_diagnostics(self):
        for action in ("staple", "validate"):
            code, calls, sleeps, log = self.invoke([(68, network(action)), (0, "valid ticket\n")], action)
            self.assertEqual((code, len(calls), sleeps), (0, 2, [5]))
            self.assertIn(network(action), log)
            self.assertIn("valid ticket", log)

    def test_exhaustion_preserves_nonzero_and_all_attempts(self):
        code, calls, sleeps, log = self.invoke([(68, network())] * 3)
        self.assertEqual((code, len(calls), sleeps), (68, 3, [5, 15]))
        self.assertEqual(log.count("The validate action failed!"), 3)

    def test_semantic_unknown_and_untrusted_transport_fail_without_retry(self):
        for code, diagnostic in [
            (65, "The ticket is invalid"), (68, "The validate action failed! Error 68."),
            (68, network() + "Invalid ticket signature\n"),
            (68, network().replace("api.apple-cloudkit.com", "example.com")),
            (68, network().replace("Code=-1005", "Code=-1202")),
            (68, network().replace(m.TICKET_URL, m.TICKET_URL + ".evil")),
            (69, network()), (68, network("staple")),
        ]:
            result, calls, sleeps, _ = self.invoke([(code, diagnostic)])
            self.assertEqual((result, len(calls), sleeps), (code, 1, []))

    def test_transport_error_followed_by_invalid_ticket_stops(self):
        code, calls, sleeps, log = self.invoke([(68, network()), (65, "Invalid ticket")])
        self.assertEqual((code, len(calls), sleeps), (65, 2, [5]))
        self.assertIn("Invalid ticket", log)

    def test_timeout_is_bounded_and_not_assumed_retryable(self):
        code, calls, sleeps, log = self.invoke([subprocess.TimeoutExpired("stapler", 120, output=b"partial diagnostic")])
        self.assertEqual((code, len(calls), sleeps), (124, 1, []))
        self.assertIn("partial diagnostic", log)

    def test_success_without_retry(self):
        code, calls, sleeps, _ = self.invoke([(0, "valid ticket")])
        self.assertEqual((code, len(calls), sleeps), (0, 1, []))


if __name__ == "__main__":
    unittest.main()
