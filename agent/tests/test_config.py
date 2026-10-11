"""Tests for agent config loading."""

import textwrap

import pytest

from zllama_agent.config import AgentConfig, load_config  # noqa: F401


def write(tmp_path, body):
    p = tmp_path / "agent.yaml"
    p.write_text(textwrap.dedent(body))
    return str(p)


def test_loads_all_fields(tmp_path):
    path = write(tmp_path, """
        server: https://zllama.example
        node_name: node-a
        token: test-token
        interval: 30s
        converge: true
        log_level: debug
    """)
    cfg = load_config(path)
    assert cfg.server == "https://zllama.example"
    assert cfg.node_name == "node-a"
    assert cfg.token == "test-token"
    assert cfg.interval_seconds == 30
    assert cfg.converge is True
    assert cfg.log_level == "debug"


def test_converge_defaults_to_false(tmp_path):
    path = write(tmp_path, """
        server: https://zllama.example
        token: test-token
    """)
    assert load_config(path).converge is False


def test_node_name_defaults_to_hostname(tmp_path, monkeypatch):
    monkeypatch.setattr("socket.gethostname", lambda: "derived-host")
    path = write(tmp_path, """
        server: https://zllama.example
        token: test-token
    """)
    assert load_config(path).node_name == "derived-host"


def test_node_name_default_is_shortened_to_the_first_label(tmp_path, monkeypatch):
    # Some hosts report a bare hostname, others an FQDN — the derived default
    # is normalized to the short form so the same class of machine doesn't
    # show up under two different name shapes in the fleet list.
    monkeypatch.setattr("socket.gethostname", lambda: "gpu-node-4.inference.example.internal")
    path = write(tmp_path, """
        server: https://zllama.example
        token: test-token
    """)
    assert load_config(path).node_name == "gpu-node-4"


def test_node_name_default_is_unchanged_when_already_short(tmp_path, monkeypatch):
    monkeypatch.setattr("socket.gethostname", lambda: "gpu-node-1")
    path = write(tmp_path, """
        server: https://zllama.example
        token: test-token
    """)
    assert load_config(path).node_name == "gpu-node-1"


def test_explicit_node_name_with_dots_is_preserved_verbatim(tmp_path, monkeypatch):
    # Only the *derived* default is normalized. An operator-supplied
    # node_name is used exactly as written, dots and all.
    monkeypatch.setattr("socket.gethostname", lambda: "should-not-be-used")
    path = write(tmp_path, """
        server: https://zllama.example
        node_name: my.custom.name
        token: test-token
    """)
    assert load_config(path).node_name == "my.custom.name"


@pytest.mark.parametrize(
    "value,expected", [("30s", 30), ("2m", 120), ("45", 45), ("1h", 3600)]
)
def test_parses_interval_units(tmp_path, value, expected):
    path = write(tmp_path, f"""
        server: https://zllama.example
        token: test-token
        interval: {value}
    """)
    assert load_config(path).interval_seconds == expected


def test_rejects_missing_server(tmp_path):
    path = write(tmp_path, "token: test-token\n")
    with pytest.raises(ValueError, match="server"):
        load_config(path)


def test_rejects_missing_token(tmp_path):
    path = write(tmp_path, "server: https://zllama.example\n")
    with pytest.raises(ValueError, match="token"):
        load_config(path)


def test_rejects_unknown_key(tmp_path):
    path = write(tmp_path, """
        server: https://zllama.example
        token: test-token
        mystery_option: yes
    """)
    with pytest.raises(ValueError, match="mystery_option"):
        load_config(path)


def test_missing_file_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        load_config(str(tmp_path / "nope.yaml"))


# --- vllm_model_paths ---------------------------------------------------


def test_vllm_model_paths_defaults_to_empty_list(tmp_path):
    path = write(tmp_path, """
        server: https://zllama.example
        token: test-token
    """)
    assert load_config(path).vllm_model_paths == []


def test_vllm_model_paths_accepts_a_list_of_strings(tmp_path):
    path = write(tmp_path, """
        server: https://zllama.example
        token: test-token
        vllm_model_paths:
          - /srv/models
          - /mnt/vllm-cache
    """)
    assert load_config(path).vllm_model_paths == ["/srv/models", "/mnt/vllm-cache"]


def test_vllm_model_paths_rejects_a_non_list_value(tmp_path):
    path = write(tmp_path, """
        server: https://zllama.example
        token: test-token
        vllm_model_paths: /srv/models
    """)
    with pytest.raises(ValueError, match="vllm_model_paths"):
        load_config(path)


def test_vllm_model_paths_still_errors_on_an_unrelated_unknown_key(tmp_path):
    # A sibling unknown key must still be rejected even when
    # vllm_model_paths itself is valid — the new key must not have loosened
    # the unknown-key check.
    path = write(tmp_path, """
        server: https://zllama.example
        token: test-token
        vllm_model_paths:
          - /srv/models
        mystery_option: yes
    """)
    with pytest.raises(ValueError, match="mystery_option"):
        load_config(path)
