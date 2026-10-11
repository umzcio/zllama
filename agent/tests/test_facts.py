"""Tests for host and runtime fact collection."""

import json
import os
import subprocess
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from zllama_agent.facts import (
    _cpu_model,
    _ollama_models,
    _ollama_unit_model_path,
    _resolve_ollama_model_path,
    _vllm_models,
    collect_host,
    collect_runtimes,
)

MEMINFO = "MemTotal:       32826584 kB\nMemAvailable:   10878464 kB\n"


def run_result(stdout="", stderr="", returncode=0):
    result = MagicMock()
    result.stdout = stdout
    result.stderr = stderr
    result.returncode = returncode
    return result


def which_only(*names):
    def which(name):
        return f"/usr/bin/{name}" if name in names else None

    return which


def test_collect_host_returns_arch_os_kernel():
    with patch("platform.machine", return_value="x86_64"), patch(
        "platform.system", return_value="Linux"
    ), patch("platform.release", return_value="6.8.0-generic"):
        host = collect_host()

    assert host["arch"] == "x86_64"
    assert host["os"] == "Linux"
    assert host["kernel"] == "6.8.0-generic"
    assert all(isinstance(host[k], str) and host[k] for k in ("arch", "os", "kernel"))


def test_collect_host_reads_cpu_count_and_ram_total():
    with patch("os.cpu_count", return_value=16), patch(
        "zllama_agent.facts._read_meminfo", return_value=MEMINFO
    ):
        host = collect_host()

    assert host["cpu_count"] == 16
    assert host["ram_total_bytes"] == 32826584 * 1024


# --- CPU model, with the lscpu fallback for aarch64 --------------------------
#
# `/proc/cpuinfo` has no `model name` line on aarch64 (DGX Spark, Cortex-X925,
# etc.) — only on x86. `lscpu` normalizes across architectures, so it's the
# fallback, tried only when `/proc/cpuinfo` didn't answer.

CPUINFO_X86 = (
    "processor\t: 0\n"
    "vendor_id\t: GenuineIntel\n"
    "model name\t: Intel(R) Xeon(R) Gold 6338 CPU @ 2.00GHz\n"
)

CPUINFO_AARCH64 = "processor\t: 0\nBogoMIPS\t: 2000.00\nFeatures\t: fp asimd\n"

LSCPU_OUTPUT = (
    "Architecture:                            aarch64\n"
    "Model name:                              Cortex-X925\n"
    "Vendor ID:                               ARM\n"
)


def test_cpu_model_uses_proc_cpuinfo_and_never_calls_lscpu():
    with patch(
        "zllama_agent.facts._read_cpuinfo", return_value=CPUINFO_X86
    ), patch("shutil.which") as which, patch("subprocess.run") as run:
        model = _cpu_model()

    assert model == "Intel(R) Xeon(R) Gold 6338 CPU @ 2.00GHz"
    which.assert_not_called()
    run.assert_not_called()


def test_cpu_model_falls_back_to_lscpu_when_proc_cpuinfo_lacks_model_name():
    with patch(
        "zllama_agent.facts._read_cpuinfo", return_value=CPUINFO_AARCH64
    ), patch("shutil.which", return_value="/usr/bin/lscpu"), patch(
        "subprocess.run", return_value=run_result(stdout=LSCPU_OUTPUT)
    ):
        model = _cpu_model()

    assert model == "Cortex-X925"


def test_cpu_model_returns_none_when_neither_source_has_it():
    with patch(
        "zllama_agent.facts._read_cpuinfo", return_value=CPUINFO_AARCH64
    ), patch("shutil.which", return_value="/usr/bin/lscpu"), patch(
        "subprocess.run", return_value=run_result(stdout="Architecture: aarch64\n")
    ):
        assert _cpu_model() is None


def test_cpu_model_returns_none_when_lscpu_binary_is_missing():
    with patch(
        "zllama_agent.facts._read_cpuinfo", return_value=CPUINFO_AARCH64
    ), patch("shutil.which", return_value=None), patch("subprocess.run") as run:
        model = _cpu_model()

    assert model is None
    run.assert_not_called()


def test_cpu_model_returns_none_when_proc_cpuinfo_is_unreadable_and_no_lscpu():
    with patch(
        "zllama_agent.facts._read_cpuinfo", side_effect=OSError("no such file")
    ), patch("shutil.which", return_value=None):
        assert _cpu_model() is None


def test_collect_runtimes_reports_ollama_with_parsed_version():
    def run(cmd, *args, **kwargs):
        if cmd[0] == "ollama":
            return run_result(stdout="ollama version is 0.32.13\n")
        return run_result(returncode=1)

    with patch("shutil.which", side_effect=which_only("ollama")), patch(
        "subprocess.run", side_effect=run
    ), patch("shutil.disk_usage", return_value=SimpleNamespace(total=100, used=40, free=60)), patch(
        "zllama_agent.facts._ollama_models", return_value=[]
    ):
        runtimes = collect_runtimes()

    ollama = [r for r in runtimes if r["kind"] == "ollama"]
    assert len(ollama) == 1
    assert ollama[0]["version"] == "0.32.13"


