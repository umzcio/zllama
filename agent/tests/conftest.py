"""Test-wide isolation from the host's real state, network, and clock.

`converge()` writes two files on a real host: the advisory lock
(`/var/lock/zllama-agent.converge`) and the failure-backoff memory
(`/var/lib/zllama-agent/backoff.json`). Neither belongs to a test run — and
the backoff file in particular is *read back* on the next cycle, so one test
leaving an entry behind would silently change what a later test observes
(and, on a developer machine that actually runs the agent, would corrupt the
real host's state).

`isolate_agent_state` redirects both to a per-test temporary directory for
every test in this suite. A test that cares about the exact path still
monkeypatches it itself; the later `setattr` simply wins.

`no_real_network_or_sleep` closes the other two doors. The executors'
post-condition check makes a real HTTP request and sleeps between retries, so
without this a test that forgot to mock either would quietly probe whatever
is listening on the developer's own machine and burn the retry window doing
it. Any test that wants a *successful* probe patches `urlopen` itself; the
default is "nothing is listening", which is both safe and the honest default
for a machine with no runtime installed.
"""

import urllib.error
import urllib.request

import pytest

import zllama_agent.converge as converge_module
import zllama_agent.executors as executors_module


@pytest.fixture(autouse=True)
def isolate_agent_state(tmp_path, monkeypatch):
    monkeypatch.setattr(converge_module, "LOCK_PATH", str(tmp_path / "converge.lock"))
    monkeypatch.setattr(
        converge_module, "BACKOFF_STATE_PATH", str(tmp_path / "backoff.json")
    )


@pytest.fixture(autouse=True)
def no_real_network_or_sleep(monkeypatch):
    def refuse(*_args, **_kwargs):
        raise urllib.error.URLError("network access is blocked in tests")

    monkeypatch.setattr(urllib.request, "urlopen", refuse)
    monkeypatch.setattr(executors_module.time, "sleep", lambda _seconds: None)
    # The post-condition probe honours OLLAMA_HOST; a developer's own export
    # must not change what these tests assert.
    monkeypatch.delenv("OLLAMA_HOST", raising=False)