def test_collect_runtimes_omits_ollama_when_binary_absent():
    with patch("shutil.which", return_value=None), patch(
        "subprocess.run", return_value=run_result(returncode=1)
    ):
        runtimes = collect_runtimes()

    assert all(r["kind"] != "ollama" for r in runtimes)


def test_collect_runtimes_reports_vllm_version_verbatim():
    raw_version = "0.1.dev1+g53420169e.d20260724"

    def run(cmd, *args, **kwargs):
        if cmd[0] == "python3":
            return run_result(stdout=f"{raw_version}\n")
        return run_result(returncode=1)

    with patch("shutil.which", return_value=None), patch("subprocess.run", side_effect=run), patch(
        "shutil.disk_usage", return_value=SimpleNamespace(total=100, used=40, free=60)
    ), patch("zllama_agent.facts._vllm_models", return_value=[]):
        runtimes = collect_runtimes()

    vllm = [r for r in runtimes if r["kind"] == "vllm"]
    assert len(vllm) == 1
    assert vllm[0]["version"] == raw_version


def test_collect_runtimes_omits_models_key_for_vllm_when_the_cache_is_unreadable():
    def run(cmd, *args, **kwargs):
        if cmd[0] == "python3":
            return run_result(stdout="0.5.0\n")
        return run_result(returncode=1)

    with patch("shutil.which", return_value=None), patch("subprocess.run", side_effect=run), patch(
        "shutil.disk_usage", return_value=SimpleNamespace(total=100, used=40, free=60)
    ), patch("zllama_agent.facts._vllm_models", return_value=None):
        runtimes = collect_runtimes()

    vllm = next(r for r in runtimes if r["kind"] == "vllm")
    assert "models" not in vllm


def test_collect_runtimes_includes_an_empty_models_list_for_vllm_when_genuinely_none_installed():
    def run(cmd, *args, **kwargs):
        if cmd[0] == "python3":
            return run_result(stdout="0.5.0\n")
        return run_result(returncode=1)

    with patch("shutil.which", return_value=None), patch("subprocess.run", side_effect=run), patch(
        "shutil.disk_usage", return_value=SimpleNamespace(total=100, used=40, free=60)
    ), patch("zllama_agent.facts._vllm_models", return_value=[]):
        runtimes = collect_runtimes()

    vllm = next(r for r in runtimes if r["kind"] == "vllm")
    assert "models" in vllm
    assert vllm["models"] == []


def test_collect_runtimes_includes_disk_free_bytes():
    def run(cmd, *args, **kwargs):
        if cmd[0] == "ollama":
            return run_result(stdout="ollama version is 0.32.13\n")
        return run_result(returncode=1)

    with patch("shutil.which", side_effect=which_only("ollama")), patch(
        "subprocess.run", side_effect=run
    ), patch(
        "shutil.disk_usage", return_value=SimpleNamespace(total=500, used=200, free=300)
    ), patch("zllama_agent.facts._ollama_models", return_value=[]):
        runtimes = collect_runtimes()

    ollama = next(r for r in runtimes if r["kind"] == "ollama")
    assert ollama["disk_free_bytes"] == 300
    assert ollama["disk_total_bytes"] == 500


# --- Installed-model inventory ------------------------------------------------
#
# Every declared model is re-planned as a `pull_model` on every cycle unless
# the runtime facts carry the installed inventory, so these assert that the
# inventory is actually collected — and that a missing runtime, a wedged
# daemon, and a missing cache directory are all an empty list, never a raise.


class _FakeResponse:
    def __init__(self, body: str):
        self._body = body.encode("utf-8")

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


TAGS_BODY = json.dumps(
    {
        "models": [
            {"name": "qwen3:32b", "size": 20_000_000_000, "digest": "sha256:aaa"},
            {"name": "llama3.3:70b", "size": 42_000_000_000, "digest": "sha256:bbb"},
        ]
    }
)


def test_ollama_models_reports_name_size_and_digest_from_the_local_api():
    with patch(
        "zllama_agent.facts.urllib.request.urlopen", return_value=_FakeResponse(TAGS_BODY)
    ) as urlopen:
        models = _ollama_models()

    assert models == [
        {"name": "qwen3:32b", "size_bytes": 20_000_000_000, "digest": "sha256:aaa"},
        {"name": "llama3.3:70b", "size_bytes": 42_000_000_000, "digest": "sha256:bbb"},
    ]
    # Read-only probe against the loopback daemon, with an explicit timeout.
    assert urlopen.call_args.kwargs["timeout"] > 0


def test_ollama_models_preserves_tag_case_exactly():
    body = json.dumps({"models": [{"name": "Qwen3:32B", "size": 1, "digest": "sha256:c"}]})
    with patch("zllama_agent.facts.urllib.request.urlopen", return_value=_FakeResponse(body)):
        models = _ollama_models()

    assert models[0]["name"] == "Qwen3:32B"


def test_ollama_models_returns_none_when_the_daemon_is_not_listening():
    # A connection failure means "the probe could not be completed," not
    # "nothing is installed" — the two must never collapse to the same value,
    # or a transient daemon hiccup gets read as a real empty inventory.
    with patch(
        "zllama_agent.facts.urllib.request.urlopen", side_effect=OSError("connection refused")
    ):
        assert _ollama_models() is None


def test_ollama_models_returns_none_for_a_malformed_body():
    with patch(
        "zllama_agent.facts.urllib.request.urlopen", return_value=_FakeResponse("not json")
    ):
        assert _ollama_models() is None


def test_ollama_models_returns_none_for_an_unrecognized_wire_shape():
    # Valid JSON, but not the `{"models": [...]}` shape this expects — e.g. a
    # future/older Ollama version, or a proxy returning something else.
    body = json.dumps({"unexpected": "shape"})
    with patch("zllama_agent.facts.urllib.request.urlopen", return_value=_FakeResponse(body)):
        assert _ollama_models() is None


def test_ollama_models_returns_empty_list_when_the_api_genuinely_reports_none_installed():
    body = json.dumps({"models": []})
    with patch("zllama_agent.facts.urllib.request.urlopen", return_value=_FakeResponse(body)):
        assert _ollama_models() == []


def test_ollama_models_returns_a_populated_list_on_a_normal_response():
    with patch("zllama_agent.facts.urllib.request.urlopen", return_value=_FakeResponse(TAGS_BODY)):
        models = _ollama_models()

    assert models == [
        {"name": "qwen3:32b", "size_bytes": 20_000_000_000, "digest": "sha256:aaa"},
        {"name": "llama3.3:70b", "size_bytes": 42_000_000_000, "digest": "sha256:bbb"},
    ]


def test_ollama_models_skips_entries_without_a_usable_name():
    body = json.dumps({"models": [{"size": 1}, {"name": ""}, {"name": "ok:latest"}]})
    with patch("zllama_agent.facts.urllib.request.urlopen", return_value=_FakeResponse(body)):
        models = _ollama_models()

    assert [m["name"] for m in models] == ["ok:latest"]


def test_ollama_models_reports_a_missing_size_or_digest_as_none_not_zero():
    body = json.dumps({"models": [{"name": "tiny:latest"}]})
    with patch("zllama_agent.facts.urllib.request.urlopen", return_value=_FakeResponse(body)):
        models = _ollama_models()

    assert models == [{"name": "tiny:latest", "size_bytes": None, "digest": None}]


def _write(path: str, content: str = "x") -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(content)


def test_vllm_models_enumerates_org_slash_name_repos_from_the_cache_root(tmp_path):
    _write(str(tmp_path / "Qwen" / "Qwen3-32B-Instruct" / "config.json"), "{}")
    _write(str(tmp_path / "Qwen" / "Qwen3-32B-Instruct" / "weights.bin"), "0" * 100)
    _write(str(tmp_path / "zai-org" / "GLM-5.2" / "config.json"), "{}")

    models = _vllm_models(str(tmp_path))

    assert [m["name"] for m in models] == ["Qwen/Qwen3-32B-Instruct", "zai-org/GLM-5.2"]
    assert models[0]["size_bytes"] == 102  # 100 bytes of weights + "{}"


def test_vllm_models_handles_a_single_segment_repo_id_via_its_marker_file(tmp_path):
    _write(str(tmp_path / "gpt2" / "config.json"), "{}")

    models = _vllm_models(str(tmp_path))

    assert [m["name"] for m in models] == ["gpt2"]


def test_vllm_models_returns_none_when_the_cache_root_does_not_exist(tmp_path):
    # A missing cache root means "could not determine," not "empty" — the
    # vLLM sibling of the Ollama daemon-down case above.
    assert _vllm_models(str(tmp_path / "missing")) is None


def test_vllm_models_returns_none_when_the_cache_root_is_unreadable(tmp_path):
    # Permission bits don't reliably block a root-owned test process, so the
    # unreadable case is exercised the same way the daemon-down case above
    # is: by making the underlying syscall raise directly.
    root = tmp_path / "cache"
    root.mkdir()
    with patch("os.scandir", side_effect=PermissionError("permission denied")):
        assert _vllm_models(str(root)) is None


def test_vllm_models_returns_empty_list_when_the_cache_root_exists_and_is_empty(tmp_path):
    root = tmp_path / "cache"
    root.mkdir()
    assert _vllm_models(str(root)) == []


def test_collect_runtimes_reports_installed_ollama_models_on_the_runtime_facts():
    def run(cmd, *args, **kwargs):
        if cmd[0] == "ollama":
            return run_result(stdout="ollama version is 0.32.13\n")
        return run_result(returncode=1)

    with patch("shutil.which", side_effect=which_only("ollama")), patch(
        "subprocess.run", side_effect=run
    ), patch("shutil.disk_usage", return_value=SimpleNamespace(total=100, used=40, free=60)), patch(
        "zllama_agent.facts.urllib.request.urlopen", return_value=_FakeResponse(TAGS_BODY)
    ):
        runtimes = collect_runtimes()

    ollama = next(r for r in runtimes if r["kind"] == "ollama")
    assert [m["name"] for m in ollama["models"]] == ["qwen3:32b", "llama3.3:70b"]


def test_collect_runtimes_omits_models_key_when_the_daemon_is_down():
    # The regression this guards: the probe failing must not be
    # indistinguishable from the probe succeeding with an empty inventory.
    # The check-in route's prune only skips when the key is absent, so a
    # failed probe reporting `models: []` would wipe the host's HostModel
    # rows on a single transient hiccup.
    def run(cmd, *args, **kwargs):
        if cmd[0] == "ollama":
            return run_result(stdout="ollama version is 0.32.13\n")
        return run_result(returncode=1)

    with patch("shutil.which", side_effect=which_only("ollama")), patch(
        "subprocess.run", side_effect=run
    ), patch("shutil.disk_usage", return_value=SimpleNamespace(total=100, used=40, free=60)), patch(
        "zllama_agent.facts.urllib.request.urlopen", side_effect=OSError("refused")
    ):
        runtimes = collect_runtimes()

    ollama = next(r for r in runtimes if r["kind"] == "ollama")
    assert "models" not in ollama


def test_collect_runtimes_includes_an_empty_models_list_when_genuinely_none_installed():
    def run(cmd, *args, **kwargs):
        if cmd[0] == "ollama":
            return run_result(stdout="ollama version is 0.32.13\n")
        return run_result(returncode=1)

    with patch("shutil.which", side_effect=which_only("ollama")), patch(
        "subprocess.run", side_effect=run
    ), patch("shutil.disk_usage", return_value=SimpleNamespace(total=100, used=40, free=60)), patch(
        "zllama_agent.facts.urllib.request.urlopen",
        return_value=_FakeResponse(json.dumps({"models": []})),
    ):
        runtimes = collect_runtimes()

    ollama = next(r for r in runtimes if r["kind"] == "ollama")
    assert "models" in ollama
    assert ollama["models"] == []


# --- The loop the inventory closes -------------------------------------------


def _collect_with_tags(tags_body: str) -> dict:
    def run(cmd, *args, **kwargs):
        if cmd[0] == "ollama":
            return run_result(stdout="ollama version is 0.32.13\n")
        return run_result(returncode=1)

    with patch("shutil.which", side_effect=which_only("ollama")), patch(
        "subprocess.run", side_effect=run
    ), patch("shutil.disk_usage", return_value=SimpleNamespace(total=100, used=40, free=60)), patch(
        "zllama_agent.facts.urllib.request.urlopen", return_value=_FakeResponse(tags_body)
    ):
        return {runtime["kind"]: runtime for runtime in collect_runtimes()}


def test_an_installed_declared_model_plans_no_pull_from_real_collected_facts():
    # The regression this exists for: with no installed-model inventory on the
    # runtime facts, `plan_model_actions` sees an empty installed list and
    # re-plans `pull_model` for every declared model on every cycle, forever
    # (30s by default), re-invoking a multi-gigabyte download in a loop.
    from zllama_agent.models import plan_model_actions

    actual = _collect_with_tags(TAGS_BODY)
    desired = {
        "runtimes": {
            "ollama": {"state": "present", "models": [{"name": "qwen3:32b", "state": "present"}]}
        }
    }

    assert plan_model_actions(desired, actual) == []


# --- Configured vllm_model_paths scanning ------------------------------------
#
# `_vllm_models` combines two independent probes: the managed HF cache
# (`_scan_hf_cache`, unchanged above) and any operator-configured
# `vllm_model_paths` (`_scan_configured_vllm_path`). Each can independently
# succeed, fail, or come back empty, and the combined `None`-vs-`[]` contract
# from the module docstring must hold across every combination — a healthy
# probe is never suppressed by an unhealthy sibling.


def test_scan_configured_path_reports_one_model_when_the_path_itself_has_a_marker(tmp_path):
    from zllama_agent.facts import _vllm_models

    model_dir = tmp_path / "my-model"
    _write(str(model_dir / "config.json"), "{}")
    _write(str(model_dir / "weights.bin"), "0" * 50)

    models = _vllm_models(str(tmp_path / "empty-cache"), extra_paths=[str(model_dir)])

    assert models == [{"name": "my-model", "size_bytes": 52, "digest": None}]


def test_scan_configured_path_recognizes_a_bare_safetensors_marker(tmp_path):
    from zllama_agent.facts import _vllm_models

    model_dir = tmp_path / "raw-checkpoint"
    _write(str(model_dir / "model.safetensors"), "0" * 10)

    models = _vllm_models(str(tmp_path / "empty-cache"), extra_paths=[str(model_dir)])

    assert [m["name"] for m in models] == ["raw-checkpoint"]


def test_scan_configured_path_scans_children_when_the_path_itself_has_no_marker(tmp_path):
    from zllama_agent.facts import _vllm_models

    parent = tmp_path / "models-dir"
    _write(str(parent / "alpha" / "config.json"), "{}")
    _write(str(parent / "beta" / "model_index.json"), "{}")

    models = _vllm_models(str(tmp_path / "empty-cache"), extra_paths=[str(parent)])

    assert sorted(m["name"] for m in models) == ["alpha", "beta"]


def test_scan_configured_path_that_is_missing_is_skipped_and_logged(tmp_path, caplog):
    from zllama_agent.facts import _vllm_models

    empty_cache = tmp_path / "empty-cache"
    empty_cache.mkdir()

    with caplog.at_level("WARNING"):
        models = _vllm_models(str(empty_cache), extra_paths=[str(tmp_path / "does-not-exist")])

    assert models == []
    assert "does-not-exist" in caplog.text


def test_configured_path_models_are_deduped_against_the_hf_cache_by_name(tmp_path):
    # A configured-path model is named by its own directory's basename
    # (never the two-segment `org/name` shape the HF-cache scan uses for
    # repo ids), so a name collision across the two scans only happens for a
    # single-segment name — exactly the case this exercises.
    from zllama_agent.facts import _vllm_models

    cache_root = tmp_path / "cache"
    _write(str(cache_root / "gpt2" / "config.json"), "{}")

    configured_duplicate = tmp_path / "configured" / "gpt2"
    _write(str(configured_duplicate / "config.json"), "{}")
    configured_extra = tmp_path / "configured" / "extra-model"
    _write(str(configured_extra / "config.json"), "{}")

    models = _vllm_models(
        str(cache_root),
        extra_paths=[str(configured_duplicate), str(configured_extra)],
    )

    names = [m["name"] for m in models]
    assert names.count("gpt2") == 1
    assert "extra-model" in names


def test_vllm_models_hf_ok_and_configured_ok_reports_the_union(tmp_path):
    from zllama_agent.facts import _vllm_models

    cache_root = tmp_path / "cache"
    _write(str(cache_root / "zai-org" / "GLM-5.2" / "config.json"), "{}")
    configured = tmp_path / "configured-model"
    _write(str(configured / "config.json"), "{}")

    models = _vllm_models(str(cache_root), extra_paths=[str(configured)])

    assert sorted(m["name"] for m in models) == ["configured-model", "zai-org/GLM-5.2"]


def test_vllm_models_hf_ok_and_configured_missing_reports_hf_only(tmp_path):
    from zllama_agent.facts import _vllm_models

    cache_root = tmp_path / "cache"
    _write(str(cache_root / "zai-org" / "GLM-5.2" / "config.json"), "{}")

    models = _vllm_models(str(cache_root), extra_paths=[str(tmp_path / "missing")])

    assert [m["name"] for m in models] == ["zai-org/GLM-5.2"]


def test_vllm_models_hf_failed_and_configured_ok_reports_the_configured_models(tmp_path):
    # The partial-success case: the HF cache probe couldn't be completed, but
    # a configured path scanned cleanly and found something. That something
    # is real, so it must not be discarded just because a *different* probe
    # failed — the whole point of `None` is "this probe told us nothing", not
    # "the whole collection is untrustworthy".
    from zllama_agent.facts import _vllm_models

    configured = tmp_path / "configured-model"
    _write(str(configured / "config.json"), "{}")

    # Simulate the HF cache being unreadable by pointing the cache root at a
    # path that does not exist — the same "could not determine" trigger
    # `test_vllm_models_returns_none_when_the_cache_root_does_not_exist`
    # already exercises for `_scan_hf_cache` alone.
    models = _vllm_models(str(tmp_path / "missing-cache-root"), extra_paths=[str(configured)])

    assert models == [{"name": "configured-model", "size_bytes": 2, "digest": None}]


def test_vllm_models_hf_failed_and_configured_missing_reports_none(tmp_path):
    from zllama_agent.facts import _vllm_models

    models = _vllm_models(
        str(tmp_path / "missing-cache-root"),
        extra_paths=[str(tmp_path / "missing-configured-path")],
    )

    assert models is None


def test_an_installed_model_declared_absent_plans_a_removal_from_real_collected_facts():
    # And the mirror image: `state: "absent"` can only ever fire when the
    # inventory says the model is actually installed.
    from zllama_agent.models import plan_model_actions

    actual = _collect_with_tags(TAGS_BODY)
    desired = {
        "runtimes": {
            "ollama": {"state": "present", "models": [{"name": "qwen3:32b", "state": "absent"}]}
        }
    }

    actions = plan_model_actions(desired, actual)
    assert [a.kind for a in actions] == ["remove_model"]
    assert actions[0].model_name == "qwen3:32b"


# --- Fix 1: `$HOME` under a root systemd service (no login shell, no HOME) --
#
# `ollama --version` panics under a root systemd service — `envconfig.Models()`
# reads `$HOME` directly and root services get none — which made every host
# report `version: null` even though detection and the HTTP model inventory
# both worked fine. Both runtime-CLI subprocess calls must be handed an `env`
# with `HOME` defaulted, never the bare (possibly HOME-less) process
# environment.


def test_ollama_version_probe_is_given_a_defaulted_home_when_the_environment_lacks_one(
    monkeypatch,
):
    monkeypatch.delenv("HOME", raising=False)
    captured = {}

    def run(cmd, *args, **kwargs):
        if cmd[0] == "ollama":
            captured["env"] = kwargs.get("env")
            return run_result(stdout="ollama version is 0.32.13\n")
        return run_result(returncode=1)

    with patch("shutil.which", side_effect=which_only("ollama")), patch(
        "subprocess.run", side_effect=run
    ), patch(
        "shutil.disk_usage", return_value=SimpleNamespace(total=100, used=40, free=60)
    ), patch("zllama_agent.facts._ollama_models", return_value=[]):
        collect_runtimes()

    assert captured["env"] is not None
    assert captured["env"].get("HOME")


def test_vllm_version_probe_is_given_a_defaulted_home_when_the_environment_lacks_one(
    monkeypatch,
):
    monkeypatch.delenv("HOME", raising=False)
    captured = {}

    def run(cmd, *args, **kwargs):
        if cmd[0] == "python3":
            captured["env"] = kwargs.get("env")
            return run_result(stdout="0.5.0\n")
        return run_result(returncode=1)

    with patch("shutil.which", return_value=None), patch("subprocess.run", side_effect=run), patch(
        "shutil.disk_usage", return_value=SimpleNamespace(total=100, used=40, free=60)
    ), patch("zllama_agent.facts._vllm_models", return_value=[]):
        collect_runtimes()

    assert captured["env"] is not None
    assert captured["env"].get("HOME")


# --- Fix 2: `model_path` expansion and the systemd-install fallback --------
#
# `~/.ollama/models` was reported to the wire literally, unexpanded, so
# `shutil.disk_usage` on it always failed and `disk_total_bytes`/
# `disk_free_bytes` came back null on every host. `_resolve_ollama_model_path`
# expands the path and, when the expanded default doesn't exist on disk,
# falls back to the systemd-install default before giving up.


def test_ollama_model_path_is_expanded_not_left_as_a_literal_tilde(monkeypatch):
    monkeypatch.delenv("OLLAMA_MODELS", raising=False)
    monkeypatch.setenv("HOME", "/home/fakeuser")

    with patch("os.path.isdir", return_value=False):
        path = _resolve_ollama_model_path()

    assert path == "/home/fakeuser/.ollama/models"


def test_ollama_model_path_falls_back_to_the_systemd_install_default_when_the_primary_is_missing(
    monkeypatch,
):
    monkeypatch.delenv("OLLAMA_MODELS", raising=False)
    monkeypatch.setenv("HOME", "/home/fakeuser")

    def isdir(path):
        return path == "/usr/share/ollama/.ollama/models"

    with patch("os.path.isdir", side_effect=isdir):
        path = _resolve_ollama_model_path()

    assert path == "/usr/share/ollama/.ollama/models"


def test_ollama_model_path_stays_the_expanded_primary_when_no_candidate_exists(monkeypatch):
    monkeypatch.delenv("OLLAMA_MODELS", raising=False)
    monkeypatch.setenv("HOME", "/home/fakeuser")

    with patch("os.path.isdir", return_value=False):
        path = _resolve_ollama_model_path()

    assert path == "/home/fakeuser/.ollama/models"


def test_collect_runtimes_reports_none_disk_fields_never_zero_when_no_model_path_candidate_exists(
    tmp_path, monkeypatch
):
    # Zero is not unknown: a host where neither the expanded default nor the
    # systemd-install fallback exists must report `None`, never `0`.
    # HOME points at a directory that does not exist so the result doesn't
    # depend on whether the machine running the tests has ~/.ollama/models.
    monkeypatch.setenv("HOME", str(tmp_path / "no-such-home"))
    monkeypatch.delenv("OLLAMA_MODELS", raising=False)

    def run(cmd, *args, **kwargs):
        if cmd[0] == "ollama":
            return run_result(stdout="ollama version is 0.32.13\n")
        return run_result(returncode=1)

    with patch("shutil.which", side_effect=which_only("ollama")), patch(
        "subprocess.run", side_effect=run
    ), patch("os.path.isdir", return_value=False), patch(
        "zllama_agent.facts._ollama_models", return_value=[]
    ):
        runtimes = collect_runtimes()

    ollama = next(r for r in runtimes if r["kind"] == "ollama")
    assert ollama["disk_total_bytes"] is None
    assert ollama["disk_free_bytes"] is None
    assert ollama["model_path"] != "~/.ollama/models"


# --- Fix 3: configured `vllm_model_paths` must never be dead on a host with
# no host-installed vLLM package ----------------------------------------------
#
# Typical setup: vLLM runs in a container, with its weights bind-mounted onto
# the host and named in `agent.yaml`'s `vllm_model_paths` — but the `vllm`
# Python package was never installed on the host itself, so
# `collect_runtimes()` returned no vllm entry at all and the configured scan
# never ran. A non-empty `vllm_model_paths` must always produce an
# `install_method: "external"` entry in that case; the "no paths, not
# installed -> absent" rule still holds otherwise.


def test_collect_runtimes_omits_vllm_when_not_installed_and_no_paths_configured():
    with patch("shutil.which", return_value=None), patch(
        "subprocess.run", return_value=run_result(returncode=1)
    ):
        runtimes = collect_runtimes()

    assert all(r["kind"] != "vllm" for r in runtimes)


def test_collect_runtimes_reports_external_vllm_entry_when_paths_configured_but_not_installed(
    tmp_path,
):
    model_dir = tmp_path / "model"
    _write(str(model_dir / "config.json"), "{}")

    with patch("shutil.which", return_value=None), patch(
        "subprocess.run", return_value=run_result(returncode=1)
    ):
        runtimes = collect_runtimes(vllm_model_paths=[str(model_dir)])

    vllm = next(r for r in runtimes if r["kind"] == "vllm")
    assert vllm["install_method"] == "external"
    assert vllm["version"] is None
    assert vllm["service_state"] is None
    assert vllm["model_path"] == str(model_dir)
    assert vllm["disk_total_bytes"] is not None
    assert [m["name"] for m in vllm["models"]] == ["model"]


def test_collect_runtimes_reports_an_external_vllm_entry_even_when_python3_itself_is_missing(
    tmp_path,
):
    # The vLLM version probe shells out to `python3`; if that binary itself
    # is absent (`OSError`), the configured-path scan must still run rather
    # than the whole probe silently disappearing.
    model_dir = tmp_path / "model"
    _write(str(model_dir / "config.json"), "{}")

    def run(cmd, *args, **kwargs):
        raise OSError("no such file or directory: python3")

    with patch("shutil.which", return_value=None), patch("subprocess.run", side_effect=run):
        runtimes = collect_runtimes(vllm_model_paths=[str(model_dir)])

    vllm = next(r for r in runtimes if r["kind"] == "vllm")
    assert vllm["install_method"] == "external"
    assert [m["name"] for m in vllm["models"]] == ["model"]


# --- Fix 4: `OLLAMA_MODELS` set in the `ollama` systemd unit, not in the
# agent's own environment ------------------------------------------------------
#
# Typical setup: Ollama runs as a systemd service with
# `Environment="OLLAMA_MODELS=/srv/ollama"` in the unit file. That
# variable only reaches the process systemd starts — it is invisible to
# `os.environ` in this agent, a separate process — so
# `_resolve_ollama_model_path` fell through to the `~/.ollama/models`
# default (which didn't exist) and reported the wrong `model_path` and
# `disk_free_bytes` for the box. `_ollama_unit_model_path` reads the unit's
# own environment via `systemctl show ollama -p Environment --value` and
# `_resolve_ollama_model_path` now consults it between the agent's own
# `OLLAMA_MODELS` and the `~` expansion/fallback chain.


def test_ollama_unit_model_path_parses_the_value_out_of_other_vars():
    unit_env = "LANG=C.UTF-8 OLLAMA_MODELS=/srv/ollama PATH=/usr/bin:/bin\n"

    with patch("shutil.which", side_effect=which_only("systemctl")), patch(
        "subprocess.run", return_value=run_result(stdout=unit_env)
    ):
        assert _ollama_unit_model_path() == "/srv/ollama"


def test_ollama_unit_model_path_returns_none_when_systemctl_is_missing():
    with patch("shutil.which", return_value=None), patch(
        "subprocess.run"
    ) as mock_run:
        assert _ollama_unit_model_path() is None

    mock_run.assert_not_called()


def test_ollama_unit_model_path_returns_none_when_the_command_errors():
    with patch("shutil.which", side_effect=which_only("systemctl")), patch(
        "subprocess.run", return_value=run_result(returncode=1)
    ):
        assert _ollama_unit_model_path() is None


def test_ollama_unit_model_path_returns_none_on_timeout():
    with patch("shutil.which", side_effect=which_only("systemctl")), patch(
        "subprocess.run",
        side_effect=subprocess.TimeoutExpired(cmd="systemctl", timeout=5),
    ):
        assert _ollama_unit_model_path() is None


def test_ollama_unit_model_path_returns_none_when_variable_is_absent():
    with patch("shutil.which", side_effect=which_only("systemctl")), patch(
        "subprocess.run", return_value=run_result(stdout="LANG=C.UTF-8 PATH=/usr/bin\n")
    ):
        assert _ollama_unit_model_path() is None


def test_ollama_model_path_uses_the_systemd_unit_environment_when_agent_env_is_unset(
    monkeypatch,
):
    monkeypatch.delenv("OLLAMA_MODELS", raising=False)
    monkeypatch.setenv("HOME", "/home/fakeuser")

    def isdir(path):
        return path == "/srv/ollama"

    with patch("shutil.which", side_effect=which_only("systemctl")), patch(
        "subprocess.run", return_value=run_result(stdout="OLLAMA_MODELS=/srv/ollama")
    ), patch("os.path.isdir", side_effect=isdir):
        path = _resolve_ollama_model_path()

    assert path == "/srv/ollama"


def test_ollama_model_path_agent_env_var_still_beats_the_systemd_unit(monkeypatch):
    monkeypatch.setenv("OLLAMA_MODELS", "/opt/agent-configured")
    monkeypatch.setenv("HOME", "/home/fakeuser")

    with patch("shutil.which", side_effect=which_only("systemctl")), patch(
        "subprocess.run", return_value=run_result(stdout="OLLAMA_MODELS=/srv/ollama")
    ) as mock_run, patch("os.path.isdir", return_value=True):
        path = _resolve_ollama_model_path()

    assert path == "/opt/agent-configured"
    # Short-circuited by `or` — the agent's own env var wins before the
    # unit's environment is even consulted.
    mock_run.assert_not_called()


def test_ollama_model_path_falls_through_the_existing_chain_when_systemctl_is_missing(
    monkeypatch,
):
    monkeypatch.delenv("OLLAMA_MODELS", raising=False)
    monkeypatch.setenv("HOME", "/home/fakeuser")

    with patch("shutil.which", return_value=None), patch(
        "subprocess.run"
    ) as mock_run, patch("os.path.isdir", return_value=False):
        path = _resolve_ollama_model_path()

    mock_run.assert_not_called()
    assert path == "/home/fakeuser/.ollama/models"


def test_ollama_model_path_falls_through_the_existing_chain_when_unit_has_no_ollama_models(
    monkeypatch,
):
    monkeypatch.delenv("OLLAMA_MODELS", raising=False)
    monkeypatch.setenv("HOME", "/home/fakeuser")

    with patch("shutil.which", side_effect=which_only("systemctl")), patch(
        "subprocess.run", return_value=run_result(stdout="LANG=C.UTF-8 PATH=/usr/bin")
    ), patch("os.path.isdir", return_value=False):
        path = _resolve_ollama_model_path()

    assert path == "/home/fakeuser/.ollama/models"


def test_collect_runtimes_reports_disk_usage_from_the_systemd_unit_path(monkeypatch):
    monkeypatch.delenv("OLLAMA_MODELS", raising=False)
    monkeypatch.setenv("HOME", "/home/fakeuser")

    def run(cmd, *args, **kwargs):
        if cmd[0] == "ollama":
            return run_result(stdout="ollama version is 0.32.13\n")
        if cmd[0] == "systemctl":
            return run_result(stdout="OLLAMA_MODELS=/srv/ollama")
        return run_result(returncode=1)

    with patch(
        "shutil.which", side_effect=which_only("ollama", "systemctl")
    ), patch("subprocess.run", side_effect=run), patch(
        "os.path.isdir", return_value=True
    ), patch(
        "shutil.disk_usage",
        return_value=SimpleNamespace(total=100, used=40, free=60),
    ) as mock_disk_usage, patch(
        "zllama_agent.facts._ollama_models", return_value=[]
    ):
        runtimes = collect_runtimes()

    mock_disk_usage.assert_called_once_with("/srv/ollama")
    ollama = next(r for r in runtimes if r["kind"] == "ollama")
    assert ollama["model_path"] == "/srv/ollama"
    assert ollama["disk_total_bytes"] == 100
    assert ollama["disk_free_bytes"] == 60
